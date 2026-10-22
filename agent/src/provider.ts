import { z } from 'zod';
import type {
  FetchLike,
  LlmRequest,
  LlmResponse,
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
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: request.messages,
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
      if (request.tools !== undefined && request.tools.length > 0) {
        body.tools = request.tools.map(toWireTool);
        body.tool_choice = 'auto';
      }
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError(providerErrorMessage(text, response.status), response.status);
      }
      return parseCompletion(text, response.status);
    },
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
