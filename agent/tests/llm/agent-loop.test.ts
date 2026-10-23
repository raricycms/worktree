import { describe, expect, it } from 'vitest';
import { runAgentTurn } from '../../src/agent';
import { createTools } from '../../src/tools';
import type {
  AgentEvent,
  AgentTurnOptions,
  AskUserRequest,
  LlmStreamHandlers,
  LlmTransport,
  Tool,
} from '../../src/types';
import {
  addNodeTool,
  failingTransport,
  handledTransport,
  llmResponse,
  readTool,
  scriptedTransport,
  testContext,
  throwingTool,
  toolOf,
} from './fakes';

function turnOptions(
  overrides: Partial<AgentTurnOptions> & Pick<AgentTurnOptions, 'transport' | 'userText'>,
): AgentTurnOptions {
  return {
    systemPrompt: 'SYSTEM',
    history: [],
    context: testContext(),
    ...overrides,
  };
}

/** The real ask_user tool, so its validation and error text are exercised. */
function askUserTool(): Tool {
  const tool = createTools().find((candidate) => candidate.definition.name === 'ask_user');
  if (tool === undefined) throw new Error('ask_user is missing from the tool set');
  return tool;
}

describe('runAgentTurn', () => {
  it('runs one tool, feeds the result back and returns the final answer', async () => {
    const context = testContext();
    const tool = addNodeTool('create_event');
    const { transport, requests } = scriptedTransport([
      llmResponse({
        reasoning: 'need an event',
        toolCalls: [{ id: 'c1', name: 'create_event', arguments: '{"title":"meeting"}' }],
      }),
      llmResponse({ content: 'Done.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'schedule a meeting', context, tools: [tool] }),
    );

    expect(result.text).toBe('Done.');
    expect(result.stoppedByLimit).toBe(false);
    expect(result.steps).toEqual([
      { tool: 'create_event', args: { title: 'meeting' }, summary: 'created', ok: true },
    ]);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].kind).toBe('add');
    // The tool already applied its op to the dry-run state; the loop must not apply it again.
    expect(context.state.tree.getRoot().children).toHaveLength(1);

    expect(requests).toHaveLength(2);
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'schedule a meeting' },
    ]);
    expect(requests[0].tools).toEqual([tool.definition]);

    expect(requests[1].messages).toHaveLength(4);
    expect(requests[1].messages[2]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'need an event',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'create_event', arguments: '{"title":"meeting"}' } },
      ],
    });
    expect(requests[1].messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ ok: true, summary: 'created' }),
    });
  });

  it('executes several tool calls from one assistant message in order', async () => {
    const context = testContext();
    const tools: Tool[] = [addNodeTool('create_event'), readTool('get_agenda', '09:00 standup')];
    const { transport, requests } = scriptedTransport([
      llmResponse({
        content: 'Let me check.',
        toolCalls: [
          { id: 'c1', name: 'create_event', arguments: '' },
          { id: 'c2', name: 'get_agenda', arguments: '{}' },
        ],
      }),
      llmResponse({ content: 'All set.' }),
    ]);

    const result = await runAgentTurn(turnOptions({ transport, userText: 'go', context, tools }));

    expect(result.steps.map((step) => step.tool)).toEqual(['create_event', 'get_agenda']);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true]);
    expect(result.ops).toHaveLength(1);
    expect(requests[0].tools).toEqual(tools.map((tool) => tool.definition));
    // Assistant text is preserved when the model both talks and calls tools.
    expect(requests[1].messages[2].content).toBe('Let me check.');
    const toolMessages = requests[1].messages.slice(3);
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['c1', 'c2']);
    expect(toolMessages[1].content).toBe(JSON.stringify({ ok: true, summary: '09:00 standup' }));
  });

  it('feeds malformed tool arguments back as an error result', async () => {
    const context = testContext();
    const { transport, requests } = scriptedTransport([
      llmResponse({ toolCalls: [{ id: 'c1', name: 'create_event', arguments: '{not json' }] }),
      llmResponse({ content: 'Sorry, I could not do that.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'go', context, tools: [addNodeTool('create_event')] }),
    );

    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].args).toEqual({});
    expect(result.ops).toEqual([]);
    expect(result.text).toBe('Sorry, I could not do that.');

    const toolMessage = requests[1].messages[3];
    if (typeof toolMessage.content !== 'string') throw new Error('expected a string tool result');
    const content: { ok: boolean; error?: string; summary?: string } = JSON.parse(toolMessage.content);
    expect(content.ok).toBe(false);
    expect(content.error).toBe(result.steps[0].summary);
    expect(content.error).toBeTruthy();
  });

  it('turns an unknown tool into an error result', async () => {
    const context = testContext();
    const { transport } = scriptedTransport([
      llmResponse({ toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: '{}' }] }),
      llmResponse({ content: 'That tool does not exist.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'go', context, tools: [addNodeTool('create_event')] }),
    );

    expect(result.steps[0].tool).toBe('no_such_tool');
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toContain('unknown tool: no_such_tool');
    expect(result.text).toBe('That tool does not exist.');
  });

  it('turns a tool exception into an error result', async () => {
    const context = testContext();
    const { transport } = scriptedTransport([
      llmResponse({ toolCalls: [{ id: 'c1', name: 'create_event', arguments: '{"title":"x"}' }] }),
      llmResponse({ content: 'The date is missing.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'go', context, tools: [throwingTool('create_event', 'missing date')] }),
    );

    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toBe('missing date');
    expect(result.ops).toEqual([]);
    expect(result.text).toBe('The date is missing.');
  });

  it('stops at the step budget and asks for one final tool-free answer', async () => {
    const context = testContext();
    const { transport, requests } = handledTransport((_request, index) => {
      if (index < 2) {
        return llmResponse({ toolCalls: [{ id: `c${index + 1}`, name: 'get_agenda', arguments: '{}' }] });
      }
      return llmResponse({ content: 'Brief answer.' });
    });

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'go', context, tools: [readTool('get_agenda', 'nothing')], maxSteps: 2 }),
    );

    expect(result.stoppedByLimit).toBe(true);
    expect(result.text).toBe('Brief answer.');
    expect(result.steps).toHaveLength(2);
    expect(result.ops).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(requests[2].tools).toBeUndefined();
    const lastMessage = requests[2].messages[requests[2].messages.length - 1];
    expect(lastMessage.content).toContain('Tool step limit reached');
  });

  it('propagates abort errors unchanged', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const { transport } = failingTransport(abortError);
    await expect(
      runAgentTurn(turnOptions({ transport, userText: 'go', tools: [addNodeTool('create_event')] })),
    ).rejects.toBe(abortError);
  });

  it('sends prior history between the system prompt and the new turn', async () => {
    const { transport, requests } = scriptedTransport([llmResponse({ content: 'ok' })]);
    await runAgentTurn(
      turnOptions({
        transport,
        userText: 'and then?',
        tools: [readTool('get_agenda', 'none')],
        history: [
          { role: 'user', text: 'earlier question' },
          { role: 'assistant', text: 'earlier answer' },
        ],
      }),
    );

    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'and then?' },
    ]);
  });

  it('rejects a non-positive step budget', async () => {
    const { transport } = scriptedTransport([]);
    await expect(
      runAgentTurn(
        turnOptions({ transport, userText: 'go', maxSteps: 0, tools: [readTool('get_agenda', 'none')] }),
      ),
    ).rejects.toThrowError(/maxSteps/);
  });
});

describe('runAgentTurn streaming', () => {
  it('prefers the streaming transport and forwards deltas to onEvent', async () => {
    const events: AgentEvent[] = [];
    const { transport } = streamingTransport(llmResponse({ content: 'Hello world', reasoning: 'think' }));
    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'hi', tools: [], onEvent: (event) => events.push(event) }),
    );

    expect(result.text).toBe('Hello world');
    expect(events).toEqual([
      { type: 'reasoning', delta: 'think' },
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
    ]);
  });

  it('falls back to complete when the transport has no stream', async () => {
    const { transport, requests } = scriptedTransport([llmResponse({ content: 'plain' })]);
    const result = await runAgentTurn(turnOptions({ transport, userText: 'hi', tools: [] }));
    expect(result.text).toBe('plain');
    expect(requests).toHaveLength(1);
  });
});

describe('runAgentTurn ask_user', () => {
  it('pauses for the human, records the answer and returns it to the model', async () => {
    const requests: AskUserRequest[] = [];
    const askTool = askUserTool();
    const { transport, requests: llmRequests } = scriptedTransport([
      llmResponse({
        toolCalls: [
          {
            id: 'c1',
            name: 'ask_user',
            arguments: JSON.stringify({ question: 'When?', options: ['Now', 'Later'] }),
          },
        ],
      }),
      llmResponse({ content: 'Scheduled for now.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({
        transport,
        userText: 'schedule it',
        tools: [askTool],
        onAskUser: async (request) => {
          requests.push(request);
          return 'Now';
        },
      }),
    );

    expect(requests).toEqual([{ question: 'When?', options: ['Now', 'Later'] }]);
    expect(result.asks).toEqual([{ question: 'When?', options: ['Now', 'Later'], answer: 'Now' }]);
    expect(result.steps[0]).toEqual({
      tool: 'ask_user',
      args: { question: 'When?', options: ['Now', 'Later'] },
      summary: 'User answered: Now',
      ok: true,
    });
    const toolMessage = llmRequests[1].messages[3];
    expect(JSON.parse(String(toolMessage.content))).toEqual({ ok: true, summary: 'User answered: Now' });
    expect(result.text).toBe('Scheduled for now.');
  });

  it('turns a missing ask callback into a clear tool error', async () => {
    const { transport, requests } = scriptedTransport([
      llmResponse({
        toolCalls: [{ id: 'c1', name: 'ask_user', arguments: JSON.stringify({ question: 'When?' }) }],
      }),
      llmResponse({ content: 'I need a time from you.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'schedule it', tools: [askUserTool()] }),
    );

    expect(result.asks).toEqual([]);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toMatch(/ask_user is unavailable/);
    expect(result.text).toBe('I need a time from you.');
    const toolMessage = requests[1].messages[3];
    if (typeof toolMessage.content !== 'string') throw new Error('expected a string tool result');
    const content: { ok: boolean; error?: string } = JSON.parse(toolMessage.content);
    expect(content.ok).toBe(false);
    expect(content.error).toContain('ask_user is unavailable');
  });

  it('propagates an abort raised while waiting for the human', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const { transport } = scriptedTransport([
      llmResponse({
        toolCalls: [{ id: 'c1', name: 'ask_user', arguments: JSON.stringify({ question: 'When?', options: ['A', 'B'] }) }],
      }),
    ]);

    await expect(
      runAgentTurn(
        turnOptions({
          transport,
          userText: 'schedule it',
          tools: [askUserTool()],
          onAskUser: async () => {
            throw abortError;
          },
        }),
      ),
    ).rejects.toBe(abortError);
  });
});

describe('runAgentTurn tool details', () => {
  it('collects artifacts from every tool in execution order without applying them', async () => {
    const artifactTool = toolOf('import_timetable', () => ({
      summary: 'prepared',
      artifacts: [
        {
          kind: 'timetable' as const,
          rows: [
            {
              id: 'row-1',
              course: 'Math',
              weekday: 1,
              start: '08:00',
              end: '09:40',
              weeks: '1-16',
            },
          ],
          warnings: ['check the teacher'],
        },
      ],
    }));
    const context = testContext();
    const { transport } = scriptedTransport([
      llmResponse({
        toolCalls: [
          { id: 'c1', name: 'import_timetable', arguments: '{}' },
          { id: 'c2', name: 'import_timetable', arguments: '{}' },
        ],
      }),
      llmResponse({ content: 'Preview ready.' }),
    ]);

    const result = await runAgentTurn(
      turnOptions({ transport, userText: 'import', context, tools: [artifactTool] }),
    );

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0].rows[0].course).toBe('Math');
    expect(result.artifacts[1].warnings).toEqual(['check the teacher']);
    // The artifact is a preview: the tool must not have written anything.
    expect(result.ops).toEqual([]);
    expect(context.state.tree.nodeCount()).toBe(0);
  });

  it('awaits async tools and reports their result', async () => {
    const asyncTool = toolOf('create_event', async () => {
      await Promise.resolve();
      return { summary: 'async done' };
    });
    const { transport } = scriptedTransport([
      llmResponse({ toolCalls: [{ id: 'c1', name: 'create_event', arguments: '{}' }] }),
      llmResponse({ content: 'Done.' }),
    ]);

    const result = await runAgentTurn(turnOptions({ transport, userText: 'go', tools: [asyncTool] }));
    expect(result.steps).toEqual([{ tool: 'create_event', args: {}, summary: 'async done', ok: true }]);
    expect(result.text).toBe('Done.');
  });

  it('sends attached images as user content parts', async () => {
    const { transport, requests } = scriptedTransport([llmResponse({ content: 'ok' })]);
    await runAgentTurn(
      turnOptions({
        transport,
        userText: 'what is this?',
        tools: [],
        images: [{ id: 'img-1', dataUrl: 'data:image/png;base64,AAAA' }],
      }),
    );

    expect(requests[0].messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });
});

function streamingTransport(response: ReturnType<typeof llmResponse>): { transport: LlmTransport } {
  const transport: LlmTransport = {
    async complete() {
      throw new Error('the streaming path must be preferred');
    },
    async stream(_request, handlers: LlmStreamHandlers) {
      handlers.onReasoningDelta?.('think');
      handlers.onTextDelta?.('Hello');
      handlers.onTextDelta?.(' world');
      return response;
    },
  };
  return { transport };
}
