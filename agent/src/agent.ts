import type { Operation } from '@worktree/core';
import { createTools } from './tools';
import { buildHistoryMessages, buildUserMessage } from './prompt';
import type {
  AgentArtifact,
  AgentAsk,
  AgentEvent,
  AgentStep,
  AgentTurnOptions,
  AgentTurnResult,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  LlmWireMessage,
  Tool,
  ToolContext,
} from './types';

const DEFAULT_MAX_STEPS = 8;

const STEP_LIMIT_INSTRUCTION =
  'Tool step limit reached. Do not call any more tools; answer the user now in one or two short sentences.';

/**
 * Runs one conversational turn: call the model, execute tool calls against the
 * dry-run context, feed results back, repeat until the model answers or the
 * step budget runs out. Planned ops and preview artifacts are returned, never
 * applied; `onEvent` streams progress and `onAskUser` suspends for the human.
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
    buildUserMessage(opts.userText, opts.images),
  ];
  const definitions = tools.map((tool) => tool.definition);
  const ops: Operation[] = [];
  const steps: AgentStep[] = [];
  const artifacts: AgentArtifact[] = [];
  const asks: AgentAsk[] = [];

  const context = withAskUser(opts, asks);

  for (let step = 0; step < maxSteps; step++) {
    const response = await requestCompletion(opts, messages, definitions);
    if (response.toolCalls.length === 0) {
      return { text: response.content, ops, steps, artifacts, asks, stoppedByLimit: false };
    }
    messages.push(assistantWireMessage(response));
    for (const call of response.toolCalls) {
      const content = await runToolCall(call, byName, context, opts, ops, steps, artifacts);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  // The budget is exhausted while the model still wants tools: one final
  // tool-free request forces a text answer the UI can show.
  messages.push({ role: 'user', content: STEP_LIMIT_INSTRUCTION });
  const final = await requestCompletion(opts, messages, undefined);
  return { text: final.content, ops, steps, artifacts, asks, stoppedByLimit: true };
}

/** The context the tools see, with ask_user wired to the caller's callback. */
function withAskUser(opts: AgentTurnOptions, asks: AgentAsk[]): ToolContext {
  const ask = opts.onAskUser;
  if (ask === undefined) return opts.context;
  return {
    ...opts.context,
    askUser: async (request) => {
      const answer = await ask(request);
      asks.push({ question: request.question, options: request.options, answer });
      return answer;
    },
  };
}

/** Uses the streaming path when the transport provides one. */
async function requestCompletion(
  opts: AgentTurnOptions,
  messages: LlmWireMessage[],
  tools: LlmRequest['tools'],
): Promise<LlmResponse> {
  const request: LlmRequest = {
    messages: [...messages],
    ...(tools === undefined ? {} : { tools }),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const stream = opts.transport.stream;
  if (stream === undefined) return opts.transport.complete(request);
  const emit = opts.onEvent;
  return stream.call(opts.transport, request, {
    onTextDelta: (delta) => emitEvent(emit, { type: 'text', delta }),
    onReasoningDelta: (delta) => emitEvent(emit, { type: 'reasoning', delta }),
  });
}

function emitEvent(emit: ((event: AgentEvent) => void) | undefined, event: AgentEvent): void {
  if (emit !== undefined) emit(event);
}

async function runToolCall(
  call: LlmToolCall,
  byName: Map<string, Tool>,
  context: ToolContext,
  opts: AgentTurnOptions,
  ops: Operation[],
  steps: AgentStep[],
  artifacts: AgentArtifact[],
): Promise<string> {
  const entry: AgentStep = { tool: call.name, args: {}, summary: '', ok: true };

  let args: unknown;
  try {
    args = parseArguments(call.arguments);
  } catch (error) {
    const message = `${call.name}: the arguments are not valid JSON (${messageOf(error)})`;
    entry.args = {};
    entry.ok = false;
    entry.summary = message;
    steps.push(entry);
    emitEvent(opts.onEvent, { type: 'tool_start', name: call.name, args: {} });
    emitEvent(opts.onEvent, { type: 'tool_end', name: call.name, ok: false, summary: message });
    return JSON.stringify({ ok: false, error: message });
  }

  entry.args = plainRecord(args);
  const tool = byName.get(call.name);
  if (tool === undefined) {
    const message = `unknown tool: ${call.name}. Use one of: ${[...byName.keys()].join(', ')}`;
    entry.ok = false;
    entry.summary = message;
    steps.push(entry);
    emitEvent(opts.onEvent, { type: 'tool_start', name: call.name, args: entry.args });
    emitEvent(opts.onEvent, { type: 'tool_end', name: call.name, ok: false, summary: message });
    return JSON.stringify({ ok: false, error: message });
  }

  emitEvent(opts.onEvent, { type: 'tool_start', name: call.name, args: entry.args });
  try {
    // Tools validate, dry-run and mutate ctx.state themselves; the loop only
    // collects the ops so the caller can apply them once.
    const result = await tool.run(args, context);
    if (result.ops !== undefined) ops.push(...result.ops);
    if (result.artifacts !== undefined) artifacts.push(...result.artifacts);
    entry.ok = true;
    entry.summary = result.summary;
    steps.push(entry);
    emitEvent(opts.onEvent, { type: 'tool_end', name: call.name, ok: true, summary: result.summary });
    return JSON.stringify({ ok: true, summary: result.summary });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = messageOf(error);
    entry.ok = false;
    entry.summary = message;
    steps.push(entry);
    emitEvent(opts.onEvent, { type: 'tool_end', name: call.name, ok: false, summary: message });
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

/** Aborts are a user action, never a tool failure the model may retry. */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
