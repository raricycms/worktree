import { z } from 'zod';
import { civilFromTimestamp, dayFromTimestamp, endOfCivilDay, formatCivilDate, startOfCivilDay } from '@worktree/core';
import type { Operation, Timestamp } from '@worktree/core';
import { assertWeekday, dateStringOfDay, dayOfDateString } from './semester';
import {
  planCancelEvent,
  planCompleteTask,
  planCreateEvent,
  planCreateRecurring,
  planCreateTask,
  planUpdateEvent,
} from './planners';
import { agendaItems, freeSlots, taskDetail, taskSummaries } from './read';
import { suggestTasks } from './recommend';
import type { Tool, ToolContext, ToolRunResult, Weekday } from './types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const DEFAULT_AGENDA_DAYS = 7;
const DEFAULT_FREE_MINUTES = 30;
const DEFAULT_EVENT_REMIND_MINUTES = 15;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const dateSchema = z.string().regex(DATE_PATTERN, 'expected YYYY-MM-DD');
const timeSchema = z.string().regex(TIME_PATTERN, 'expected HH:mm');
const nonEmptySchema = z.string().min(1, 'must not be empty');
const reminderMinutesSchema = z.number().int().min(0, 'must be a non-negative integer');

const GET_AGENDA_SHAPE = `{from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}`;
const SEARCH_TASKS_SHAPE = `{keyword?: string, include_completed?: boolean, overdue_only?: boolean, due_within_days?: number, path?: string, limit?: number}`;
const GET_TASK_SHAPE = `{task_id: string}`;
const FIND_FREE_SLOTS_SHAPE = `{date: 'YYYY-MM-DD', min_minutes?: number}`;
const SUGGEST_TASKS_SHAPE = `{date?: 'YYYY-MM-DD', available_minutes?: number, limit?: number}`;
const CREATE_EVENT_SHAPE = `{title: string, date: 'YYYY-MM-DD', start_time: 'HH:mm', end_time: 'HH:mm', note?: string, location?: string, remind_minutes_before?: number}`;
const CREATE_TASK_SHAPE = `{title: string, parent_path?: string, note?: string, due_date?: 'YYYY-MM-DD', due_time?: 'HH:mm', remind_minutes_before?: number}`;
const CREATE_RECURRING_SHAPE = `{title: string, weekdays: number[] (ISO 1=Monday..7=Sunday), start_time: 'HH:mm', end_time: 'HH:mm', start_date: 'YYYY-MM-DD', until_date?: 'YYYY-MM-DD', note?: string}`;
const UPDATE_EVENT_SHAPE = `{event_id: string, title?: string, date?: 'YYYY-MM-DD', start_time?: 'HH:mm', end_time?: 'HH:mm', remind_minutes_before?: number}`;
const COMPLETE_TASK_SHAPE = `{task_id: string, completed?: boolean}`;
const CANCEL_EVENT_SHAPE = `{event_id: string}`;

const getAgendaSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

const searchTasksSchema = z.object({
  keyword: z.string().optional(),
  include_completed: z.boolean().optional(),
  overdue_only: z.boolean().optional(),
  due_within_days: z.number().int().min(0).optional(),
  path: nonEmptySchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const getTaskSchema = z.object({ task_id: nonEmptySchema });

const findFreeSlotsSchema = z.object({
  date: dateSchema,
  min_minutes: z.number().int().min(1).optional(),
});

const suggestTasksSchema = z.object({
  date: dateSchema.optional(),
  available_minutes: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const createEventSchema = z.object({
  title: nonEmptySchema,
  date: dateSchema,
  start_time: timeSchema,
  end_time: timeSchema,
  note: z.string().optional(),
  location: z.string().optional(),
  remind_minutes_before: reminderMinutesSchema.optional(),
});

const createTaskSchema = z.object({
  title: nonEmptySchema,
  parent_path: nonEmptySchema.optional(),
  note: z.string().optional(),
  due_date: dateSchema.optional(),
  due_time: timeSchema.optional(),
  remind_minutes_before: reminderMinutesSchema.optional(),
});

const createRecurringSchema = z.object({
  title: nonEmptySchema,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  start_time: timeSchema,
  end_time: timeSchema,
  start_date: dateSchema,
  until_date: dateSchema.optional(),
  note: z.string().optional(),
});

const updateEventSchema = z.object({
  event_id: nonEmptySchema,
  title: nonEmptySchema.optional(),
  date: dateSchema.optional(),
  start_time: timeSchema.optional(),
  end_time: timeSchema.optional(),
  remind_minutes_before: reminderMinutesSchema.optional(),
});

const completeTaskSchema = z.object({
  task_id: nonEmptySchema,
  completed: z.boolean().optional(),
});

const cancelEventSchema = z.object({ event_id: nonEmptySchema });

/**
 * Parses tool arguments. A failure names the tool, the expected shape and the
 * offending fields, so the model can correct itself instead of guessing.
 */
function parseArgs<S extends z.ZodType>(tool: string, schema: S, shape: string, args: unknown): z.infer<S> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid arguments for ${tool}: expected ${shape} (${details})`);
  }
  return result.data;
}

function toWeekdays(values: number[]): Weekday[] {
  const days: Weekday[] = [];
  for (const value of values) {
    assertWeekday(value);
    days.push(value);
  }
  return days;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatClock(ms: Timestamp, tzOffset: number): string {
  const { time } = civilFromTimestamp(ms, tzOffset);
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

function formatDateTime(ms: Timestamp, tzOffset: number): string {
  return `${formatCivilDate(civilFromTimestamp(ms, tzOffset).date)} ${formatClock(ms, tzOffset)}`;
}

function formatRange(start: Timestamp, end: Timestamp, tzOffset: number): string {
  if (dayFromTimestamp(start, tzOffset) === dayFromTimestamp(end, tzOffset)) {
    return `${formatDateTime(start, tzOffset)}-${formatClock(end, tzOffset)}`;
  }
  return `${formatDateTime(start, tzOffset)} .. ${formatDateTime(end, tzOffset)}`;
}

function applyToolOps(ctx: ToolContext, ops: Operation[]): void {
  for (const op of ops) ctx.state.apply(op);
}

function runGetAgenda(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('get_agenda', getAgendaSchema, GET_AGENDA_SHAPE, args);
  const today = dayFromTimestamp(ctx.now, ctx.tzOffset);
  const fromDay = input.from === undefined ? today : dayOfDateString(input.from);
  const toDay = input.to === undefined ? fromDay + DEFAULT_AGENDA_DAYS : dayOfDateString(input.to);
  if (toDay < fromDay) throw new Error('get_agenda: "to" must not be before "from"');
  const items = agendaItems(ctx.state, startOfCivilDay(fromDay, ctx.tzOffset), endOfCivilDay(toDay, ctx.tzOffset) + 1);
  if (items.length === 0) {
    return { summary: `No agenda items from ${dateStringOfDay(fromDay)} to ${dateStringOfDay(toDay)}.` };
  }
  const lines = items.map((item) => {
    const completed = item.status ? ' (completed)' : '';
    const node = item.nodeId === undefined ? '' : ` (node ${item.nodeId})`;
    return `- ${formatRange(item.start, item.end, ctx.tzOffset)} ${item.name} [${item.kind} ${item.id}]${completed}${node}`;
  });
  return { summary: lines.join('\n') };
}

function runSearchTasks(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('search_tasks', searchTasksSchema, SEARCH_TASKS_SHAPE, args);
  const tasks = taskSummaries(ctx.state, {
    keyword: input.keyword,
    includeCompleted: input.include_completed,
    overdueOnly: input.overdue_only,
    dueWithinDays: input.due_within_days,
    path: input.path,
    limit: input.limit,
    now: ctx.now,
  });
  if (tasks.length === 0) return { summary: 'No matching tasks.' };
  const lines = tasks.map((task) => {
    const status = task.status ? 'completed' : 'open';
    const deadline = task.deadline === undefined ? 'no deadline' : `due ${formatDateTime(task.deadline, ctx.tzOffset)}`;
    const reminders = task.reminders === 0 ? '' : `, ${task.reminders} reminder(s)`;
    return `- [${task.id}] ${task.name} — ${status}, ${deadline}${reminders} — ${task.path}`;
  });
  return { summary: lines.join('\n') };
}

function runGetTask(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('get_task', getTaskSchema, GET_TASK_SHAPE, args);
  const detail = taskDetail(ctx.state, input.task_id);
  if (detail === null) throw new Error(`unknown task id: ${input.task_id}`);
  const task = detail.task;
  const lines: string[] = [];
  lines.push(`Task [${task.id}] ${task.name} — ${task.status ? 'completed' : 'open'} — ${task.path}`);
  if (task.note !== '') lines.push(`Note: ${task.note}`);
  if (task.deadline !== undefined) lines.push(`Deadline: ${formatDateTime(task.deadline, ctx.tzOffset)}`);
  const ancestors = detail.ancestors.length === 0 ? 'none' : detail.ancestors.map((a) => a.name).join(' / ');
  lines.push(`Ancestors: ${ancestors}`);
  lines.push(`Children: ${detail.children.length}`);
  for (const child of detail.children) {
    lines.push(`  - [${child.id}] ${child.name} — ${child.status ? 'completed' : 'open'}`);
  }
  lines.push(`Reminders: ${detail.reminders.length}`);
  for (const reminder of detail.reminders) {
    const active = reminder.active ? 'active' : 'inactive';
    const auto = reminder.auto ? ', auto' : '';
    lines.push(`  - [${reminder.id}] ${formatDateTime(reminder.deadline, ctx.tzOffset)} (${active}${auto})`);
  }
  lines.push(
    detail.block === undefined
      ? 'Linked block: none'
      : `Linked block: [${detail.block.id}] ${detail.block.name} ${formatRange(detail.block.start, detail.block.end, ctx.tzOffset)}`,
  );
  return { summary: lines.join('\n') };
}

function runFindFreeSlots(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('find_free_slots', findFreeSlotsSchema, FIND_FREE_SLOTS_SHAPE, args);
  const day = dayOfDateString(input.date);
  const minMinutes = input.min_minutes ?? DEFAULT_FREE_MINUTES;
  const slots = freeSlots(ctx.state, day, ctx.tzOffset, minMinutes);
  const dayText = dateStringOfDay(day);
  if (slots.length === 0) return { summary: `No free slots of at least ${minMinutes} minutes on ${dayText}.` };
  const lines = slots.map(
    (slot) => `- ${formatClock(slot.start, ctx.tzOffset)}-${formatClock(slot.end, ctx.tzOffset)} (${slot.minutes} min)`,
  );
  return { summary: `Free slots on ${dayText} (at least ${minMinutes} min):\n${lines.join('\n')}` };
}

function runSuggestTasks(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('suggest_tasks', suggestTasksSchema, SUGGEST_TASKS_SHAPE, args);
  const suggestions = suggestTasks({
    state: ctx.state,
    now: ctx.now,
    tzOffset: ctx.tzOffset,
    date: input.date,
    availableMinutes: input.available_minutes,
    limit: input.limit,
  });
  if (suggestions.length === 0) return { summary: 'No actionable tasks to suggest.' };
  const lines = suggestions.map(
    (suggestion, index) => `${index + 1}. [${suggestion.taskId}] ${suggestion.name} — ${suggestion.reason} — ${suggestion.path}`,
  );
  return { summary: lines.join('\n') };
}

function runCreateEvent(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('create_event', createEventSchema, CREATE_EVENT_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planCreateEvent(
    trial,
    {
      title: input.title,
      date: input.date,
      start: input.start_time,
      end: input.end_time,
      note: input.note,
      location: input.location,
      remindMinutesBefore: input.remind_minutes_before,
    },
    ctx,
  );
  applyToolOps(ctx, plan.ops);
  const minutes = input.remind_minutes_before ?? DEFAULT_EVENT_REMIND_MINUTES;
  const reminder = plan.reminderId === undefined ? 'no reminder' : `reminder ${minutes} min before`;
  const summary = `Created event "${input.title.trim()}" ${formatRange(plan.start, plan.end, ctx.tzOffset)} (block ${plan.blockId}, node ${plan.nodeId}, path ${plan.displayPath}, ${reminder}).`;
  return { summary, ops: plan.ops };
}

function runCreateTask(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('create_task', createTaskSchema, CREATE_TASK_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planCreateTask(
    trial,
    {
      title: input.title,
      parentPath: input.parent_path,
      note: input.note,
      dueDate: input.due_date,
      dueTime: input.due_time,
      remindMinutesBefore: input.remind_minutes_before,
    },
    ctx,
  );
  applyToolOps(ctx, plan.ops);
  const deadline = plan.deadline === undefined ? 'no deadline' : `deadline ${formatDateTime(plan.deadline, ctx.tzOffset)}`;
  const reminder = plan.reminderId === undefined ? '' : ', reminder set';
  return {
    summary: `Created task at ${plan.displayPath} (node ${plan.nodeId}, ${deadline}${reminder}).`,
    ops: plan.ops,
  };
}

function runCreateRecurring(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('create_recurring', createRecurringSchema, CREATE_RECURRING_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planCreateRecurring(
    trial,
    {
      title: input.title,
      weekdays: toWeekdays(input.weekdays),
      startTime: input.start_time,
      endTime: input.end_time,
      startDate: input.start_date,
      untilDate: input.until_date,
      note: input.note,
    },
    ctx,
  );
  applyToolOps(ctx, plan.ops);
  const days = [...input.weekdays].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day - 1]).join(', ');
  const until = input.until_date === undefined ? '' : ` until ${input.until_date}`;
  const ruleId = plan.ruleIds[0];
  return {
    summary: `Created weekly rule ${ruleId} "${input.title.trim()}" on ${days} ${input.start_time}-${input.end_time} from ${input.start_date}${until}.`,
    ops: plan.ops,
  };
}

function runUpdateEvent(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('update_event', updateEventSchema, UPDATE_EVENT_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planUpdateEvent(
    trial,
    {
      eventId: input.event_id,
      title: input.title,
      date: input.date,
      startTime: input.start_time,
      endTime: input.end_time,
      remindMinutesBefore: input.remind_minutes_before,
    },
    ctx,
  );
  applyToolOps(ctx, plan.ops);
  const title = input.title === undefined ? '' : ` as "${input.title.trim()}"`;
  return {
    summary: `Updated event ${plan.blockId}${title}: ${formatRange(plan.start, plan.end, ctx.tzOffset)}.`,
    ops: plan.ops,
  };
}

function runCompleteTask(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('complete_task', completeTaskSchema, COMPLETE_TASK_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planCompleteTask(trial, { taskId: input.task_id, completed: input.completed }, ctx);
  const node = trial.tree.getNode(plan.nodeId);
  if (node === undefined) throw new Error(`invariant: task ${plan.nodeId} disappeared during planning`);
  applyToolOps(ctx, plan.ops);
  const verb = plan.completed ? 'Completed' : 'Uncompleted';
  return { summary: `${verb} task ${plan.nodeId} "${node.name}".`, ops: plan.ops };
}

function runCancelEvent(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('cancel_event', cancelEventSchema, CANCEL_EVENT_SHAPE, args);
  const trial = ctx.state.clone();
  const plan = planCancelEvent(trial, { eventId: input.event_id }, ctx);
  const block = ctx.state.calendar.getBlocks().find((candidate) => candidate.id === plan.blockId);
  applyToolOps(ctx, plan.ops);
  const name = block === undefined ? '' : ` "${block.name}"`;
  const node = plan.nodeId === undefined ? '' : `, removed node ${plan.nodeId}`;
  return { summary: `Cancelled event ${plan.blockId}${name}${node}.`, ops: plan.ops };
}

/**
 * The tool set exposed to the model. Executors are synchronous and dry-run
 * their writes on `ctx.state`, so later tool calls in the same turn see them.
 */
export function createTools(): Tool[] {
  return [
    {
      definition: {
        name: 'get_agenda',
        description:
          'List blocks and recurring occurrences in a date range. Use it before creating or moving an event to spot conflicts.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'First day, YYYY-MM-DD (inclusive). Defaults to today.' },
            to: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive). Defaults to 7 days after from.' },
          },
          required: [],
        },
      },
      run: (args, ctx) => runGetAgenda(args, ctx),
    },
    {
      definition: {
        name: 'search_tasks',
        description: 'Find tasks by keyword, deadline, completion and path. Returns ids for follow-up calls.',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Case-insensitive match on name or note.' },
            include_completed: { type: 'boolean', description: 'Also return completed tasks.' },
            overdue_only: { type: 'boolean', description: 'Only open tasks past their deadline.' },
            due_within_days: { type: 'integer', minimum: 0, description: 'Only tasks due within N days.' },
            path: { type: 'string', description: 'Limit to a display path and its descendants, e.g. /tmp.' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results (default 20).' },
          },
          required: [],
        },
      },
      run: (args, ctx) => runSearchTasks(args, ctx),
    },
    {
      definition: {
        name: 'get_task',
        description: 'One task with its ancestors, children, reminders and linked calendar block.',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string', description: 'Node id from search_tasks or suggest_tasks.' } },
          required: ['task_id'],
        },
      },
      run: (args, ctx) => runGetTask(args, ctx),
    },
    {
      definition: {
        name: 'find_free_slots',
        description: 'Free intervals of at least min_minutes inside the 08:00-23:00 local working window.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Day to inspect, YYYY-MM-DD.' },
            min_minutes: { type: 'integer', minimum: 1, description: 'Minimum slot length (default 30).' },
          },
          required: ['date'],
        },
      },
      run: (args, ctx) => runFindFreeSlots(args, ctx),
    },
    {
      definition: {
        name: 'suggest_tasks',
        description: 'Rank actionable tasks: overdue first, then deadline proximity, then tasks without a deadline.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Restrict to tasks relevant on this day, YYYY-MM-DD.' },
            available_minutes: { type: 'integer', minimum: 1, description: 'Reserved: accepted but currently unused.' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum suggestions (default 5).' },
          },
          required: [],
        },
      },
      run: (args, ctx) => runSuggestTasks(args, ctx),
    },
    {
      definition: {
        name: 'create_event',
        description:
          'Create a one-off event: a node under /events, its linked calendar block and an explicit reminder.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title; also the node name.' },
            date: { type: 'string', description: 'Event day, YYYY-MM-DD.' },
            start_time: { type: 'string', description: 'Start time, HH:mm (24h).' },
            end_time: { type: 'string', description: 'End time, HH:mm (24h), after start_time.' },
            note: { type: 'string', description: 'Optional details.' },
            location: { type: 'string', description: 'Optional location; stored in the node note.' },
            remind_minutes_before: {
              type: 'integer',
              minimum: 0,
              description: 'Reminder minutes before the start (default 15; 0 disables).',
            },
          },
          required: ['title', 'date', 'start_time', 'end_time'],
        },
      },
      run: (args, ctx) => runCreateEvent(args, ctx),
    },
    {
      definition: {
        name: 'create_task',
        description: 'Create a task node, optionally with a deadline and a reminder.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title; also the node name.' },
            parent_path: { type: 'string', description: 'Parent display path (default /tmp).' },
            note: { type: 'string', description: 'Optional details.' },
            due_date: { type: 'string', description: 'Deadline day, YYYY-MM-DD.' },
            due_time: { type: 'string', description: 'Deadline time, HH:mm; requires due_date (default 23:59).' },
            remind_minutes_before: {
              type: 'integer',
              minimum: 0,
              description: 'Reminder minutes before the deadline; requires due_date.',
            },
          },
          required: ['title'],
        },
      },
      run: (args, ctx) => runCreateTask(args, ctx),
    },
    {
      definition: {
        name: 'create_recurring',
        description: 'Create one weekly calendar rule (single block rule) for the given weekdays and time range.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Rule name.' },
            weekdays: {
              type: 'array',
              items: { type: 'integer', minimum: 1, maximum: 7 },
              description: 'ISO weekdays (1=Monday .. 7=Sunday).',
            },
            start_time: { type: 'string', description: 'Start time, HH:mm.' },
            end_time: { type: 'string', description: 'End time, HH:mm, after start_time.' },
            start_date: { type: 'string', description: 'First candidate day, YYYY-MM-DD; must fall on a selected weekday.' },
            until_date: { type: 'string', description: 'Inclusive last day, YYYY-MM-DD; absent = open-ended.' },
            note: { type: 'string', description: 'Optional details.' },
          },
          required: ['title', 'weekdays', 'start_time', 'end_time', 'start_date'],
        },
      },
      run: (args, ctx) => runCreateRecurring(args, ctx),
    },
    {
      definition: {
        name: 'update_event',
        description: 'Patch an existing block and its helper node: title, date, time range or reminder.',
        parameters: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'Block id from get_agenda, or its linked node id.' },
            title: { type: 'string', description: 'New event title (also renames the node).' },
            date: { type: 'string', description: 'New day, YYYY-MM-DD.' },
            start_time: { type: 'string', description: 'New start time, HH:mm.' },
            end_time: { type: 'string', description: 'New end time, HH:mm.' },
            remind_minutes_before: {
              type: 'integer',
              minimum: 0,
              description: 'Replace the reminder with one this many minutes before the start (0 removes it).',
            },
          },
          required: ['event_id'],
        },
      },
      run: (args, ctx) => runUpdateEvent(args, ctx),
    },
    {
      definition: {
        name: 'complete_task',
        description: 'Mark a task (or an event node) completed, or reopen it.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Node id.' },
            completed: { type: 'boolean', description: 'true = complete (default), false = reopen.' },
          },
          required: ['task_id'],
        },
      },
      run: (args, ctx) => runCompleteTask(args, ctx),
    },
    {
      definition: {
        name: 'cancel_event',
        description: 'Remove an event block and its helper node when the node has no children.',
        parameters: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'Block id from get_agenda, or its linked node id.' },
          },
          required: ['event_id'],
        },
      },
      run: (args, ctx) => runCancelEvent(args, ctx),
    },
  ];
}
