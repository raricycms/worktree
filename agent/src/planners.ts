import {
  DEFAULT_CAPTURE_PATH,
  ROOT_ID,
  civilFromTimestamp,
  daysFromCivil,
  endOfCivilDay,
  parseCivilDate,
  planCapture,
  timestampFromCivil,
  weekdayFromDays,
} from '@worktree/core';
import type { Block, CivilDate, CivilTime, Node, Operation, Timestamp, WorktreeState } from '@worktree/core';
import { assertWeekday } from './semester';
import type {
  CancelEventInput,
  CompleteTaskInput,
  CreateEventInput,
  CreateRecurringInput,
  CreateTaskInput,
  PlanContext,
  PlannedCancel,
  PlannedComplete,
  PlannedEvent,
  PlannedRecurring,
  PlannedTask,
  PlannedUpdate,
  UpdateEventInput,
  Weekday,
} from './types';

const MINUTE_MS = 60 * 1000;
const DEFAULT_REMIND_MINUTES = 15;
const DEFAULT_TASK_DUE: CivilTime = { hour: 23, minute: 59 };
const EVENTS_PATH = '/events';
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Validates and applies a planned batch. The ops are first replayed on a clone,
 * so a rejected op throws before the caller's state is touched at all: a planner
 * either applies its complete plan or nothing.
 */
function applyPlan(state: WorktreeState, ops: Operation[]): void {
  const probe = state.clone();
  for (const op of ops) probe.apply(op);
  for (const op of ops) state.apply(op);
}

/** The title of a captured node: trimmed, single line, no '/' (node name rules). */
function captureTitle(value: string, field: string): string {
  const title = value.trim();
  if (title === '') throw new Error(`${field} must not be empty`);
  if (title.includes('\n')) throw new Error(`${field} must be a single line`);
  if (title.includes('/')) throw new Error(`${field} must not contain "/": ${title}`);
  return title;
}

function parseCivilOf(value: string, field: string): CivilDate {
  const date = parseCivilDate(value);
  if (date === null) throw new Error(`${field} is not a valid YYYY-MM-DD date: ${value}`);
  return date;
}

function dayOf(value: string, field: string): number {
  const date = parseCivilOf(value, field);
  return daysFromCivil(date.year, date.month, date.day);
}

function parseClock(value: string, field: string): CivilTime {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error(`${field} must be HH:mm: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) throw new Error(`${field} hour is out of range: ${value}`);
  if (minute > 59) throw new Error(`${field} minute is out of range: ${value}`);
  return { hour, minute };
}

function reminderMinutes(value: number | undefined, fallback: number, field: string): number {
  const minutes = value ?? fallback;
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`${field} must be a non-negative integer: ${minutes}`);
  }
  return minutes;
}

/** The reminder deadline `base - minutes`; a reminder before the epoch is not representable. */
function reminderDeadline(base: Timestamp, minutes: number, field: string): Timestamp {
  const deadline = base - minutes * MINUTE_MS;
  if (!Number.isInteger(deadline) || deadline < 0) {
    throw new Error(`${field} produces a reminder before 1970-01-01: ${deadline}`);
  }
  return deadline;
}

function captureBody(title: string, note: string | undefined, extraLines: string[]): string {
  const lines = [title];
  const trimmedNote = note?.trim();
  if (trimmedNote !== undefined && trimmedNote !== '') lines.push(trimmedNote);
  for (const line of extraLines) if (line !== '') lines.push(line);
  return lines.join('\n');
}

function isoWeekdayOf(date: CivilDate): Weekday {
  const weekday = weekdayFromDays(daysFromCivil(date.year, date.month, date.day));
  if (weekday === 0) return 7;
  assertWeekday(weekday);
  return weekday;
}

/** Core's byDay is 0 = Sunday; the tool contract is ISO (Monday = 1 .. Sunday = 7). */
function coreWeekday(day: Weekday): number {
  return day === 7 ? 0 : day;
}

function normalizeWeekdays(values: readonly Weekday[]): Weekday[] {
  if (values.length === 0) throw new Error('weekdays must not be empty');
  const seen = new Set<number>();
  const days: Weekday[] = [];
  for (const value of values) {
    assertWeekday(value);
    if (seen.has(value)) throw new Error(`duplicate weekday: ${value}`);
    seen.add(value);
    days.push(value);
  }
  return days.sort((a, b) => a - b);
}

/** Plans a one-off event: helper node under `/events`, linked block, explicit reminder. */
export function planCreateEvent(state: WorktreeState, input: CreateEventInput, ctx: PlanContext): PlannedEvent {
  const title = captureTitle(input.title, 'event title');
  const date = parseCivilOf(input.date, 'date');
  const start = timestampFromCivil(date, parseClock(input.start, 'start_time'), ctx.tzOffset);
  const end = timestampFromCivil(date, parseClock(input.end, 'end_time'), ctx.tzOffset);
  if (end <= start) throw new Error(`end_time must be after start_time: ${input.end} <= ${input.start}`);
  const minutes = reminderMinutes(input.remindMinutesBefore, DEFAULT_REMIND_MINUTES, 'remind_minutes_before');

  const location = input.location?.trim();
  if (input.location !== undefined && location === '') throw new Error('location must not be empty');
  const extraLines = location === undefined ? [] : [`Location: ${location}`];
  const capture = planCapture(state, {
    id: ctx.newId(),
    text: captureBody(title, input.note, extraLines),
    path: EVENTS_PATH,
    timestamp: ctx.now,
    createId: ctx.newId,
  });

  const blockId = ctx.newId();
  const note = input.note?.trim();
  const ops: Operation[] = capture.entries.map((entry) => entry.op);
  ops.push({
    kind: 'add_block',
    id: blockId,
    name: title,
    start,
    end,
    note: note === undefined || note === '' ? undefined : note,
    nodeId: capture.nodeId,
  });

  let reminderId: string | undefined;
  if (minutes > 0) {
    reminderId = ctx.newId();
    ops.push({
      kind: 'add_reminder',
      nodeId: capture.nodeId,
      rmdId: reminderId,
      name: title,
      deadline: reminderDeadline(start, minutes, 'remind_minutes_before'),
    });
  }

  applyPlan(state, ops);
  return {
    ops,
    nodeId: capture.nodeId,
    blockId,
    reminderId,
    start,
    end,
    displayPath: capture.displayPath,
  };
}

/** Plans a task: node under `parentPath` (default `/tmp`), optional deadline and reminder. */
export function planCreateTask(state: WorktreeState, input: CreateTaskInput, ctx: PlanContext): PlannedTask {
  const title = captureTitle(input.title, 'task title');
  const parentPath = input.parentPath ?? DEFAULT_CAPTURE_PATH;
  if (!parentPath.startsWith('/')) throw new Error(`parent_path must be an absolute path: ${parentPath}`);
  if (input.dueTime !== undefined && input.dueDate === undefined) {
    throw new Error('due_time requires due_date');
  }

  let deadline: Timestamp | undefined;
  if (input.dueDate !== undefined) {
    const date = parseCivilOf(input.dueDate, 'due_date');
    const time = input.dueTime === undefined ? DEFAULT_TASK_DUE : parseClock(input.dueTime, 'due_time');
    deadline = timestampFromCivil(date, time, ctx.tzOffset);
  }

  const minutes =
    input.remindMinutesBefore === undefined
      ? undefined
      : reminderMinutes(input.remindMinutesBefore, 0, 'remind_minutes_before');
  if (minutes !== undefined && minutes > 0 && deadline === undefined) {
    throw new Error('remind_minutes_before requires a due_date');
  }

  const capture = planCapture(state, {
    id: ctx.newId(),
    text: captureBody(title, input.note, []),
    path: parentPath,
    timestamp: ctx.now,
    createId: ctx.newId,
  });

  const ops: Operation[] = capture.entries.map((entry) => entry.op);
  if (deadline !== undefined) ops.push({ kind: 'edit_node', id: capture.nodeId, deadline });

  let reminderId: string | undefined;
  if (minutes !== undefined && minutes > 0 && deadline !== undefined) {
    reminderId = ctx.newId();
    ops.push({
      kind: 'add_reminder',
      nodeId: capture.nodeId,
      rmdId: reminderId,
      name: capture.name,
      deadline: reminderDeadline(deadline, minutes, 'remind_minutes_before'),
    });
  }

  applyPlan(state, ops);
  return { ops, nodeId: capture.nodeId, reminderId, deadline, displayPath: capture.displayPath };
}

/** Plans one weekly block rule for the weekdays/time range. */
export function planCreateRecurring(state: WorktreeState, input: CreateRecurringInput, ctx: PlanContext): PlannedRecurring {
  const title = captureTitle(input.title, 'rule title');
  const weekdays = normalizeWeekdays(input.weekdays);
  const startDate = parseCivilOf(input.startDate, 'start_date');
  const startTime = parseClock(input.startTime, 'start_time');
  const endTime = parseClock(input.endTime, 'end_time');
  const start = timestampFromCivil(startDate, startTime, ctx.tzOffset);
  const end = timestampFromCivil(startDate, endTime, ctx.tzOffset);
  if (end <= start) throw new Error(`end_time must be after start_time: ${input.endTime} <= ${input.startTime}`);

  // The anchor day is the first candidate occurrence, so it must itself match
  // the weekly pattern; otherwise the rule would silently start a week late.
  const anchorWeekday = isoWeekdayOf(startDate);
  if (!weekdays.includes(anchorWeekday)) {
    throw new Error(
      `start_date ${input.startDate} is a ${WEEKDAY_NAMES[anchorWeekday - 1]}, which is not one of the selected weekdays`,
    );
  }

  let until: Timestamp | undefined;
  if (input.untilDate !== undefined) {
    const untilDay = dayOf(input.untilDate, 'until_date');
    if (untilDay < dayOf(input.startDate, 'start_date')) {
      throw new Error(`until_date must not be before start_date: ${input.untilDate}`);
    }
    until = endOfCivilDay(untilDay, ctx.tzOffset);
  }

  const ruleId = ctx.newId();
  const note = input.note?.trim();
  const ops: Operation[] = [
    {
      kind: 'add_block_rule',
      id: ruleId,
      name: title,
      freq: 'weekly',
      interval: 1,
      startDate,
      timeOfDay: startTime,
      duration: end - start,
      byDay: weekdays.map(coreWeekday),
      ...(until === undefined ? {} : { until }),
      tzOffset: ctx.tzOffset,
      ...(note === undefined || note === '' ? {} : { note }),
    },
  ];

  applyPlan(state, ops);
  return { ops, ruleIds: [ruleId] };
}

/**
 * Resolves an event id to its block. `create_event` reports both the node and
 * the block id, and both are unique, so a node id is accepted as a convenience
 * and resolved through its link rather than guessed.
 */
function findEventBlock(state: WorktreeState, eventId: string): Block {
  const byBlock = state.calendar.getBlocks().find((block) => block.id === eventId);
  if (byBlock !== undefined) return byBlock;
  const linked = state.calendar.getBlocks().find((block) => block.nodeId === eventId);
  if (linked !== undefined) return linked;
  throw new Error(`unknown event id: ${eventId} (expected a block id from get_agenda, or its linked node id)`);
}

function linkedNode(state: WorktreeState, block: Block): Node | undefined {
  return block.nodeId === undefined ? undefined : state.tree.getNode(block.nodeId);
}

/** Patches a block and its linked helper node (name and reminder). */
export function planUpdateEvent(state: WorktreeState, input: UpdateEventInput, ctx: PlanContext): PlannedUpdate {
  if (
    input.title === undefined &&
    input.date === undefined &&
    input.startTime === undefined &&
    input.endTime === undefined &&
    input.remindMinutesBefore === undefined
  ) {
    throw new Error('update_event requires at least one of title, date, start_time, end_time, remind_minutes_before');
  }

  const block = findEventBlock(state, input.eventId);
  const node = linkedNode(state, block);
  const title = input.title === undefined ? undefined : captureTitle(input.title, 'event title');

  const oldStart = block.start;
  const oldEnd = block.end;
  const oldCivil = civilFromTimestamp(oldStart, ctx.tzOffset);
  const date = input.date === undefined ? oldCivil.date : parseCivilOf(input.date, 'date');
  const startTime = input.startTime === undefined ? oldCivil.time : parseClock(input.startTime, 'start_time');
  const start = timestampFromCivil(date, startTime, ctx.tzOffset);
  const end =
    input.endTime === undefined ? start + (oldEnd - oldStart) : timestampFromCivil(date, parseClock(input.endTime, 'end_time'), ctx.tzOffset);
  if (end <= start) throw new Error('end_time must be after start_time');

  const ops: Operation[] = [];
  const blockPatch: { name?: string; start?: Timestamp; end?: Timestamp } = {};
  if (title !== undefined && title !== block.name) blockPatch.name = title;
  if (start !== oldStart || end !== oldEnd) {
    blockPatch.start = start;
    blockPatch.end = end;
  }
  if (Object.keys(blockPatch).length > 0) ops.push({ kind: 'edit_block', id: block.id, ...blockPatch });

  if (node !== undefined && title !== undefined && node.name !== title) {
    ops.push({ kind: 'rename', id: node.id, name: title });
  }

  if (input.remindMinutesBefore !== undefined) {
    const minutes = reminderMinutes(input.remindMinutesBefore, 0, 'remind_minutes_before');
    if (node === undefined) {
      if (minutes > 0) throw new Error('cannot set a reminder on an event without a linked node');
    } else {
      const manual = node.reminders.filter((reminder) => !reminder.auto);
      if (minutes === 0) {
        for (const reminder of manual) ops.push({ kind: 'remove_reminder', rmdId: reminder.id });
      } else if (manual.length > 1) {
        throw new Error(`event "${block.name}" has ${manual.length} manual reminders; refusing to guess which to update`);
      } else if (manual.length === 1) {
        const reminder = manual[0];
        ops.push({
          kind: 'edit_reminder',
          rmdId: reminder.id,
          deadline: reminderDeadline(start, minutes, 'remind_minutes_before'),
        });
      } else {
        ops.push({
          kind: 'add_reminder',
          nodeId: node.id,
          rmdId: ctx.newId(),
          name: title ?? node.name,
          deadline: reminderDeadline(start, minutes, 'remind_minutes_before'),
        });
      }
    }
  } else if (node !== undefined && start !== oldStart) {
    // Moving an event moves its manual reminders with it; otherwise the reminder
    // would fire at the old wall-clock time.
    const delta = start - oldStart;
    for (const reminder of node.reminders) {
      if (reminder.auto) continue;
      const deadline = reminder.deadline + delta;
      if (!Number.isInteger(deadline) || deadline < 0) {
        throw new Error(`moving the event would push reminder ${reminder.id} before 1970-01-01`);
      }
      ops.push({ kind: 'edit_reminder', rmdId: reminder.id, deadline });
    }
  }

  applyPlan(state, ops);
  return { ops, blockId: block.id, start, end };
}

/** Completes or uncompletes a node. */
export function planCompleteTask(state: WorktreeState, input: CompleteTaskInput, ctx: PlanContext): PlannedComplete {
  if (input.taskId === ROOT_ID) throw new Error('the root node is not a task');
  const node = state.tree.getNode(input.taskId);
  if (node === undefined) throw new Error(`unknown task id: ${input.taskId}`);
  const completed = input.completed ?? true;
  const op: Operation = completed ? { kind: 'complete', id: node.id } : { kind: 'uncomplete', id: node.id };
  const ops: Operation[] = [op];
  applyPlan(state, ops);
  return { ops, nodeId: node.id, completed };
}

/** Removes a block and its linked helper node when it has no children. */
export function planCancelEvent(state: WorktreeState, input: CancelEventInput, ctx: PlanContext): PlannedCancel {
  const block = findEventBlock(state, input.eventId);
  const ops: Operation[] = [{ kind: 'remove_block', id: block.id }];
  let nodeId: string | undefined;
  if (block.nodeId !== undefined) {
    const node = state.tree.getNode(block.nodeId);
    if (node !== undefined) {
      if (node.id === ROOT_ID) throw new Error('cannot cancel an event linked to the root node');
      if (node.children.length > 0) {
        throw new Error(`cannot cancel event "${block.name}": node "${node.name}" has children`);
      }
      nodeId = node.id;
      ops.push({ kind: 'remove', id: node.id });
    }
  }
  applyPlan(state, ops);
  return { ops, blockId: block.id, nodeId };
}
