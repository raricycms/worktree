import { describe, expect, it } from 'vitest';
import { runAgentTurn } from '../../src/agent';
import type { AgentTurnOptions, Tool } from '../../src/types';
import {
  addNodeTool,
  failingTransport,
  handledTransport,
  llmResponse,
  readTool,
  scriptedTransport,
  testContext,
  throwingTool,
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

    expect(result.steps[0]).toEqual({
      tool: 'no_such_tool',
      args: {},
      summary: 'unknown tool: no_such_tool',
      ok: false,
    });
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
