import { describe, expect, it } from 'vitest';
import { ROOT_ID, Tree } from '@worktree/core';
import type { Node, TreeOperation } from '@worktree/core';
import {
  civilDayStart,
  dueToday,
  isDueByToday,
  relativeTime,
  uncompletedDescendants,
} from '../src/today';

/** Local time so the civil-day comparisons never depend on the test machine's zone. */
const NOW = new Date(2026, 9, 23, 14, 0, 0).getTime();
const TODAY = (hour: number, minute = 0): number => new Date(2026, 9, 23, hour, minute).getTime();
const YESTERDAY = (hour: number): number => new Date(2026, 9, 22, hour).getTime();
const TOMORROW = (hour: number): number => new Date(2026, 9, 24, hour).getTime();

function makeTree(ops: TreeOperation[]): Node {
  return Tree.fromOps(ops).getRoot();
}

/** A node at ROOT_ID with a deadline, so the tests read as one row each. */
function dueOp(id: string, name: string, deadline: number, weight: number): TreeOperation {
  return { kind: 'add', parentId: ROOT_ID, id, name, weight, deadline };
}

describe('civilDayStart', () => {
  it('returns local midnight of the civil day containing the timestamp', () => {
    expect(civilDayStart(TODAY(14, 30))).toBe(TODAY(0));
    expect(civilDayStart(TODAY(0))).toBe(TODAY(0));
    expect(civilDayStart(YESTERDAY(23))).toBe(YESTERDAY(0));
  });
});

describe('isDueByToday', () => {
  it('accepts today at any hour and earlier days', () => {
    expect(isDueByToday(TODAY(23, 59), NOW)).toBe(true);
    expect(isDueByToday(TODAY(0, 0), NOW)).toBe(true);
    expect(isDueByToday(YESTERDAY(23), NOW)).toBe(true);
  });

  it('rejects deadlines from tomorrow on', () => {
    expect(isDueByToday(TOMORROW(0), NOW)).toBe(false);
  });
});

describe('relativeTime', () => {
  it('marks future deadlines as due and past ones as overdue', () => {
    expect(relativeTime(NOW + 30 * 60_000, NOW)).toEqual({ kind: 'due', unit: 'minutes', amount: 30 });
    expect(relativeTime(NOW - 30 * 60_000, NOW)).toEqual({ kind: 'overdue', unit: 'minutes', amount: 30 });
  });

  it('steps up to hours at one hour', () => {
    expect(relativeTime(NOW + 59 * 60_000, NOW)).toEqual({ kind: 'due', unit: 'minutes', amount: 59 });
    expect(relativeTime(NOW + 60 * 60_000, NOW)).toEqual({ kind: 'due', unit: 'hours', amount: 1 });
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toEqual({ kind: 'overdue', unit: 'hours', amount: 2 });
  });

  it('steps up to days at one day', () => {
    expect(relativeTime(NOW + 23 * 3_600_000, NOW)).toEqual({ kind: 'due', unit: 'hours', amount: 23 });
    expect(relativeTime(NOW + 24 * 3_600_000, NOW)).toEqual({ kind: 'due', unit: 'days', amount: 1 });
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toEqual({ kind: 'overdue', unit: 'days', amount: 3 });
  });

  it('never reports a zero amount for a deadline that just passed', () => {
    expect(relativeTime(NOW - 500, NOW)).toEqual({ kind: 'overdue', unit: 'minutes', amount: 1 });
    expect(relativeTime(NOW + 500, NOW)).toEqual({ kind: 'due', unit: 'minutes', amount: 1 });
  });
});

describe('dueToday', () => {
  const tree = makeTree([
    dueOp('late', 'late', TODAY(18), 1),
    dueOp('early', 'early', TODAY(9), 2),
    dueOp('yesterday', 'yesterday', YESTERDAY(10), 3),
    dueOp('done', 'done', TODAY(10), 4),
    { kind: 'add', parentId: ROOT_ID, id: 'tomorrow', name: 'tomorrow', weight: 5, deadline: TOMORROW(9) },
    { kind: 'add', parentId: ROOT_ID, id: 'plain', name: 'plain', weight: 6 },
    { kind: 'add', parentId: 'early', id: 'child', name: 'child', weight: 1, deadline: YESTERDAY(11) },
    { kind: 'complete', id: 'done' },
  ]);

  it('lists open nodes due today or earlier, earliest deadline first', () => {
    const entries = dueToday(tree, NOW);
    expect(entries.map((entry) => entry.node.id)).toEqual(['yesterday', 'child', 'early', 'late']);
    expect(entries[0].relative).toEqual({ kind: 'overdue', unit: 'days', amount: 1 });
    expect(entries[1].relative).toEqual({ kind: 'overdue', unit: 'days', amount: 1 });
    expect(entries[2].relative).toEqual({ kind: 'overdue', unit: 'hours', amount: 5 });
    expect(entries[3].relative).toEqual({ kind: 'due', unit: 'hours', amount: 4 });
  });

  it('excludes completed nodes, deadlines after today, and nodes without a deadline', () => {
    const ids = dueToday(tree, NOW).map((entry) => entry.node.id);
    expect(ids).not.toContain('done');
    expect(ids).not.toContain('tomorrow');
    expect(ids).not.toContain('plain');
    expect(ids).not.toContain(ROOT_ID);
  });

  it('is empty when nothing is due', () => {
    expect(dueToday(makeTree([]), NOW)).toEqual([]);
  });

  it('keeps a stable order for equal deadlines', () => {
    const tied = makeTree([
      dueOp('b-node', 'beta', TODAY(12), 1),
      dueOp('a-node', 'alpha', TODAY(12), 2),
    ]);
    // Same deadline sorts by name, so the list never reshuffles between renders.
    expect(dueToday(tied, NOW).map((entry) => entry.node.name)).toEqual(['alpha', 'beta']);
  });
});

describe('uncompletedDescendants', () => {
  it('returns open descendants in children-first order', () => {
    const tree = makeTree([
      { kind: 'add', parentId: ROOT_ID, id: 'parent', name: 'parent', weight: 1 },
      { kind: 'add', parentId: 'parent', id: 'open-a', name: 'open-a', weight: 1 },
      { kind: 'add', parentId: 'parent', id: 'done-b', name: 'done-b', weight: 2 },
      { kind: 'complete', id: 'done-b' },
    ]);
    const parent = tree.children[0];
    expect(uncompletedDescendants(parent)).toEqual(['open-a']);
  });

  it('visits grandchildren before their parent', () => {
    const tree = makeTree([
      { kind: 'add', parentId: ROOT_ID, id: 'p', name: 'p', weight: 1 },
      { kind: 'add', parentId: 'p', id: 'm', name: 'm', weight: 1 },
      { kind: 'add', parentId: 'm', id: 'n', name: 'n', weight: 1 },
    ]);
    expect(uncompletedDescendants(tree.children[0])).toEqual(['n', 'm']);
  });

  it('returns nothing for a fully completed subtree', () => {
    const tree = makeTree([
      { kind: 'add', parentId: ROOT_ID, id: 'p', name: 'p', weight: 1 },
      { kind: 'add', parentId: 'p', id: 'c', name: 'c', weight: 1 },
      { kind: 'complete', id: 'c' },
      { kind: 'complete', id: 'p' },
    ]);
    expect(uncompletedDescendants(tree.children[0])).toEqual([]);
  });
});
