import type { Operation } from '@worktree/core';
import { createTools } from './tools';
import { buildHistoryMessages, buildUserMessage } from './prompt';
import type {
  AgentStep,
  AgentTurnOptions,
  AgentTurnResult,
  LlmResponse,
  LlmToolCall,
  LlmWireMessage,
  Tool,
  ToolContext,
} from './types';

const DEFAULT_MAX_STEPS = 6;

const STEP_LIMIT_INSTRUCTION =
  'Tool step limit reached. Do not call any more tools; answer the user now in one or two short sentences.';

/**
 * Runs one conversational turn: call the model, execute tool calls against the
 * dry-run context, feed results back, repeat until the model answers or the
 * step budget runs out. Planned ops are returned, not applied.
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`maxSteps must be a positive integer: ${maxSteps}`);
  }
  const tools = opts.tools ?? createTools();
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  const messages: LlmWireMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...buildHistoryMessages(opts.history),
    buildUserMessage(opts.userText),
  ];
  const definitions = tools.map((tool) => tool.definition);
  const ops: Operation[] = [];
  const steps: AgentStep[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const response = await opts.transport.complete({
      messages: [...messages],
      tools: definitions,
      temperature: opts.temperature,
      signal: opts.signal,
    });
    if (response.toolCalls.length === 0) {
      return { text: response.content, ops, steps, stoppedByLimit: false };
    }
    messages.push(assistantWireMessage(response));
    for (const call of response.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: runToolCall(call, byName, opts.context, ops, steps) });
    }
  }

  // The budget is exhausted while the model still wants tools: one final
  // tool-free request forces a text answer the UI can show.
  messages.push({ role: 'user', content: STEP_LIMIT_INSTRUCTION });
  const final = await opts.transport.complete({
    messages,
    temperature: opts.temperature,
    signal: opts.signal,
  });
  return { text: final.content, ops, steps, stoppedByLimit: true };
}

function runToolCall(
  call: LlmToolCall,
  byName: Map<string, Tool>,
  context: ToolContext,
  ops: Operation[],
  steps: AgentStep[],
): string {
  const entry: AgentStep = { tool: call.name, args: {}, summary: '', ok: true };
  steps.push(entry);
  try {
    const args = parseArguments(call.arguments);
    entry.args = plainRecord(args);
    const tool = byName.get(call.name);
    if (tool === undefined) throw new Error(`unknown tool: ${call.name}`);
    // Tools validate, dry-run and mutate ctx.state themselves; the loop only
    // collects the ops so the caller can apply them once.
    const result = tool.run(args, context);
    if (result.ops !== undefined) ops.push(...result.ops);
    entry.summary = result.summary;
    return JSON.stringify({ ok: true, summary: result.summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.ok = false;
    entry.summary = message;
    return JSON.stringify({ ok: false, error: message });
  }
}

function assistantWireMessage(response: LlmResponse): LlmWireMessage {
  return {
    role: 'assistant',
    content: response.content === '' ? null : response.content,
    tool_calls: response.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
    reasoning_content: response.reasoning,
  };
}

/** OpenAI tool arguments are a JSON object encoded as a string; '' means none. */
function parseArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}
