import { ROOT_ID, WorktreeState } from '@worktree/core';
import type { Operation } from '@worktree/core';
import type { FetchLike, LlmRequest, LlmResponse, LlmTransport, Tool, ToolContext } from '../../src/types';

export interface CapturedFetchCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

export type FetchInit = Parameters<FetchLike>[1];

export function textResponse(status: number, text: string): { status: number; ok: boolean; text(): Promise<string> } {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

export function recordingFetch(
  status: number,
  body: unknown,
): { fetchImpl: FetchLike; calls: CapturedFetchCall[] } {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return textResponse(status, JSON.stringify(body));
  };
  return { fetchImpl, calls };
}

export function recordingTextFetch(
  status: number,
  text: string,
): { fetchImpl: FetchLike; calls: CapturedFetchCall[] } {
  const calls: CapturedFetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return textResponse(status, text);
  };
  return { fetchImpl, calls };
}

export function llmResponse(partial: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    ...partial,
  };
}

/** A transport replaying `replies`; it records a snapshot of every request. */
export function scriptedTransport(replies: LlmResponse[]): {
  transport: LlmTransport;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  const transport: LlmTransport = {
    async complete(request) {
      requests.push(snapshotRequest(request));
      const reply = replies[requests.length - 1];
      if (reply === undefined) throw new Error(`no scripted reply for request ${requests.length}`);
      return reply;
    },
  };
  return { transport, requests };
}

/** A transport whose reply is produced by `handler` for each request. */
export function handledTransport(
  handler: (request: LlmRequest, index: number) => LlmResponse,
): { transport: LlmTransport; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const transport: LlmTransport = {
    async complete(request) {
      const snapshot = snapshotRequest(request);
      requests.push(snapshot);
      return handler(snapshot, requests.length - 1);
    },
  };
  return { transport, requests };
}

/** A transport that always rejects; used for abort propagation. */
export function failingTransport(error: Error): { transport: LlmTransport; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const transport: LlmTransport = {
    async complete(request) {
      requests.push(snapshotRequest(request));
      throw error;
    },
  };
  return { transport, requests };
}

function snapshotRequest(request: LlmRequest): LlmRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({ ...message })),
    ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
  };
}

export function idFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

export function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    state: new WorktreeState(),
    now: 1_790_000_000_000,
    tzOffset: 8 * 60 * 60 * 1000,
    semester: null,
    newId: idFactory(),
    ...overrides,
  };
}

export function toolOf(name: string, run: Tool['run']): Tool {
  return {
    definition: { name, description: `${name} for tests`, parameters: { type: 'object', properties: {} } },
    run,
  };
}

/** A fake write tool: plans one `add` op under the root and applies it to ctx.state. */
export function addNodeTool(name: string): Tool {
  return toolOf(name, (args, ctx) => {
    const op: Operation = { kind: 'add', parentId: ROOT_ID, id: ctx.newId(), name: 'from-test', weight: 0 };
    ctx.state.apply(op);
    return { summary: 'created', ops: [op] };
  });
}

/** A fake read tool: returns a summary and no ops. */
export function readTool(name: string, summary: string): Tool {
  return toolOf(name, () => ({ summary }));
}

export function throwingTool(name: string, message: string): Tool {
  return toolOf(name, () => {
    throw new Error(message);
  });
}
