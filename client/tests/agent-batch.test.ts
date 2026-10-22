import { describe, expect, it } from 'vitest';
import { ROOT_ID, newId } from '@worktree/core';
import type { Operation } from '@worktree/core';
import { WorktreeClient } from '../src/client';

const localClient = (): WorktreeClient =>
  new WorktreeClient({ serverUrl: 'http://localhost:1', user: 'local', local: true });

const serverClient = (): WorktreeClient =>
  new WorktreeClient({ serverUrl: 'http://localhost:1', user: 'alice', token: 'test-token' });

const addNodeOp = (name: string, weight = 1): Operation => ({
  kind: 'add',
  parentId: ROOT_ID,
  id: newId(),
  name,
  weight,
});

describe('WorktreeClient.planningState', () => {
  it('returns a clone that does not affect the live state', () => {
    const client = localClient();
    client.addNode(ROOT_ID, 'A');
    const clone = client.planningState();
    clone.apply(addNodeOp('B'));
    expect(client.getTree().children.map((n) => n.name)).toEqual(['A']);
    expect(clone.tree.getRoot().children.map((n) => n.name)).toEqual(['A', 'B']);
  });

  it('reflects pending edits too', () => {
    const client = serverClient();
    client.addNode(ROOT_ID, 'pending');
    const clone = client.planningState();
    expect(clone.tree.getRoot().children.map((n) => n.name)).toEqual(['pending']);
  });
});

describe('WorktreeClient.applyMany', () => {
  it('is a no-op for an empty batch', () => {
    const client = serverClient();
    client.applyMany([]);
    expect(client.getPendingCount()).toBe(0);
  });

  it('queues every op as one pending entry, preserving order', () => {
    const client = serverClient();
    const first = addNodeOp('A');
    const second = addNodeOp('B');
    client.applyMany([first, second]);
    expect(client.getPendingCount()).toBe(2);
    expect(client.getTree().children.map((n) => n.name)).toEqual(['A', 'B']);
    const pending = client.getPending();
    const ops = pending.map((p) => (p.kind === 'add' ? p.op : p));
    expect(ops.map((op) => op.kind)).toEqual(['add', 'add']);
    expect(ops.map((op) => (op.kind === 'add' ? op.id : ''))).toEqual([first.kind === 'add' ? first.id : '', second.kind === 'add' ? second.id : '']);
  });

  it('appends straight into the confirmed chain for the local user', () => {
    const client = localClient();
    client.applyMany([addNodeOp('A'), addNodeOp('B')]);
    expect(client.getConfirmed()).toHaveLength(2);
    expect(client.getPendingCount()).toBe(0);
    expect(client.getTree().children.map((n) => n.name)).toEqual(['A', 'B']);
  });

  it('validates the whole batch before applying anything', () => {
    const client = serverClient();
    const good = addNodeOp('A');
    const bad: Operation = { kind: 'complete', id: 'missing-node' };
    expect(() => client.applyMany([good, bad])).toThrow(/unknown node id/);
    expect(client.getPendingCount()).toBe(0);
    expect(client.getTree().children).toEqual([]);
  });

  it('stamps one timestamp for the whole batch', () => {
    const client = localClient();
    client.applyMany([addNodeOp('A'), addNodeOp('B')]);
    const timestamps = client.getConfirmed().map((entry) => entry.op.timestamp);
    expect(timestamps[0]).toBe(timestamps[1]);
    expect(timestamps[0]).toBeTypeOf('number');
  });
});
