import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  chatCompletionsUrl,
  createChatTransport,
  verifyProvider,
} from '../../src/provider';
import type { LlmRequest, LlmResponse, LlmStreamHandlers, LlmTransport, ProviderConfig } from '../../src/types';
import {
  recordingFetch,
  recordingStreamFetch,
  recordingTextFetch,
  sse,
  streamChunk,
  streamResponse,
} from './fakes';

const config: ProviderConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-flash',
};

function transportWith(fetchImpl: Parameters<typeof createChatTransport>[1]): LlmTransport {
  return createChatTransport({ ...config, baseUrl: 'https://api.deepseek.com/v1' }, fetchImpl);
}

async function streamWith(
  transport: LlmTransport,
  request: LlmRequest,
  handlers: LlmStreamHandlers = {},
): Promise<LlmResponse> {
  const stream = transport.stream;
  if (stream === undefined) throw new Error('expected the transport to implement stream');
  return stream.call(transport, request, handlers);
}

function streamTransportWith(fetchImpl: Parameters<typeof createChatTransport>[1]): LlmTransport {
  const transport = transportWith(fetchImpl);
  if (transport.stream === undefined) throw new Error('expected the transport to implement stream');
  return transport;
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

describe('createChatTransport stream', () => {
  it('parses SSE text deltas split across chunk boundaries', async () => {
    const fake = recordingStreamFetch([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
    const deltas: string[] = [];
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] }, {
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(reply).toEqual({
      content: 'Hello world',
      reasoning: '',
      toolCalls: [],
      finishReason: 'stop',
    });
    expect(deltas).toEqual(['Hello', ' world']);

    const body: Record<string, unknown> = JSON.parse(fake.calls[0].init.body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('deepseek-flash');
    expect(fake.calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('accumulates reasoning_content deltas and reports them', async () => {
    const fake = recordingStreamFetch(
      sse([
        streamChunk({ reasoning_content: 'think ' }),
        streamChunk({ reasoning_content: 'harder' }),
        streamChunk({ content: 'answer' }, 'stop'),
        '[DONE]',
      ]),
    );
    const reasoning: string[] = [];
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] }, {
      onReasoningDelta: (delta) => reasoning.push(delta),
    });

    expect(reply.reasoning).toBe('think harder');
    expect(reply.content).toBe('answer');
    expect(reasoning).toEqual(['think ', 'harder']);
  });

  it('assembles tool calls fragmented by index (id, name and arguments)', async () => {
    const fake = recordingStreamFetch(
      sse([
        streamChunk({
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'create_event', arguments: '{"title":"' } },
          ],
        }),
        // Some providers omit `index` after the first fragment of a call.
        streamChunk({ tool_calls: [{ id: '', function: { name: '', arguments: 'meeting"}' } }] }),
        streamChunk({
          tool_calls: [{ index: 1, id: 'call_2', function: { name: 'get_agenda', arguments: '{}' } }],
        }),
        streamChunk({}, 'tool_calls'),
        '[DONE]',
      ]),
    );
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'create_event', description: 'create', parameters: { type: 'object' } }],
    });

    expect(reply.toolCalls).toEqual([
      { id: 'call_1', name: 'create_event', arguments: '{"title":"meeting"}' },
      { id: 'call_2', name: 'get_agenda', arguments: '{}' },
    ]);
    expect(reply.finishReason).toBe('tool_calls');
    const body: Record<string, unknown> = JSON.parse(fake.calls[0].init.body);
    expect(body.tool_choice).toBe('auto');
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it('ignores comments, blank lines and non-data fields', async () => {
    const fake = recordingStreamFetch([
      ': keep-alive\n\n',
      'event: message\n',
      'id: 42\n',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe('ok');
  });

  it('stops at [DONE] and ignores any following payload', async () => {
    const fake = recordingStreamFetch([
      'data: {"choices":[{"delta":{"content":"fine"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
      'data: this-is-not-json\n\n',
    ]);
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe('fine');
  });

  it('parses the whole body as text when the response exposes no stream', async () => {
    const response = {
      ...streamResponse(
        sse([streamChunk({ content: 'from text' }, 'stop'), '[DONE]']),
      ),
      body: null,
    };
    const reply = await streamWith(
      streamTransportWith(async () => response),
      { messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(reply.content).toBe('from text');
    expect(reply.finishReason).toBe('stop');
  });

  it('falls back to the JSON body for a non-SSE response', async () => {
    const fake = recordingStreamFetch(
      [JSON.stringify({ choices: [{ message: { content: 'json reply' }, finish_reason: 'stop' }] })],
      { contentType: 'application/json' },
    );
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe('json reply');
  });

  it('captures usage from a final chunk', async () => {
    const fake = recordingStreamFetch([
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const reply = await streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.usage).toEqual({ promptTokens: 3, completionTokens: 1 });
  });

  it('raises ProviderError for an HTTP error with an error envelope', async () => {
    const fake = recordingStreamFetch([JSON.stringify({ error: { message: 'Rate limit reached' } })], {
      status: 429,
      contentType: 'text/event-stream',
    });
    const error = await streamWith(streamTransportWith(fake.fetchImpl), {
      messages: [{ role: 'user', content: 'hi' }],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) {
      expect(error.status).toBe(429);
      expect(error.message).toBe('Rate limit reached');
    }
  });

  it('raises ProviderError for an error payload inside the stream', async () => {
    const fake = recordingStreamFetch(sse([{ error: { message: 'stream exploded' } }]));
    await expect(
      streamWith(streamTransportWith(fake.fetchImpl), { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrowError(/stream exploded/);
  });

  it('raises ProviderError on malformed stream data', async () => {
    const fake = recordingStreamFetch(['data: {not json}\n\n']);
    const error = await streamWith(streamTransportWith(fake.fetchImpl), {
      messages: [{ role: 'user', content: 'hi' }],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    if (error instanceof ProviderError) expect(error.message).toMatch(/malformed stream data/);
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
      streamWith(transport, { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toBe(abortError);
    expect(seen[0]).toBe(controller.signal);
  });
});
