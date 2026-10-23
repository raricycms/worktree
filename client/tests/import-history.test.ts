import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT_ID } from '@worktree/core';
import type { HistoryNode, Operation } from '@worktree/core';
import { WorktreeClient } from '../src/client';

const add = (id: string, parentId = ROOT_ID): Operation => ({
  kind: 'add',
  parentId,
  id,
  name: id,
  weight: 1,
});

const history = (): HistoryNode[] => [
  { id: 'h1', op: add('a') },
  { id: 'h2', op: add('b', 'a') },
];

const localClient = (): WorktreeClient =>
  new WorktreeClient({ serverUrl: 'http://localhost:1', user: 'local', local: true });

const serverClient = (): WorktreeClient =>
  new WorktreeClient({ serverUrl: 'http://localhost:1', user: 'alice', token: 'test-token' });

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Stub the REST transport; returns the captured requests plus a counter. */
function stubFetch(calls: CapturedCall[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorktreeClient.importHistory (local user)', () => {
  it('replaces the empty confirmed history and renders the imported tree', async () => {
    const c = localClient();
    await c.importHistory(history());
    expect(c.getConfirmed()).toEqual(history());
    expect(c.getPending()).toEqual([]);
    expect(c.getTree().children.map((n) => n.id)).toEqual(['a']);
    expect(c.getTree().children[0]?.children.map((n) => n.id)).toEqual(['b']);
    expect(c.getReplayFailure()).toBeNull();
  });

  it('never talks to the server', async () => {
    const calls: CapturedCall[] = [];
    stubFetch(calls);
    const c = localClient();
    await c.importHistory(history());
    expect(calls).toEqual([]);
  });

  it('rejects a duplicate entry id without touching the workspace', async () => {
    const c = localClient();
    const duplicated: HistoryNode[] = [
      { id: 'h1', op: add('a') },
      { id: 'h1', op: add('b') },
    ];
    await expect(c.importHistory(duplicated)).rejects.toThrow(/duplicate history entry id: h1/);
    expect(c.getConfirmed()).toEqual([]);
  });

  it('rejects a history that does not replay', async () => {
    const c = localClient();
    const broken: HistoryNode[] = [
      { id: 'h1', op: add('a') },
      { id: 'h2', op: add('b', 'missing') },
    ];
    await expect(c.importHistory(broken)).rejects.toThrow(/unknown node id: missing/);
    expect(c.getConfirmed()).toEqual([]);
  });

  it('rejects an import when the workspace already has confirmed entries', async () => {
    const c = localClient();
    await c.importHistory(history());
    await expect(c.importHistory(history())).rejects.toThrow(/empty workspace/);
    // The first import is untouched.
    expect(c.getConfirmed()).toEqual(history());
  });
});

describe('WorktreeClient.importHistory (server user)', () => {
  it('rewrites with a null base and adopts the entries after the server accepts', async () => {
    const calls: CapturedCall[] = [];
    stubFetch(calls);
    const c = serverClient();
    await c.importHistory(history());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:1/api/rewrite');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ base: null, history: history() });
    expect(c.getConfirmed()).toEqual(history());
    expect(c.getPending()).toEqual([]);
    expect(c.getTree().children.map((n) => n.id)).toEqual(['a']);
  });

  it('rejects an import when local ops are pending, before calling the server', async () => {
    const calls: CapturedCall[] = [];
    stubFetch(calls);
    const c = serverClient();
    c.addNode(ROOT_ID, 'x');
    expect(c.getPendingCount()).toBe(1);
    await expect(c.importHistory(history())).rejects.toThrow(/empty workspace/);
    expect(calls).toEqual([]);
    expect(c.getConfirmed()).toEqual([]);
  });

  it('propagates a server rejection (history not empty) without adopting the entries', async () => {
    const rejection = new Response(JSON.stringify({ error: 'base mismatch', head: 'other' }), { status: 409 });
    vi.stubGlobal('fetch', vi.fn(async () => rejection));
    const c = serverClient();
    await expect(c.importHistory(history())).rejects.toThrow(/base mismatch/);
    expect(c.getConfirmed()).toEqual([]);
  });
});
