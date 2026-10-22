import { describe, expect, it } from 'vitest';
import { WorktreeState, endOfCivilDay, daysFromCivil, civilFromTimestamp, formatCivilDate } from '@worktree/core';
import type { CreateRecurringInput, Weekday } from '../../src/types';
import {
  planCancelEvent,
  planCompleteTask,
  planCreateEvent,
  planCreateRecurring,
  planCreateTask,
  planUpdateEvent,
} from '../../src/planners';
import { NOW, ROOT_ID, TZ, addBlock, addNode, makeContext, timestampAt } from './fixtures';

function createEventState(): { state: WorktreeState; plan: ReturnType<typeof planCreateEvent> } {
  const state = new WorktreeState();
  const plan = planCreateEvent(
    state,
    { title: 'Standup', date: '2026-10-25', start: '09:00', end: '10:00' },
    makeContext(state),
  );
  return { state, plan };
}

describe('planCreateEvent', () => {
  it('creates the /events path, a linked block and an explicit 15-minute reminder', () => {
    const state = new WorktreeState();
    const plan = planCreateEvent(
      state,
      {
        title: 'Standup',
        date: '2026-10-25',
        start: '09:00',
        end: '10:00',
        note: 'daily sync',
        location: 'Room 3',
      },
      makeContext(state),
    );

    expect(plan.displayPath).toBe('/events/Standup');
    expect(plan.start).toBe(timestampAt('2026-10-25', '09:00'));
    expect(plan.end).toBe(timestampAt('2026-10-25', '10:00'));
    expect(plan.ops.map((op) => op.kind)).toEqual(['add', 'add', 'add_block', 'add_reminder']);

    const events = state.tree.getNode('root')?.children.find((child) => child.name === 'events');
    expect(events).toBeDefined();
    const node = state.tree.getNode(plan.nodeId);
    expect(node?.name).toBe('Standup');
    expect(node?.note).toBe('daily sync\nLocation: Room 3');
    expect(node?.deadline).toBeUndefined();
    expect(node?.reminders).toHaveLength(1);
    expect(node?.reminders[0]?.deadline).toBe(timestampAt('2026-10-25', '08:45'));
    expect(node?.reminders[0]?.auto).toBe(false);

    const block = state.calendar.getBlocks()[0];
    expect(block?.id).toBe(plan.blockId);
    expect(block?.nodeId).toBe(plan.nodeId);
    expect(block?.start).toBe(plan.start);
    expect(block?.end).toBe(plan.end);
    expect(plan.reminderId).toBe(node?.reminders[0]?.id);
  });

  it('suffixes a colliding event title instead of failing', () => {
    const state = new WorktreeState();
    const context = makeContext(state);
    planCreateEvent(state, { title: 'Standup', date: '2026-10-25', start: '09:00', end: '10:00' }, context);
    const second = planCreateEvent(
      state,
      { title: 'Standup', date: '2026-10-25', start: '10:00', end: '11:00' },
      context,
    );
    expect(second.displayPath).toBe('/events/Standup (2)');
    expect(state.calendar.getBlocks()).toHaveLength(2);
  });

  it('disables the reminder when remindMinutesBefore is 0', () => {
    const state = new WorktreeState();
    const plan = planCreateEvent(
      state,
      { title: 'No alarm', date: '2026-10-25', start: '09:00', end: '10:00', remindMinutesBefore: 0 },
      makeContext(state),
    );
    expect(plan.reminderId).toBeUndefined();
    expect(plan.ops.map((op) => op.kind)).not.toContain('add_reminder');
    expect(state.tree.getNode(plan.nodeId)?.reminders).toHaveLength(0);
  });

  it('replays the planned ops identically on a fresh state', () => {
    const { state, plan } = createEventState();
    const replay = WorktreeState.fromOps(plan.ops);
    expect(replay.tree.nodeCount()).toBe(state.tree.nodeCount());
    expect(replay.calendar.blockCount()).toBe(state.calendar.blockCount());
    const replayedBlock = replay.calendar.getBlocks()[0];
    expect(replayedBlock?.start).toBe(plan.start);
    expect(replayedBlock?.nodeId).toBe(plan.nodeId);
  });

  it('rejects invalid input', () => {
    const state = new WorktreeState();
    const base = { title: 'X', date: '2026-10-25', start: '09:00', end: '10:00' };
    expect(() => planCreateEvent(state, { ...base, end: '09:00' }, makeContext(state))).toThrow(
      /end_time must be after start_time/,
    );
    expect(() => planCreateEvent(state, { ...base, date: '2026-02-30' }, makeContext(state))).toThrow(
      /not a valid YYYY-MM-DD/,
    );
    expect(() => planCreateEvent(state, { ...base, start: '9:00' }, makeContext(state))).toThrow(/must be HH:mm/);
    expect(() => planCreateEvent(state, { ...base, title: 'a/b' }, makeContext(state))).toThrow(/must not contain/);
    expect(() => planCreateEvent(state, { ...base, title: '   ' }, makeContext(state))).toThrow(/must not be empty/);
    expect(() => planCreateEvent(state, { ...base, title: 'a\nb' }, makeContext(state))).toThrow(/single line/);
    expect(() => planCreateEvent(state, { ...base, location: ' ' }, makeContext(state))).toThrow(
      /location must not be empty/,
    );
    expect(() => planCreateEvent(state, { ...base, remindMinutesBefore: -5 }, makeContext(state))).toThrow(
      /non-negative integer/,
    );
    expect(state.tree.nodeCount()).toBe(0);
    expect(state.calendar.blockCount()).toBe(0);
  });
});

describe('planCreateTask', () => {
  it('creates /tmp and a task with a default 23:59 deadline', () => {
    const state = new WorktreeState();
    const plan = planCreateTask(
      state,
      { title: 'Write report', note: 'two pages', dueDate: '2026-10-30' },
      makeContext(state),
    );
    expect(plan.displayPath).toBe('/tmp/Write report');
    expect(plan.ops.map((op) => op.kind)).toEqual(['add', 'add', 'edit_node']);
    expect(plan.deadline).toBe(timestampAt('2026-10-30', '23:59'));
    const node = state.tree.getNode(plan.nodeId);
    expect(node?.note).toBe('two pages');
    expect(node?.deadline).toBe(plan.deadline);
    expect(node?.reminders).toHaveLength(0);
  });

  it('auto-creates the parent path and adds a deadline reminder when asked', () => {
    const state = new WorktreeState();
    const plan = planCreateTask(
      state,
      {
        title: 'Draft',
        parentPath: '/work/projects',
        dueDate: '2026-10-30',
        dueTime: '17:00',
        remindMinutesBefore: 30,
      },
      makeContext(state),
    );
    expect(plan.displayPath).toBe('/work/projects/Draft');
    expect(plan.ops.map((op) => op.kind)).toEqual(['add', 'add', 'add', 'edit_node', 'add_reminder']);
    expect(plan.deadline).toBe(timestampAt('2026-10-30', '17:00'));
    const node = state.tree.getNode(plan.nodeId);
    expect(node?.reminders[0]?.deadline).toBe(timestampAt('2026-10-30', '16:30'));
  });

  it('creates only the node when there is no deadline', () => {
    const state = new WorktreeState();
    const plan = planCreateTask(state, { title: 'Someday' }, makeContext(state));
    expect(plan.ops.map((op) => op.kind)).toEqual(['add', 'add']);
    expect(plan.deadline).toBeUndefined();
    expect(state.tree.getNode(plan.nodeId)?.deadline).toBeUndefined();
  });

  it('rejects contradictory or malformed input', () => {
    const state = new WorktreeState();
    expect(() => planCreateTask(state, { title: 'X', dueTime: '10:00' }, makeContext(state))).toThrow(
      /due_time requires due_date/,
    );
    expect(() =>
      planCreateTask(state, { title: 'X', remindMinutesBefore: 15 }, makeContext(state)),
    ).toThrow(/requires a due_date/);
    expect(() => planCreateTask(state, { title: 'X', parentPath: 'tmp' }, makeContext(state))).toThrow(
      /absolute path/,
    );
    expect(() =>
      planCreateTask(
        state,
        { title: 'Old', dueDate: '1970-01-01', dueTime: '00:00', remindMinutesBefore: 1 },
        makeContext(state),
      ),
    ).toThrow(/before 1970-01-01/);
    expect(state.tree.nodeCount()).toBe(0);
  });
});

describe('planCreateRecurring', () => {
  it('creates one weekly rule with ISO weekdays converted to core byDay', () => {
    const state = new WorktreeState();
    const plan = planCreateRecurring(
      state,
      {
        title: 'Math',
        weekdays: [1, 3, 7],
        startTime: '09:00',
        endTime: '10:30',
        startDate: '2026-09-07',
        untilDate: '2026-09-20',
      },
      makeContext(state),
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]?.kind).toBe('add_block_rule');
    const rule = state.calendar.getRules()[0];
    expect(rule?.id).toBe(plan.ruleIds[0]);
    expect(rule?.freq).toBe('weekly');
    expect(rule?.interval).toBe(1);
    expect(rule?.byDay).toEqual([1, 3, 0]);
    expect(rule?.duration).toBe(90 * 60 * 1000);
    expect(rule?.startDate).toEqual({ year: 2026, month: 9, day: 7 });
    expect(rule?.timeOfDay).toEqual({ hour: 9, minute: 0 });
    expect(rule?.until).toBe(endOfCivilDay(daysFromCivil(2026, 9, 20), TZ));
    expect(state.calendar.ruleCount()).toBe(1);
  });

  it('expands to the expected occurrences and honours until_date inclusively', () => {
    const state = new WorktreeState();
    planCreateRecurring(
      state,
      {
        title: 'Math',
        weekdays: [1, 3],
        startTime: '09:00',
        endTime: '10:00',
        startDate: '2026-09-07',
        untilDate: '2026-09-20',
      },
      makeContext(state),
    );
    const from = timestampAt('2026-09-01', '00:00');
    const to = timestampAt('2026-10-01', '00:00');
    const days = state.calendar.expand(from, to).map((occurrence) => {
      const civil = civilFromTimestamp(occurrence.occStart, TZ).date;
      return formatCivilDate(civil);
    });
    expect(days).toEqual(['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
  });

  it('leaves the rule open-ended without until_date', () => {
    const state = new WorktreeState();
    const plan = planCreateRecurring(
      state,
      { title: 'Gym', weekdays: [5], startTime: '18:00', endTime: '19:00', startDate: '2026-10-23' },
      makeContext(state),
    );
    const rule = state.calendar.getRules()[0];
    expect(rule?.until).toBeUndefined();
    expect(rule?.byDay).toEqual([5]);
    expect(plan.ruleIds).toHaveLength(1);
  });

  it('rejects an anchor day outside the selected weekdays and other invalid input', () => {
    const state = new WorktreeState();
    const base: CreateRecurringInput = {
      title: 'Class',
      weekdays: [1],
      startTime: '09:00',
      endTime: '10:00',
      startDate: '2026-09-07',
    };
    expect(() => planCreateRecurring(state, { ...base, weekdays: [] }, makeContext(state))).toThrow(
      /must not be empty/,
    );
    expect(() =>
      planCreateRecurring(state, { ...base, weekdays: [1, 1] }, makeContext(state)),
    ).toThrow(/duplicate weekday/);
    expect(() =>
      planCreateRecurring(state, { ...base, weekdays: [8 as Weekday] }, makeContext(state)),
    ).toThrow(/weekday out of range/);
    expect(() =>
      planCreateRecurring(state, { ...base, weekdays: [2], startDate: '2026-09-07' }, makeContext(state)),
    ).toThrow(/is a Monday, which is not one of the selected weekdays/);
    expect(() =>
      planCreateRecurring(state, { ...base, untilDate: '2026-09-06' }, makeContext(state)),
    ).toThrow(/until_date must not be before start_date/);
    expect(() => planCreateRecurring(state, { ...base, endTime: '09:00' }, makeContext(state))).toThrow(
      /end_time must be after start_time/,
    );
    expect(state.calendar.ruleCount()).toBe(0);
  });
});

describe('planUpdateEvent', () => {
  it('moves the block, keeping its duration, and shifts the reminder', () => {
    const { state, plan } = createEventState();
    const update = planUpdateEvent(
      state,
      { eventId: plan.blockId, date: '2026-10-26', startTime: '11:00' },
      makeContext(state),
    );
    const block = state.calendar.getBlocks()[0];
    expect(block?.start).toBe(timestampAt('2026-10-26', '11:00'));
    expect(block?.end).toBe(timestampAt('2026-10-26', '12:00'));
    expect(update.start).toBe(block?.start);
    expect(update.end).toBe(block?.end);
    const reminder = state.tree.getNode(plan.nodeId)?.reminders[0];
    expect(reminder?.deadline).toBe(timestampAt('2026-10-26', '10:45'));

    const replay = WorktreeState.fromOps([...plan.ops, ...update.ops]);
    expect(replay.calendar.getBlocks()[0]?.start).toBe(timestampAt('2026-10-26', '11:00'));
  });

  it('renames the block and its node', () => {
    const { state, plan } = createEventState();
    const update = planUpdateEvent(state, { eventId: plan.blockId, title: 'Daily standup' }, makeContext(state));
    expect(update.ops.map((op) => op.kind)).toEqual(['edit_block', 'rename']);
    expect(state.calendar.getBlocks()[0]?.name).toBe('Daily standup');
    expect(state.tree.getNode(plan.nodeId)?.name).toBe('Daily standup');
  });

  it('replaces or removes the explicit reminder', () => {
    const { state, plan } = createEventState();
    planUpdateEvent(state, { eventId: plan.blockId, remindMinutesBefore: 30 }, makeContext(state));
    expect(state.tree.getNode(plan.nodeId)?.reminders).toHaveLength(1);
    expect(state.tree.getNode(plan.nodeId)?.reminders[0]?.deadline).toBe(timestampAt('2026-10-25', '08:30'));

    planUpdateEvent(state, { eventId: plan.blockId, remindMinutesBefore: 0 }, makeContext(state));
    expect(state.tree.getNode(plan.nodeId)?.reminders).toHaveLength(0);
  });

  it('accepts the linked node id and adds a reminder when the node had none', () => {
    const state = new WorktreeState();
    const plan = planCreateEvent(
      state,
      { title: 'No alarm', date: '2026-10-25', start: '09:00', end: '10:00', remindMinutesBefore: 0 },
      makeContext(state),
    );
    const update = planUpdateEvent(state, { eventId: plan.nodeId, remindMinutesBefore: 10 }, makeContext(state));
    expect(update.blockId).toBe(plan.blockId);
    expect(state.tree.getNode(plan.nodeId)?.reminders[0]?.deadline).toBe(timestampAt('2026-10-25', '08:50'));
  });

  it('rejects an empty patch, an invalid range and unknown events', () => {
    const { state, plan } = createEventState();
    expect(() => planUpdateEvent(state, { eventId: plan.blockId }, makeContext(state))).toThrow(
      /at least one of/,
    );
    expect(() =>
      planUpdateEvent(state, { eventId: plan.blockId, endTime: '08:00' }, makeContext(state)),
    ).toThrow(/end_time must be after start_time/);
    expect(() => planUpdateEvent(state, { eventId: 'missing', title: 'x' }, makeContext(state))).toThrow(
      /unknown event id/,
    );
  });
});

describe('planCompleteTask', () => {
  function treeState(): WorktreeState {
    return WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'parent', 'Parent'),
      addNode('parent', 'child', 'Child'),
    ]);
  }

  it('completes and reopens a leaf', () => {
    const state = treeState();
    const completed = planCompleteTask(state, { taskId: 'child' }, makeContext(state));
    expect(completed.completed).toBe(true);
    expect(completed.ops.map((op) => op.kind)).toEqual(['complete']);
    expect(state.tree.getNode('child')?.status).toBe(true);

    planCompleteTask(state, { taskId: 'child', completed: false }, makeContext(state));
    expect(state.tree.getNode('child')?.status).toBe(false);
  });

  it('refuses to complete a parent whose child is still open', () => {
    const state = treeState();
    expect(() => planCompleteTask(state, { taskId: 'parent' }, makeContext(state))).toThrow(
      /child "Child" is not completed/,
    );
    expect(state.tree.getNode('parent')?.status).toBe(false);
  });

  it('reopening a child uncompletes its completed ancestors', () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'parent', 'Parent'),
      addNode('parent', 'child', 'Child'),
      { kind: 'complete', id: 'child' },
      { kind: 'complete', id: 'parent' },
    ]);
    expect(state.tree.getNode('parent')?.status).toBe(true);
    planCompleteTask(state, { taskId: 'child', completed: false }, makeContext(state));
    expect(state.tree.getNode('child')?.status).toBe(false);
    expect(state.tree.getNode('parent')?.status).toBe(false);
  });

  it('rejects unknown nodes and the root', () => {
    const state = treeState();
    expect(() => planCompleteTask(state, { taskId: 'missing' }, makeContext(state))).toThrow(/unknown task id/);
    expect(() => planCompleteTask(state, { taskId: ROOT_ID }, makeContext(state))).toThrow(/not a task/);
  });
});

describe('planCancelEvent', () => {
  it('removes the block and its empty helper node', () => {
    const { state, plan } = createEventState();
    const cancel = planCancelEvent(state, { eventId: plan.blockId }, makeContext(state));
    expect(cancel.ops.map((op) => op.kind)).toEqual(['remove_block', 'remove']);
    expect(cancel.nodeId).toBe(plan.nodeId);
    expect(state.calendar.blockCount()).toBe(0);
    expect(state.tree.getNode(plan.nodeId)).toBeUndefined();

    const replay = WorktreeState.fromOps([...plan.ops, ...cancel.ops]);
    expect(replay.calendar.blockCount()).toBe(0);
    expect(replay.tree.nodeCount()).toBe(1);
  });

  it('leaves a standalone block alone and removes only the block', () => {
    const state = WorktreeState.fromOps([
      addBlock('block-1', 'Lunch', timestampAt('2026-10-25', '12:00'), timestampAt('2026-10-25', '13:00')),
    ]);
    const cancel = planCancelEvent(state, { eventId: 'block-1' }, makeContext(state));
    expect(cancel.nodeId).toBeUndefined();
    expect(cancel.ops.map((op) => op.kind)).toEqual(['remove_block']);
    expect(state.calendar.blockCount()).toBe(0);
  });

  it('refuses to delete a node that has children', () => {
    const { state, plan } = createEventState();
    const withChild = WorktreeState.fromOps([...plan.ops, addNode(plan.nodeId, 'child', 'Child')]);
    expect(() => planCancelEvent(withChild, { eventId: plan.blockId }, makeContext(withChild))).toThrow(
      /has children/,
    );
    expect(withChild.calendar.blockCount()).toBe(1);
  });

  it('rejects unknown ids', () => {
    const state = new WorktreeState();
    expect(() => planCancelEvent(state, { eventId: 'missing' }, makeContext(state))).toThrow(/unknown event id/);
  });
});

describe('planner determinism', () => {
  it('injects the clock and id factory instead of reading them', () => {
    const state = new WorktreeState();
    const plan = planCreateEvent(
      state,
      { title: 'Fixed', date: '2026-10-25', start: '09:00', end: '10:00' },
      makeContext(state, { now: NOW }),
    );
    const replay = WorktreeState.fromOps(plan.ops);
    const created = replay.tree.getNode(plan.nodeId);
    expect(created?.createdAt).toBe(NOW);
    expect(created?.reminders[0]?.id).toBe(`${plan.reminderId}`);
  });
});
