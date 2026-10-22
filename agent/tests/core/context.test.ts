import { describe, expect, it } from 'vitest';
import { ROOT_ID, WorktreeState } from '@worktree/core';
import { buildContextSnapshot } from '../../src/context';
import type { Semester } from '../../src/types';
import { NOW, TZ, addBlock, addNode, timestampAt } from './fixtures';

const semester: Semester = { firstMonday: { year: 2026, month: 9, day: 7 }, totalWeeks: 16 };

function fixtureState(): WorktreeState {
  return WorktreeState.fromOps([
    addNode(ROOT_ID, 'tmp', 'tmp'),
    addNode('tmp', 'overdue', 'Overdue report', { deadline: timestampAt('2026-10-20', '18:00') }),
    addNode('tmp', 'today', 'Today report', { deadline: timestampAt('2026-10-23', '20:00') }),
    addNode('tmp', 'future', 'Future report', { deadline: timestampAt('2026-10-27', '09:00') }),
    addNode('tmp', 'someday', 'Someday task'),
    addNode(ROOT_ID, 'projects', 'Projects'),
    addNode('projects', 'projects-child', 'Projects child'),
    { kind: 'complete', id: 'projects-child' },
    addBlock('blk', 'Standup', timestampAt('2026-10-23', '09:00'), timestampAt('2026-10-23', '10:00')),
  ]);
}

function snapshot(state: WorktreeState, overrides: { maxTasks?: number; semester?: Semester | null } = {}): string {
  return buildContextSnapshot({ state, now: NOW, tzOffset: TZ, semester, ...overrides });
}

describe('buildContextSnapshot', () => {
  it('renders local time, semester week, agenda, free slots and pending counts', () => {
    const text = snapshot(fixtureState());
    expect(text).toContain('Local time: 2026-10-23 08:00 Friday (UTC+08:00)');
    expect(text).toContain('Semester: teaching week 7 of 16');
    expect(text).toContain('Pending: 6 open tasks (1 overdue, 1 due today, 1 due within 7 days)');
    expect(text).toContain('Today (2026-10-23):');
    expect(text).toContain('- 09:00-10:00 Standup [block blk]');
    expect(text).toContain('Free today: 08:00-09:00 (60 min), 10:00-23:00 (780 min)');
  });

  it('lists overdue, due-today and due-soon tasks with ids and paths', () => {
    const text = snapshot(fixtureState());
    expect(text).toContain('Overdue:');
    expect(text).toContain('- [overdue] Overdue report — due 2026-10-20 18:00 — /tmp/Overdue report');
    expect(text).toContain('Due today:');
    expect(text).toContain('- [today] Today report — due 2026-10-23 20:00 — /tmp/Today report');
    expect(text).toContain('Due within 7 days:');
    expect(text).toContain('- [future] Future report — due 2026-10-27 09:00 — /tmp/Future report');
  });

  it('never dumps the tree: unfinished containers are counted, not listed by name', () => {
    const text = snapshot(fixtureState());
    expect(text).not.toContain('Projects');
    expect(text).not.toContain('someday');
  });

  it('is deterministic for the same state and clock', () => {
    const state = fixtureState();
    expect(snapshot(state)).toBe(snapshot(state));
  });

  it('caps the listed tasks at maxTasks and reports the remainder', () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'one', 'One', { deadline: timestampAt('2026-10-20', '09:00') }),
      addNode('tmp', 'two', 'Two', { deadline: timestampAt('2026-10-19', '09:00') }),
      addNode('tmp', 'three', 'Three', { deadline: timestampAt('2026-10-18', '09:00') }),
    ]);
    const text = snapshot(state, { maxTasks: 2 });
    expect(text).toContain('[two] Two');
    expect(text).toContain('[three] Three');
    expect(text).not.toContain('[one] One');
    expect(text).toContain('... 1 more');
    expect(() => snapshot(state, { maxTasks: 0 })).toThrow(/positive integer/);
  });

  it('describes the semester relation before, during and after the term', () => {
    const state = new WorktreeState();
    const before = buildContextSnapshot({
      state,
      now: timestampAt('2026-09-01', '08:00'),
      tzOffset: TZ,
      semester,
    });
    expect(before).toContain('Semester: starts 2026-09-07 (today is before week 1)');

    const after = buildContextSnapshot({
      state,
      now: timestampAt('2027-01-01', '08:00'),
      tzOffset: TZ,
      semester,
    });
    expect(after).toContain('Semester: ended 2026-12-27 (today is after week 16)');

    expect(snapshot(state, { semester: null })).toContain('Semester: none configured');
  });

  it('handles an empty tree', () => {
    const text = snapshot(new WorktreeState());
    expect(text).toContain('Pending: 0 open tasks');
    expect(text).toContain('Today (2026-10-23): nothing scheduled');
    expect(text).toContain('Free today: 08:00-23:00 (900 min)');
  });
});
