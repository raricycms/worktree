import { describe, expect, it } from 'vitest';
import { ROOT_ID, WorktreeState, daysFromCivil } from '@worktree/core';
import {
  agendaItems,
  findNodeById,
  findNodeByPath,
  freeSlots,
  nodePath,
  taskDetail,
  taskSummaries,
} from '../../src/read';
import { NOW, TZ, addBlock, addNode, addWeeklyRule, civilDate, timestampAt } from './fixtures';

const DAY = daysFromCivil(2026, 10, 23);

function fixtureState(): WorktreeState {
  return WorktreeState.fromOps([
    addNode(ROOT_ID, 'tmp', 'tmp', { weight: 1 }),
    addNode(ROOT_ID, 'events', 'events', { weight: 2 }),
    addNode('tmp', 'alpha', 'alpha', {
      weight: 1,
      note: 'urgent report',
      deadline: timestampAt('2026-10-20', '18:00'),
    }),
    addNode('tmp', 'beta', 'beta', { weight: 2, deadline: timestampAt('2026-10-23', '20:00') }),
    addNode('tmp', 'gamma', 'gamma', { weight: 3 }),
    addNode('alpha', 'alpha-child', 'alpha child'),
    addNode(ROOT_ID, 'done', 'done-task', { deadline: timestampAt('2026-10-21', '09:00') }),
    addNode('events', 'meeting', 'Meeting'),
    { kind: 'complete', id: 'done' },
    addNode('events', 'standalone', 'Standalone'),
    addBlock('blk-1', 'Meeting', timestampAt('2026-10-23', '09:00'), timestampAt('2026-10-23', '10:00'), {
      nodeId: 'meeting',
    }),
    addBlock('blk-2', 'Early', timestampAt('2026-10-23', '07:00'), timestampAt('2026-10-23', '08:30')),
    addBlock('blk-3', 'Late', timestampAt('2026-10-22', '22:00'), timestampAt('2026-10-22', '23:30')),
    addWeeklyRule('rule-1', 'Class', civilDate(2026, 10, 23), { hour: 14, minute: 0 }, 3600000, [5]),
    { kind: 'add_reminder', nodeId: 'alpha', rmdId: 'rmd-1', deadline: timestampAt('2026-10-20', '17:00') },
  ]);
}

describe('agendaItems', () => {
  it('merges blocks and rule occurrences overlapping the window, sorted by start', () => {
    const state = fixtureState();
    const items = agendaItems(state, timestampAt('2026-10-23', '00:00'), timestampAt('2026-10-24', '00:00'));
    expect(items.map((item) => [item.kind, item.name])).toEqual([
      ['block', 'Early'],
      ['block', 'Meeting'],
      ['occurrence', 'Class'],
    ]);
    expect(items[1]?.nodeId).toBe('meeting');
    expect(items[1]?.status).toBe(false);
    expect(items[2]?.ruleId).toBe('rule-1');
    expect(items[2]?.id.startsWith('rule-1:')).toBe(true);
  });

  it('includes partially overlapping entries and rejects an inverted window', () => {
    const state = fixtureState();
    const partial = agendaItems(
      state,
      timestampAt('2026-10-23', '08:00'),
      timestampAt('2026-10-23', '09:30'),
    );
    expect(partial.map((item) => item.id)).toEqual(['blk-2', 'blk-1']);
    expect(agendaItems(state, timestampAt('2026-10-23', '10:00'), timestampAt('2026-10-23', '10:00'))).toEqual([]);
  });
});

describe('node lookups', () => {
  it('finds nodes by id and path, never the root by id', () => {
    const state = fixtureState();
    expect(findNodeById(state, 'alpha')?.name).toBe('alpha');
    expect(findNodeById(state, ROOT_ID)).toBeUndefined();
    expect(findNodeById(state, 'missing')).toBeUndefined();

    expect(findNodeByPath(state, '/tmp/alpha')?.id).toBe('alpha');
    expect(findNodeByPath(state, '/tmp/alpha/alpha child')?.id).toBe('alpha-child');
    expect(findNodeByPath(state, '/')?.id).toBe(ROOT_ID);
    expect(findNodeByPath(state, '/tmp/missing')).toBeUndefined();
    expect(() => findNodeByPath(state, 'tmp/alpha')).toThrow(/must start with/);

    expect(nodePath(state, 'alpha')).toBe('/tmp/alpha');
    expect(nodePath(state, 'missing')).toBeNull();
  });
});

describe('taskSummaries', () => {
  it('lists open nodes ordered by deadline, then name', () => {
    const state = fixtureState();
    const tasks = taskSummaries(state, { now: NOW });
    expect(tasks.map((task) => task.id)).toEqual([
      'alpha',
      'beta',
      'meeting',
      'standalone',
      'alpha-child',
      'events',
      'gamma',
      'tmp',
    ]);
    const alpha = tasks[0];
    expect(alpha?.path).toBe('/tmp/alpha');
    expect(alpha?.deadline).toBe(timestampAt('2026-10-20', '18:00'));
    expect(alpha?.reminders).toBe(1);
    expect(alpha?.openChildren).toBe(1);
  });

  it('filters by keyword, completion, deadline, path and limit', () => {
    const state = fixtureState();
    expect(taskSummaries(state, { now: NOW, keyword: 'urgent' }).map((task) => task.id)).toEqual(['alpha']);
    expect(taskSummaries(state, { now: NOW, keyword: 'alpha' }).map((task) => task.id)).toEqual([
      'alpha',
      'alpha-child',
    ]);
    expect(taskSummaries(state, { now: NOW, includeCompleted: true }).map((task) => task.id)).toContain('done');
    expect(taskSummaries(state, { now: NOW, overdueOnly: true }).map((task) => task.id)).toEqual(['alpha']);
    expect(taskSummaries(state, { now: NOW, dueWithinDays: 3 }).map((task) => task.id)).toEqual(['alpha', 'beta']);
    expect(taskSummaries(state, { now: NOW, path: '/tmp' }).map((task) => task.id)).toEqual([
      'alpha',
      'beta',
      'alpha-child',
      'gamma',
      'tmp',
    ]);
    expect(taskSummaries(state, { now: NOW, limit: 2 }).map((task) => task.id)).toEqual(['alpha', 'beta']);
    expect(() => taskSummaries(state, { now: NOW, path: '/nope' })).toThrow(/unknown path/);
    expect(() => taskSummaries(state, { now: NOW, limit: 0 })).toThrow(/positive integer/);
  });
});

describe('taskDetail', () => {
  it('returns ancestors, children, reminders and the linked block', () => {
    const state = fixtureState();
    const alpha = taskDetail(state, 'alpha');
    expect(alpha?.task.id).toBe('alpha');
    expect(alpha?.ancestors).toEqual([{ id: 'tmp', name: 'tmp' }]);
    expect(alpha?.children.map((child) => child.id)).toEqual(['alpha-child']);
    expect(alpha?.reminders).toEqual([
      { id: 'rmd-1', deadline: timestampAt('2026-10-20', '17:00'), active: true, auto: false },
    ]);
    expect(alpha?.block).toBeUndefined();

    const meeting = taskDetail(state, 'meeting');
    expect(meeting?.block).toEqual({
      id: 'blk-1',
      name: 'Meeting',
      start: timestampAt('2026-10-23', '09:00'),
      end: timestampAt('2026-10-23', '10:00'),
    });
    expect(taskDetail(state, 'missing')).toBeNull();
    expect(taskDetail(state, ROOT_ID)).toBeNull();
  });
});

describe('freeSlots', () => {
  it('returns the gaps of the 08:00-23:00 working window', () => {
    const state = fixtureState();
    const slots = freeSlots(state, DAY, TZ);
    expect(slots).toEqual([
      { start: timestampAt('2026-10-23', '08:30'), end: timestampAt('2026-10-23', '09:00'), minutes: 30 },
      { start: timestampAt('2026-10-23', '10:00'), end: timestampAt('2026-10-23', '14:00'), minutes: 240 },
      { start: timestampAt('2026-10-23', '15:00'), end: timestampAt('2026-10-23', '23:00'), minutes: 480 },
    ]);
  });

  it('honours min_minutes and merges overlapping busy periods', () => {
    const state = fixtureState();
    expect(freeSlots(state, DAY, TZ, 100).map((slot) => slot.minutes)).toEqual([240, 480]);
    expect(() => freeSlots(state, DAY, TZ, 0)).toThrow(/positive integer/);

    const overlapping = WorktreeState.fromOps([
      addBlock('a', 'A', timestampAt('2026-10-23', '09:00'), timestampAt('2026-10-23', '10:30')),
      addBlock('b', 'B', timestampAt('2026-10-23', '10:00'), timestampAt('2026-10-23', '11:00')),
    ]);
    expect(freeSlots(overlapping, DAY, TZ).map((slot) => slot.minutes)).toEqual([60, 720]);
  });

  it('returns the whole window for an empty day', () => {
    const state = new WorktreeState();
    const slots = freeSlots(state, DAY, TZ);
    expect(slots).toEqual([
      { start: timestampAt('2026-10-23', '08:00'), end: timestampAt('2026-10-23', '23:00'), minutes: 900 },
    ]);
  });
});
