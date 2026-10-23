import { z } from 'zod';
import type {
  FetchLike,
  LlmRequest,
  LlmResponse,
  LlmStreamHandlers,
  LlmToolCall,
  LlmTransport,
  ProviderConfig,
  ToolDefinition,
} from './types';

/** A failed model call, carrying the HTTP status and the provider's message. */
export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';
const SSE_CONTENT_TYPE = 'text/event-stream';
const DONE_MARKER = '[DONE]';

/**
 * Normalises a configured base URL to the chat-completions endpoint.
 * Accepts `https://api.deepseek.com`, `https://api.deepseek.com/v1` and a
 * full `.../chat/completions` URL; the result is deterministic, so the same
 * configuration always targets the same endpoint.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') throw new ProviderError('the API base URL is empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderError(`invalid API base URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError(`unsupported API URL protocol: ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(CHAT_COMPLETIONS_SUFFIX) ? path : `${path}${CHAT_COMPLETIONS_SUFFIX}`;
  return url.toString();
}

const wireToolCallSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const wireMessageSchema = z.object({
  role: z.string().optional(),
  content: z.union([z.string(), z.null()]).optional(),
  reasoning_content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(wireToolCallSchema).optional(),
});

const wireChoiceSchema = z.object({
  message: wireMessageSchema,
  finish_reason: z.union([z.string(), z.null()]).optional(),
});

const wireUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
});

const wireResponseSchema = z.object({
  choices: z.array(wireChoiceSchema),
  usage: wireUsageSchema.optional(),
});

const errorEnvelopeSchema = z.object({
  error: z.object({ message: z.string() }),
});

/** One fragment of a streamed tool call: every string field may arrive in pieces. */
const streamToolCallDeltaSchema = z.object({
  index: z.number().int().optional(),
  id: z.union([z.string(), z.null()]).optional(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.union([z.string(), z.null()]).optional(),
      arguments: z.union([z.string(), z.null()]).optional(),
    })
    .optional(),
});

const streamDeltaSchema = z.object({
  content: z.union([z.string(), z.null()]).optional(),
  reasoning_content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(streamToolCallDeltaSchema).optional(),
});

const streamChoiceSchema = z.object({
  delta: streamDeltaSchema.optional(),
  finish_reason: z.union([z.string(), z.null()]).optional(),
});

const streamChunkSchema = z.object({
  choices: z.array(streamChoiceSchema).optional(),
  usage: wireUsageSchema.optional(),
});

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface StreamAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Index of the most recent tool call, for providers that omit `index` after the first fragment. */
  lastToolIndex: number;
}

/** Raw JSON body → model response, throwing `ProviderError` on any mismatch. */
function parseCompletion(text: string, status: number): LlmResponse {
  const body = parseJson(text);
  if (body === undefined) {
    throw new ProviderError(`the provider returned a non-JSON response (HTTP ${status})`, status);
  }
  const parsed = wireResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError(
      `the provider returned an unexpected response (HTTP ${status}): ${describeIssues(parsed.error)}`,
      status,
    );
  }
  const choice = parsed.data.choices[0];
  if (choice === undefined) {
    throw new ProviderError(`the provider returned no choices (HTTP ${status})`, status);
  }
  const message = choice.message;
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  }));
  const usage = parsed.data.usage;
  return {
    content: message.content ?? '',
    reasoning: message.reasoning_content ?? '',
    toolCalls,
    finishReason: choice.finish_reason ?? '',
    ...(usage === undefined
      ? {}
      : {
          usage: {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
          },
        }),
  };
}

/** Creates the OpenAI-compatible transport; `fetchImpl` is injectable for tests. */
export function createChatTransport(config: ProviderConfig, fetchImpl?: FetchLike): LlmTransport {
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const doFetch: FetchLike = fetchImpl ?? globalThis.fetch;

  function requestBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages,
    };
    if (stream) body.stream = true;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
      body.tool_choice = 'auto';
    }
    return body;
  }

  async function post(request: LlmRequest, stream: boolean): ReturnType<FetchLike> {
    return doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody(request, stream)),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const response = await post(request, false);
      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError(providerErrorMessage(text, response.status), response.status);
      }
      return parseCompletion(text, response.status);
    },

    async stream(request: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResponse> {
      const response = await post(request, true);
      if (!response.ok) {
        const text = await response.text();
        throw new ProviderError(providerErrorMessage(text, response.status), response.status);
      }
      const contentType = (response.headers?.get('content-type') ?? '').trim().toLowerCase();
      if (!contentType.startsWith(SSE_CONTENT_TYPE)) {
        return parseCompletion(await response.text(), response.status);
      }
      const accumulator = newStreamAccumulator();
      const body = response.body;
      if (body === undefined || body === null) {
        // Some fetch shims expose no stream body; the whole SSE payload is
        // still readable as text, so parse the same lines from it.
        parseSseText(await response.text(), accumulator, handlers);
      } else {
        await parseSseStream(body, accumulator, handlers);
      }
      return finishStream(accumulator, response.status);
    },
  };
}

function newStreamAccumulator(): StreamAccumulator {
  return { content: '', reasoning: '', toolCalls: new Map(), finishReason: '', lastToolIndex: 0 };
}

async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  accumulator: StreamAccumulator,
  handlers: LlmStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (handleSseLine(line, accumulator, handlers)) {
        done = true;
        break;
      }
      newline = buffer.indexOf('\n');
    }
  }
  if (!done) {
    buffer += decoder.decode();
    const trailing = buffer.replace(/\r$/, '');
    if (trailing !== '') handleSseLine(trailing, accumulator, handlers);
  }
}

function parseSseText(text: string, accumulator: StreamAccumulator, handlers: LlmStreamHandlers): void {
  for (const rawLine of text.split('\n')) {
    if (handleSseLine(rawLine.replace(/\r$/, ''), accumulator, handlers)) return;
  }
}

/** Handles one SSE line; returns true when the stream signalled `[DONE]`. */
function handleSseLine(line: string, accumulator: StreamAccumulator, handlers: LlmStreamHandlers): boolean {
  // Blank lines separate events; comment lines (`: keep-alive`) and other
  // fields (`event:`, `id:`, `retry:`) carry no payload for this API.
  if (line === '' || line.startsWith(':')) return false;
  if (!line.startsWith('data:')) return false;
  const payload = line.slice('data:'.length).trim();
  if (payload === '') return false;
  if (payload === DONE_MARKER) return true;
  applyStreamChunk(payload, accumulator, handlers);
  return false;
}

function applyStreamChunk(payload: string, accumulator: StreamAccumulator, handlers: LlmStreamHandlers): void {
  const body = parseJson(payload);
  if (body === undefined) {
    throw new ProviderError(`the provider sent malformed stream data: ${payload}`);
  }
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (envelope.success) throw new ProviderError(envelope.data.error.message);
  const parsed = streamChunkSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError(`the provider sent an unexpected stream chunk: ${describeIssues(parsed.error)}`);
  }
  const usage = parsed.data.usage;
  if (usage !== undefined) {
    accumulator.usage = {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    };
  }
  for (const choice of parsed.data.choices ?? []) {
    const delta = choice.delta;
    if (delta !== undefined) {
      if (typeof delta.content === 'string' && delta.content !== '') {
        accumulator.content += delta.content;
        handlers.onTextDelta?.(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        accumulator.reasoning += delta.reasoning_content;
        handlers.onReasoningDelta?.(delta.reasoning_content);
      }
      for (const fragment of delta.tool_calls ?? []) {
        applyToolCallFragment(fragment, accumulator);
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      accumulator.finishReason = choice.finish_reason;
    }
  }
}

function applyToolCallFragment(
  fragment: z.infer<typeof streamToolCallDeltaSchema>,
  accumulator: StreamAccumulator,
): void {
  // `index` identifies the call across chunks. Providers that omit it after
  // the first fragment still send one call at a time, so the last index holds.
  const index = fragment.index ?? accumulator.lastToolIndex;
  accumulator.lastToolIndex = index;
  let entry = accumulator.toolCalls.get(index);
  if (entry === undefined) {
    entry = { id: '', name: '', arguments: '' };
    accumulator.toolCalls.set(index, entry);
  }
  if (typeof fragment.id === 'string') entry.id += fragment.id;
  const fn = fragment.function;
  if (fn !== undefined) {
    if (typeof fn.name === 'string') entry.name += fn.name;
    if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
  }
}

function finishStream(accumulator: StreamAccumulator, status: number): LlmResponse {
  const toolCalls: LlmToolCall[] = [...accumulator.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      if (call.name === '') {
        throw new ProviderError(`the provider streamed a tool call without a name (HTTP ${status})`, status);
      }
    }
  }
  return {
    content: accumulator.content,
    reasoning: accumulator.reasoning,
    toolCalls,
    finishReason: accumulator.finishReason,
    ...(accumulator.usage === undefined ? {} : { usage: accumulator.usage }),
  };
}

/** One minimal call used by Settings' "test connection" button. */
export async function verifyProvider(
  config: ProviderConfig,
  fetchImpl?: FetchLike,
): Promise<{ model: string }> {
  const transport = createChatTransport(config, fetchImpl);
  // A valid response is the proof; the text itself is irrelevant. Reasoning
  // models can spend the whole small token budget on reasoning_content and
  // return an empty content, so requiring text would fail a healthy endpoint.
  await transport.complete({
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    temperature: 0,
    maxTokens: 64,
  });
  return { model: config.model };
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: 'function', function: tool };
}

function providerErrorMessage(text: string, status: number): string {
  const body = parseJson(text);
  if (body !== undefined) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    if (envelope.success) return envelope.data.error.message;
  }
  const trimmed = text.trim();
  return trimmed === '' ? `the provider rejected the request (HTTP ${status})` : trimmed;
}

/** `undefined` means the text is not JSON; JSON has no `undefined` value. */
function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}
