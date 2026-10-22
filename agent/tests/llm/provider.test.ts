import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  chatCompletionsUrl,
  createChatTransport,
  verifyProvider,
} from '../../src/provider';
import type { LlmTransport, ProviderConfig } from '../../src/types';
import { recordingFetch, recordingTextFetch } from './fakes';

const config: ProviderConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-flash',
};

function transportWith(fetchImpl: Parameters<typeof createChatTransport>[1]): LlmTransport {
  return createChatTransport({ ...config, baseUrl: 'https://api.deepseek.com/v1' }, fetchImpl);
}

describe('chatCompletionsUrl', () => {
  const cases: [string, string][] = [
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/chat/completions'],
    ['  https://api.deepseek.com  ', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/chat/completions'],
    ['https://api.deepseek.com/v1/chat/completions/', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://proxy.example.com/openai/v1', 'https://proxy.example.com/openai/v1/chat/completions'],
    ['http://localhost:8080/v1', 'http://localhost:8080/v1/chat/completions'],
  ];

  it.each(cases)('normalises %s', (input, expected) => {
    expect(chatCompletionsUrl(input)).toBe(expected);
  });

  it('rejects an empty base URL', () => {
    expect(() => chatCompletionsUrl('   ')).toThrowError(ProviderError);
    expect(() => chatCompletionsUrl('   ')).toThrowError(/empty/);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => chatCompletionsUrl('api.deepseek.com')).toThrowError(/invalid API base URL/);
  });

  it('rejects a non-HTTP protocol', () => {
    expect(() => chatCompletionsUrl('ftp://api.deepseek.com')).toThrowError(/protocol/);
  });
});

describe('createChatTransport', () => {
  it('posts an OpenAI-compatible request and maps tools', async () => {
    const fake = recordingFetch(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hello',
            reasoning_content: 'why',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'create_event', arguments: '{"x":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const transport = transportWith(fake.fetchImpl);
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'create_event', description: 'create one', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 128,
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer sk-test');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.signal).toBeUndefined();

    const body: Record<string, unknown> = JSON.parse(call.init.body);
    expect(body.model).toBe('deepseek-flash');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(128);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'create_event', description: 'create one', parameters: { type: 'object' } } },
    ]);

    expect(reply).toEqual({
      content: 'hello',
      reasoning: 'why',
      toolCalls: [{ id: 'call_1', name: 'create_event', arguments: '{"x":1}' }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  it('omits tools and tool_choice when no tools are given', async () => {
    const fake = recordingFetch(200, { choices: [{ message: { content: 'plain' } }] });
    const transport = transportWith(fake.fetchImpl);
    const reply = await transport.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const body: Record<string, unknown> = JSON.parse(fake.calls[0].init.body);
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect('temperature' in body).toBe(false);
    expect(reply.content).toBe('plain');
    expect(reply.reasoning).toBe('');
    expect(reply.toolCalls).toEqual([]);
    expect(reply.finishReason).toBe('');
    expect(reply.usage).toBeUndefined();
  });

  it('accepts null content on a tool-call message', async () => {
    const fake = recordingFetch(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'call_2', function: { name: 'get_agenda', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const reply = await transportWith(fake.fetchImpl).complete({
      messages: [{ role: 'user', content: 'agenda?' }],
      tools: [{ name: 'get_agenda', description: 'read', parameters: { type: 'object' } }],
    });

    expect(reply.content).toBe('');
    expect(reply.toolCalls).toEqual([{ id: 'call_2', name: 'get_agenda', arguments: '{}' }]);
  });

  it('surfaces a 401 with the provider message', async () => {
    const fake = recordingTextFetch(401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
    const error = await transportWith(fake.fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) {
      expect(error.status).toBe(401);
      expect(error.message).toBe('Authentication Fails');
    }
  });

  it('surfaces a 429 rate limit', async () => {
    const fake = recordingTextFetch(429, JSON.stringify({ error: { message: 'Rate limit reached' } }));
    const error = await transportWith(fake.fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) {
      expect(error.status).toBe(429);
      expect(error.message).toBe('Rate limit reached');
    }
  });

  it('reports a non-JSON reply clearly', async () => {
    const fake = recordingTextFetch(200, '<html>gateway error</html>');
    const error = await transportWith(fake.fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) {
      expect(error.status).toBe(200);
      expect(error.message).toMatch(/non-JSON/);
    }
  });

  it('reports an unexpected response shape', async () => {
    const fake = recordingFetch(200, { nope: true });
    const error = await transportWith(fake.fetchImpl)
      .complete({ messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) expect(error.message).toMatch(/unexpected response/);
  });

  it('passes the abort signal through and propagates the abort', async () => {
    const controller = new AbortController();
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const seen: (AbortSignal | undefined)[] = [];
    const transport = transportWith(async (_url, init) => {
      seen.push(init.signal);
      throw abortError;
    });

    await expect(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toBe(abortError);
    expect(seen[0]).toBe(controller.signal);
  });
});

describe('verifyProvider', () => {
  it('makes one tiny call and resolves the configured model', async () => {
    const fake = recordingFetch(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const result = await verifyProvider(config, fake.fetchImpl);

    expect(result).toEqual({ model: 'deepseek-flash' });
    const body: Record<string, unknown> = JSON.parse(fake.calls[0].init.body);
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'Reply with the single word: ok' }]);
  });

  it('accepts an empty content reply (reasoning models can spend the budget on reasoning)', async () => {
    const fake = recordingFetch(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    await expect(verifyProvider(config, fake.fetchImpl)).resolves.toEqual({ model: 'deepseek-flash' });
  });

  it('propagates a provider error', async () => {
    const fake = recordingTextFetch(401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
    const error = await verifyProvider(config, fake.fetchImpl).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) expect(error.status).toBe(401);
  });
});
