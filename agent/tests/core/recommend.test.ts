import { describe, expect, it } from 'vitest';
import { ROOT_ID, WorktreeState } from '@worktree/core';
import { suggestTasks } from '../../src/recommend';
import { NOW, TZ, addNode, timestampAt } from './fixtures';

function fixtureState(): WorktreeState {
  return WorktreeState.fromOps([
    addNode(ROOT_ID, 'tmp', 'tmp'),
    addNode('tmp', 'overdue', 'Overdue report', { deadline: timestampAt('2026-10-20', '18:00') }),
    addNode('tmp', 'tomorrow', 'Tomorrow task', { deadline: timestampAt('2026-10-24', '09:00') }),
    addNode('tmp', 'later', 'Later task', { deadline: timestampAt('2026-11-20', '09:00') }),
    addNode('tmp', 'someday', 'Someday task'),
    addNode('tmp', 'aaa', 'aaa no deadline'),
    addNode('tmp', 'done', 'Done task', { deadline: timestampAt('2026-10-21', '09:00') }),
    addNode('tmp', 'group', 'Group'),
    addNode('group', 'group-child', 'Group child'),
    { kind: 'complete', id: 'done' },
  ]);
}

function ids(state: WorktreeState, overrides: Partial<Parameters<typeof suggestTasks>[0]> = {}): string[] {
  return suggestTasks({ state, now: NOW, tzOffset: TZ, limit: 10, ...overrides }).map(
    (suggestion) => suggestion.taskId,
  );
}

describe('suggestTasks', () => {
  it('ranks overdue, then deadline proximity, then tasks without a deadline', () => {
    const state = fixtureState();
    expect(ids(state)).toEqual(['overdue', 'tomorrow', 'later', 'group-child', 'someday', 'aaa']);
  });

  it('explains every rank deterministically', () => {
    const state = fixtureState();
    const first = suggestTasks({ state, now: NOW, tzOffset: TZ });
    const second = suggestTasks({ state, now: NOW, tzOffset: TZ });
    expect(first).toEqual(second);
    expect(first[0]?.reason).toBe('overdue since 2026-10-20 18:00');
    expect(first[1]?.reason).toBe('due tomorrow 09:00');
    expect(first[2]?.reason).toBe('due 2026-11-20 09:00');
    expect(first[3]?.reason).toBe('no deadline');
    expect(first[0]?.path).toBe('/tmp/Overdue report');
    expect(first[0]?.score).toBeGreaterThan(first[1]?.score ?? 0);
    expect(first[1]?.score).toBeGreaterThan(first[2]?.score ?? 0);
    expect(first[2]?.score).toBeGreaterThan(first[3]?.score ?? 0);
  });

  it('only suggests open leaves', () => {
    const state = fixtureState();
    const suggested = ids(state);
    expect(suggested).not.toContain(ROOT_ID);
    expect(suggested).not.toContain('group');
    expect(suggested).not.toContain('done');
    expect(suggested).not.toContain('tmp');
  });

  it('restricts to tasks relevant on a civil date', () => {
    const state = fixtureState();
    expect(ids(state, { date: '2026-10-23' })).toEqual(['overdue', 'group-child', 'someday', 'aaa']);
  });

  it('ignores available_minutes for now, deterministically', () => {
    const state = fixtureState();
    expect(ids(state, { availableMinutes: 30 })).toEqual(ids(state));
  });

  it('respects the limit and validates its arguments', () => {
    const state = fixtureState();
    expect(ids(state, { limit: 2 })).toEqual(['overdue', 'tomorrow']);
    expect(() => suggestTasks({ state, now: NOW, tzOffset: TZ, limit: 0 })).toThrow(/positive integer/);
    expect(() => suggestTasks({ state, now: NOW, tzOffset: TZ, availableMinutes: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => suggestTasks({ state, now: NOW, tzOffset: TZ, date: 'tomorrow' })).toThrow(/invalid date/);
  });

  it('returns nothing for an empty tree', () => {
    expect(suggestTasks({ state: new WorktreeState(), now: NOW, tzOffset: TZ })).toEqual([]);
  });
});
