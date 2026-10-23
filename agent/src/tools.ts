import { z } from 'zod';
import {
  ROOT_ID,
  civilFromTimestamp,
  dayFromTimestamp,
  daysFromCivil,
  displayPathOf,
  endOfCivilDay,
  formatCivilDate,
  startOfCivilDay,
  weekdayFromDays,
} from '@worktree/core';
import type { Node, Operation, Timestamp } from '@worktree/core';
import { assertWeekday, dateStringOfDay, dayOfDateString } from './semester';
import {
  planCancelEvent,
  planCompleteTask,
  planCreateEvent,
  planCreateRecurring,
  planCreateTask,
  planUpdateEvent,
  planUpdateTask,
} from './planners';
import { agendaItems, findNodeById, findNodeByPath, freeSlots, taskDetail, taskSummaries } from './read';
import { suggestTasks } from './recommend';
import { parseWeeksSpec } from './weeks';
import type { Semester, TimetableRow, Tool, ToolContext, ToolRunResult, Weekday } from './types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const DEFAULT_AGENDA_DAYS = 7;
const DEFAULT_FREE_MINUTES = 30;
const DEFAULT_EVENT_REMIND_MINUTES = 15;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_NODES = 300;
const MAX_TASKS_PER_BATCH = 30;
const MAX_TIMETABLE_ROWS = 200;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CORE_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

const dateSchema = z.string().regex(DATE_PATTERN, 'expected YYYY-MM-DD');
const timeSchema = z.string().regex(TIME_PATTERN, 'expected HH:mm');
const nonEmptySchema = z.string().min(1, 'must not be empty');
const reminderMinutesSchema = z.number().int().min(0, 'must be a non-negative integer');

const GET_AGENDA_SHAPE = `{from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD'}`;
const SEARCH_TASKS_SHAPE = `{keyword?: string, include_completed?: boolean, overdue_only?: boolean, due_within_days?: number, path?: string, limit?: number}`;
const GET_TASK_SHAPE = `{task_id: string}`;
const GET_TREE_SHAPE = `{path?: string, depth?: number (1..20), include_completed?: boolean}`;
const LIST_RULES_SHAPE = `{}`;
const FIND_FREE_SLOTS_SHAPE = `{date: 'YYYY-MM-DD', min_minutes?: number}`;
const SUGGEST_TASKS_SHAPE = `{date?: 'YYYY-MM-DD', available_minutes?: number, limit?: number}`;
const CREATE_EVENT_SHAPE = `{title: string, date: 'YYYY-MM-DD', start_time: 'HH:mm', end_time: 'HH:mm', note?: string, location?: string, remind_minutes_before?: number}`;
const CREATE_TASK_SHAPE = `{title: string, parent_path?: string, note?: string, due_date?: 'YYYY-MM-DD', due_time?: 'HH:mm', remind_minutes_before?: number}`;
const CREATE_TASKS_SHAPE = `{tasks: ${CREATE_TASK_SHAPE}[] (1..30 items)}`;
const CREATE_RECURRING_SHAPE = `{title: string, weekdays: number[] (ISO 1=Monday..7=Sunday), start_time: 'HH:mm', end_time: 'HH:mm', start_date: 'YYYY-MM-DD', until_date?: 'YYYY-MM-DD', note?: string}`;
const UPDATE_EVENT_SHAPE = `{event_id: string, title?: string, date?: 'YYYY-MM-DD', start_time?: 'HH:mm', end_time?: 'HH:mm', remind_minutes_before?: number}`;
const UPDATE_TASK_SHAPE = `{task_id: string, title?: string, note?: string, due_date?: 'YYYY-MM-DD', clear_deadline?: boolean, due_time?: 'HH:mm', remind_minutes_before?: number}`;
const COMPLETE_TASK_SHAPE = `{task_id: string, completed?: boolean}`;
const CANCEL_EVENT_SHAPE = `{event_id: string}`;
const CANCEL_RECURRING_SHAPE = `{rule_id: string}`;
const MOVE_NODE_SHAPE = `{node_id: string, parent_path: string}`;
const DELETE_NODE_SHAPE = `{node_id: string, with_children?: boolean}`;
const ASK_USER_SHAPE = `{question: string, options?: string[] (2..5 short answers)}`;
const IMPORT_TIMETABLE_SHAPE = `{rows: {course: string, weekday: number (1..7), start: 'HH:mm', end: 'HH:mm', weeks?: string, teacher?: string, location?: string}[], warnings?: string[]}`;

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

const getTreeSchema = z.object({
  path: nonEmptySchema.optional(),
  depth: z.number().int().min(1).max(20).optional(),
  include_completed: z.boolean().optional(),
});

const listRulesSchema = z.object({});

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

const createTasksSchema = z.object({
  tasks: z.array(createTaskSchema).min(1, 'at least one task').max(MAX_TASKS_PER_BATCH),
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

const updateTaskSchema = z.object({
  task_id: nonEmptySchema,
  title: nonEmptySchema.optional(),
  note: z.string().optional(),
  due_date: dateSchema.optional(),
  clear_deadline: z.boolean().optional(),
  due_time: timeSchema.optional(),
  remind_minutes_before: reminderMinutesSchema.optional(),
});

const completeTaskSchema = z.object({
  task_id: nonEmptySchema,
  completed: z.boolean().optional(),
});

const cancelEventSchema = z.object({ event_id: nonEmptySchema });

const cancelRecurringSchema = z.object({ rule_id: nonEmptySchema });

const moveNodeSchema = z.object({
  node_id: nonEmptySchema,
  parent_path: nonEmptySchema,
});

const deleteNodeSchema = z.object({
  node_id: nonEmptySchema,
  with_children: z.boolean().optional(),
});

const askUserSchema = z.object({
  question: nonEmptySchema,
  options: z.array(nonEmptySchema).min(2, 'provide 2 to 5 short options').max(5, 'provide 2 to 5 short options').optional(),
});

const timetableRowInputSchema = z.object({
  course: z.unknown().optional(),
  weekday: z.unknown().optional(),
  start: z.unknown().optional(),
  end: z.unknown().optional(),
  weeks: z.unknown().optional(),
  teacher: z.unknown().optional(),
  location: z.unknown().optional(),
});

const importTimetableSchema = z.object({
  rows: z.array(timetableRowInputSchema).min(1, 'at least one row').max(MAX_TIMETABLE_ROWS),
  warnings: z.array(z.string()).optional(),
});

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

/**
 * Validates a planned batch on a clone before touching the live dry-run state,
 * so a late rejection leaves `ctx.state` exactly as it was.
 */
function commitOps(ctx: ToolContext, ops: Operation[]): void {
  const probe = ctx.state.clone();
  for (const op of ops) probe.apply(op);
  for (const op of ops) ctx.state.apply(op);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The next append position among a parent's children. */
function nextWeight(parent: Node): number {
  return parent.children.reduce((max, child) => Math.max(max, child.weight), 0) + 1;
}

function countDescendants(node: Node): number {
  let count = 0;
  for (const child of node.children) count += 1 + countDescendants(child);
  return count;
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

function visibleChildren(node: Node, includeCompleted: boolean): Node[] {
  return node.children.filter((child) => includeCompleted || !child.status);
}

/** Visible nodes including `node` itself, counting levels from `level` down to `depth`. */
function countTreeNodes(node: Node, level: number, depth: number, includeCompleted: boolean): number {
  let total = 1;
  if (level >= depth) return total;
  for (const child of visibleChildren(node, includeCompleted)) {
    total += countTreeNodes(child, level + 1, depth, includeCompleted);
  }
  return total;
}

function runGetTree(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('get_tree', getTreeSchema, GET_TREE_SHAPE, args);
  const path = input.path ?? '/';
  const scope = findNodeByPath(ctx.state, path);
  if (scope === undefined) throw new Error(`unknown path: ${path}`);
  const depth = input.depth ?? DEFAULT_TREE_DEPTH;
  const includeCompleted = input.include_completed ?? false;
  const isRoot = scope.id === ROOT_ID;
  // The scope node always shows (the caller named it); depth bounds the levels below it.
  const total = isRoot
    ? visibleChildren(scope, includeCompleted).reduce(
        (sum, child) => sum + countTreeNodes(child, 1, depth, includeCompleted),
        0,
      )
    : countTreeNodes(scope, 0, depth, includeCompleted);

  const lines: string[] = [`Tree at ${path} (depth ${depth}):`];
  let shown = 0;
  const emit = (node: Node, level: number): void => {
    const indent = ' '.repeat(Math.max(0, level - (isRoot ? 1 : 0)) * 2);
    lines.push(`${indent}- [${node.id}] ${node.name}${node.status ? ' (completed)' : ''}`);
    shown++;
  };
  const render = (node: Node, level: number): void => {
    if (shown >= MAX_TREE_NODES) return;
    emit(node, level);
    if (level >= depth) return;
    for (const child of visibleChildren(node, includeCompleted)) {
      if (shown >= MAX_TREE_NODES) return;
      render(child, level + 1);
    }
  };
  if (!isRoot) emit(scope, 0);
  for (const child of visibleChildren(scope, includeCompleted)) {
    if (shown >= MAX_TREE_NODES) break;
    render(child, 1);
  }
  if (total === 0) lines.push('(no nodes)');
  if (total > shown) lines.push(`- ... ${total - shown} more`);
  return { summary: lines.join('\n') };
}

function ruleWeekdays(rule: { freq: string; byDay?: number[]; startDate: { year: number; month: number; day: number } }): string {
  if (rule.freq !== 'weekly') return '';
  let coreDays = rule.byDay;
  if (coreDays === undefined || coreDays.length === 0) {
    const day = weekdayFromDays(daysFromCivil(rule.startDate.year, rule.startDate.month, rule.startDate.day));
    coreDays = [day];
  }
  const names = [...coreDays]
    .sort((a, b) => a - b)
    .map((day) => CORE_WEEKDAY_NAMES[day] ?? `day ${day}`);
  return names.join(', ');
}

function ruleTimeRange(rule: { timeOfDay: { hour: number; minute: number }; duration: Timestamp }): string {
  const startMinutes = rule.timeOfDay.hour * 60 + rule.timeOfDay.minute;
  const endMinutes = startMinutes + Math.round(rule.duration / MINUTE_MS);
  const dayOffset = Math.floor(endMinutes / DAY_MINUTES);
  const endClock = `${pad2(Math.floor((endMinutes % DAY_MINUTES) / 60))}:${pad2(endMinutes % 60)}`;
  const range = `${pad2(rule.timeOfDay.hour)}:${pad2(rule.timeOfDay.minute)}-${endClock}`;
  return dayOffset === 0 ? range : `${range} (+${dayOffset}d)`;
}

function runListRules(args: unknown, ctx: ToolContext): ToolRunResult {
  parseArgs('list_rules', listRulesSchema, LIST_RULES_SHAPE, args);
  const rules = [...ctx.state.calendar.getRules()].sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1),
  );
  if (rules.length === 0) return { summary: 'No recurring rules.' };
  const lines = rules.map((rule) => {
    const parts: string[] = [`[${rule.id}] ${rule.name}`];
    const days = ruleWeekdays(rule);
    if (days !== '') parts.push(days);
    parts.push(`${ruleTimeRange(rule)} (${rule.freq}, every ${rule.interval})`);
    parts.push(`first ${formatCivilDate(rule.startDate)}`);
    if (rule.until !== undefined) {
      const until = civilFromTimestamp(rule.until, rule.tzOffset);
      parts.push(`until ${formatCivilDate(until.date)}`);
    }
    if (!rule.active) parts.push('inactive');
    if (rule.note !== '') parts.push(`note: ${rule.note}`);
    return `- ${parts.join(' — ')}`;
  });
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

function runCreateTasks(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('create_tasks', createTasksSchema, CREATE_TASKS_SHAPE, args);
  const trial = ctx.state.clone();
  const ops: Operation[] = [];
  const lines: string[] = [];
  input.tasks.forEach((item, index) => {
    try {
      const plan = planCreateTask(
        trial,
        {
          title: item.title,
          parentPath: item.parent_path,
          note: item.note,
          dueDate: item.due_date,
          dueTime: item.due_time,
          remindMinutesBefore: item.remind_minutes_before,
        },
        ctx,
      );
      ops.push(...plan.ops);
      const deadline =
        plan.deadline === undefined ? '' : `, deadline ${formatDateTime(plan.deadline, ctx.tzOffset)}`;
      const reminder = plan.reminderId === undefined ? '' : ', reminder set';
      lines.push(`${index + 1}. ${plan.displayPath} (node ${plan.nodeId}${deadline}${reminder})`);
    } catch (error) {
      throw new Error(`create_tasks: task ${index + 1} ("${item.title}"): ${messageOf(error)}`);
    }
  });
  commitOps(ctx, ops);
  return { summary: `Created ${input.tasks.length} tasks:\n${lines.join('\n')}`, ops };
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

function runUpdateTask(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('update_task', updateTaskSchema, UPDATE_TASK_SHAPE, args);
  const before = ctx.state.tree.getNode(input.task_id);
  if (before === undefined || before.id === ROOT_ID) throw new Error(`unknown task id: ${input.task_id}`);
  const trial = ctx.state.clone();
  const plan = planUpdateTask(
    trial,
    {
      taskId: input.task_id,
      title: input.title,
      note: input.note,
      dueDate: input.due_date,
      dueTime: input.due_time,
      clearDeadline: input.clear_deadline,
      remindMinutesBefore: input.remind_minutes_before,
    },
    ctx,
  );
  applyToolOps(ctx, plan.ops);

  const parts: string[] = [];
  if (input.title !== undefined && input.title.trim() !== before.name) {
    parts.push(`renamed to "${input.title.trim()}"`);
  }
  if (input.note !== undefined) parts.push(input.note.trim() === '' ? 'note cleared' : 'note updated');
  if (input.clear_deadline === true) parts.push('deadline cleared');
  else if (plan.deadline !== undefined && (input.due_date !== undefined || input.due_time !== undefined)) {
    parts.push(`deadline ${formatDateTime(plan.deadline, ctx.tzOffset)}`);
  }
  if (input.remind_minutes_before !== undefined) {
    parts.push(
      input.remind_minutes_before === 0
        ? 'deadline reminder removed'
        : `reminder ${input.remind_minutes_before} min before`,
    );
  } else if ((input.due_date !== undefined || input.due_time !== undefined) && plan.reminderIds.length > 0) {
    parts.push('deadline reminders moved');
  }
  const summary =
    parts.length === 0
      ? `Updated task ${plan.nodeId} "${before.name}": no changes.`
      : `Updated task ${plan.nodeId} "${before.name}": ${parts.join(', ')}.`;
  return { summary, ops: plan.ops };
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

function runCancelRecurring(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('cancel_recurring', cancelRecurringSchema, CANCEL_RECURRING_SHAPE, args);
  const rule = ctx.state.calendar.getRules().find((candidate) => candidate.id === input.rule_id);
  if (rule === undefined) throw new Error(`unknown rule id: ${input.rule_id}`);
  const ops: Operation[] = [{ kind: 'remove_block_rule', id: rule.id }];
  commitOps(ctx, ops);
  return { summary: `Cancelled recurring rule ${rule.id} "${rule.name}".`, ops };
}

function runMoveNode(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('move_node', moveNodeSchema, MOVE_NODE_SHAPE, args);
  const node = findNodeById(ctx.state, input.node_id);
  if (node === undefined) throw new Error(`unknown node id: ${input.node_id}`);
  const parent = findNodeByPath(ctx.state, input.parent_path);
  if (parent === undefined) throw new Error(`unknown path: ${input.parent_path}`);
  const ops: Operation[] = [{ kind: 'move', id: node.id, parentId: parent.id, weight: nextWeight(parent) }];
  commitOps(ctx, ops);
  const path = displayPathOf(ctx.state.tree, node.id);
  return { summary: `Moved node ${node.id} "${node.name}" to ${path === null ? input.parent_path : path}.`, ops };
}

function runDeleteNode(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('delete_node', deleteNodeSchema, DELETE_NODE_SHAPE, args);
  const node = findNodeById(ctx.state, input.node_id);
  if (node === undefined) throw new Error(`unknown node id: ${input.node_id}`);
  if (node.children.length > 0 && input.with_children !== true) {
    throw new Error(
      `cannot delete "${node.name}": it has ${node.children.length} child node(s); pass with_children: true to delete the whole subtree, or move/remove the children first`,
    );
  }
  const block = ctx.state.calendar.getBlocks().find((candidate) => candidate.nodeId === node.id);
  if (block !== undefined) {
    throw new Error(
      `cannot delete "${node.name}": it is linked to calendar event "${block.name}" ${formatRange(block.start, block.end, ctx.tzOffset)}; cancel the event first with cancel_event`,
    );
  }
  const descendants = countDescendants(node);
  const ops: Operation[] = [{ kind: 'remove', id: node.id }];
  commitOps(ctx, ops);
  const suffix = descendants === 0 ? '' : ` and ${descendants} descendant node(s)`;
  return { summary: `Deleted node ${node.id} "${node.name}"${suffix}.`, ops };
}

async function runAskUser(args: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  const input = parseArgs('ask_user', askUserSchema, ASK_USER_SHAPE, args);
  const question = input.question.trim();
  if (question === '') throw new Error('ask_user: question must not be empty');
  const options = (input.options ?? []).map((option) => option.trim());
  for (const option of options) {
    if (option === '') throw new Error('ask_user: every option must be a non-empty short answer');
  }
  const ask = ctx.askUser;
  if (ask === undefined) {
    throw new Error(
      'ask_user is unavailable in this run: no interactive channel is attached, so ask the user in your reply instead',
    );
  }
  const answer = await ask({ question, options });
  return { summary: `User answered: ${answer}` };
}

/** Strict HH:mm for preview rows, where a malformed time must fail the call. */
function parseRowClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function runImportTimetable(args: unknown, ctx: ToolContext): ToolRunResult {
  const input = parseArgs('import_timetable', importTimetableSchema, IMPORT_TIMETABLE_SHAPE, args);
  const semester: Semester | null = ctx.semester;
  const rows: TimetableRow[] = [];
  input.rows.forEach((raw, index) => {
    const fail = (field: string, reason: string): Error => {
      return new Error(`import_timetable: row ${index + 1}, field "${field}": ${reason}`);
    };
    if (typeof raw.course !== 'string' || raw.course.trim() === '') {
      throw fail('course', 'must be a non-empty string');
    }
    const course = raw.course.trim();
    if (typeof raw.weekday !== 'number') throw fail('weekday', 'must be an ISO weekday number 1..7');
    const weekday = raw.weekday;
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw fail('weekday', `must be an ISO weekday 1 (Monday) .. 7 (Sunday), got ${String(weekday)}`);
    }
    assertWeekday(weekday);
    if (typeof raw.start !== 'string') throw fail('start', 'must be an HH:mm string');
    const startText = raw.start.trim();
    const start = parseRowClock(startText);
    if (start === null) throw fail('start', `must be HH:mm, got "${startText}"`);
    if (typeof raw.end !== 'string') throw fail('end', 'must be an HH:mm string');
    const endText = raw.end.trim();
    const end = parseRowClock(endText);
    if (end === null) throw fail('end', `must be HH:mm, got "${endText}"`);
    if (start.hour * 60 + start.minute >= end.hour * 60 + end.minute) {
      throw fail('end', `must be after start (${startText}-${endText})`);
    }
    let weeks: string;
    if (raw.weeks === undefined || raw.weeks === '') {
      if (semester === null) throw fail('weeks', 'is required when no semester is configured (e.g. "1-16")');
      weeks = `1-${semester.totalWeeks}`;
    } else {
      if (typeof raw.weeks !== 'string') throw fail('weeks', 'must be a string');
      weeks = raw.weeks.trim();
      try {
        parseWeeksSpec(weeks);
      } catch (error) {
        throw fail('weeks', `cannot read "${weeks}": ${messageOf(error)}`);
      }
    }
    if (raw.teacher !== undefined && typeof raw.teacher !== 'string') throw fail('teacher', 'must be a string');
    const teacher = typeof raw.teacher === 'string' ? raw.teacher.trim() : undefined;
    if (raw.location !== undefined && typeof raw.location !== 'string') throw fail('location', 'must be a string');
    const location = typeof raw.location === 'string' ? raw.location.trim() : undefined;
    const row: TimetableRow = {
      id: ctx.newId(),
      course,
      weekday,
      start: startText,
      end: endText,
      weeks,
    };
    if (teacher !== undefined && teacher !== '') row.teacher = teacher;
    if (location !== undefined && location !== '') row.location = location;
    rows.push(row);
  });
  const warnings = (input.warnings ?? []).map((warning) => warning.trim()).filter((warning) => warning !== '');
  const count = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
  const semesterNote =
    semester === null
      ? ' No semester is configured yet, so the user must set the teaching calendar before confirming.'
      : '';
  return {
    summary: `Prepared a timetable preview with ${count}; the user confirms or edits it in the import card.${semesterNote}`,
    artifacts: [{ kind: 'timetable', rows, warnings }],
  };
}

/** The tool set exposed to the model. Write tools dry-run on `ctx.state`. */
export function createTools(): Tool[] {
  return [
    {
      definition: {
        name: 'get_agenda',
        description:
          'List blocks and recurring occurrences in a date range. Use it before creating or moving an event to spot conflicts, to answer "what does my day look like", and to copy block or node ids for update/cancel tools.',
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
        description:
          'Find tasks by keyword, deadline, completion and path. Returns task ids used by get_task, update_task, complete_task, move_node and delete_node.',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Case-insensitive match on name or note.' },
            include_completed: { type: 'boolean', description: 'Also return completed tasks (default false).' },
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
        description:
          'Inspect one task with its ancestors, children, reminders and linked calendar block. Call it before editing an ambiguous task so the change targets the right node.',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string', description: 'Node id from search_tasks, get_tree or suggest_tasks.' } },
          required: ['task_id'],
        },
      },
      run: (args, ctx) => runGetTask(args, ctx),
    },
    {
      definition: {
        name: 'get_tree',
        description:
          'Show the workspace tree as text with node ids and completion marks. Use it to understand structure before moving or deleting nodes, or when the user refers to a folder.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Scope path, e.g. /tmp or / (default /).' },
            depth: { type: 'integer', minimum: 1, maximum: 20, description: 'Levels to show below the scope (default 3).' },
            include_completed: { type: 'boolean', description: 'Also list completed nodes (default false).' },
          },
          required: [],
        },
      },
      run: (args, ctx) => runGetTree(args, ctx),
    },
    {
      definition: {
        name: 'list_rules',
        description:
          'List recurring calendar rules with ids, weekdays, time range, first and last date, and note. Use it to find a rule before editing or cancelling it.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      run: (args, ctx) => runListRules(args, ctx),
    },
    {
      definition: {
        name: 'find_free_slots',
        description:
          'Free intervals of at least min_minutes inside the 08:00-23:00 local working window of a day. Use it for day planning before recommending a time.',
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
        description:
          'Rank actionable tasks: overdue first, then deadline proximity, then tasks without a deadline. Use it in day planning together with get_agenda and find_free_slots.',
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
          'Create a one-off event: a node under /events, its linked calendar block and an explicit reminder. Requires a concrete date and start time; call ask_user first when either is missing. Use get_agenda first when the time could collide.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title; also the node name.' },
            date: { type: 'string', description: 'Event day, YYYY-MM-DD.' },
            start_time: { type: 'string', description: 'Start time, HH:mm (24h).' },
            end_time: { type: 'string', description: 'End time, HH:mm (24h), after start_time; for a start-only request pass one hour after start_time.' },
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
        description:
          'Create one task node, optionally with a deadline and a reminder. Use create_tasks instead when the user lists several items at once.',
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
        name: 'create_tasks',
        description:
          'Create several task nodes in one atomic call (1..30 items). If any item is invalid the whole batch is rejected and nothing is created, so fix the reported item and retry. Use it for screenshots, notices and lists of action items.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_TASKS_PER_BATCH,
              description: 'Task items with the same shape as create_task.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Task title.' },
                  parent_path: { type: 'string', description: 'Parent display path (default /tmp).' },
                  note: { type: 'string', description: 'Short quote or context from the source.' },
                  due_date: { type: 'string', description: 'Deadline day, YYYY-MM-DD.' },
                  due_time: { type: 'string', description: 'Deadline time, HH:mm (default 23:59).' },
                  remind_minutes_before: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Reminder minutes before the deadline; requires due_date.',
                  },
                },
                required: ['title'],
              },
            },
          },
          required: ['tasks'],
        },
      },
      run: (args, ctx) => runCreateTasks(args, ctx),
    },
    {
      definition: {
        name: 'create_recurring',
        description:
          'Create one weekly calendar rule for explicit weekdays and a time range. Only for a single weekly rule the user described; for a timetable grid use import_timetable instead (never create one rule per cell).',
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
        description:
          'Patch an existing block and its helper node: title, date, time range or reminder. Resolve the event id with get_agenda first and mention the old → new time in the reply.',
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
        name: 'update_task',
        description:
          'Patch one task: title, note, deadline or deadline reminder. Use it to reschedule or rename instead of recreating the task. Pass due_date (with optional due_time) to move the deadline; the reminder tied to the old deadline moves with it. clear_deadline removes the deadline and its reminder.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Node id from search_tasks, get_task or get_tree.' },
            title: { type: 'string', description: 'New task name (also renames its deadline reminder).' },
            note: { type: 'string', description: 'New note; an empty string clears it.' },
            due_date: { type: 'string', description: 'New deadline day, YYYY-MM-DD.' },
            due_time: { type: 'string', description: 'New deadline time, HH:mm (requires due_date, or an existing deadline).' },
            clear_deadline: { type: 'boolean', description: 'Remove the deadline together with its reminder.' },
            remind_minutes_before: {
              type: 'integer',
              minimum: 0,
              description: 'Replace the deadline reminder with one this many minutes before (0 removes it).',
            },
          },
          required: ['task_id'],
        },
      },
      run: (args, ctx) => runUpdateTask(args, ctx),
    },
    {
      definition: {
        name: 'complete_task',
        description:
          'Mark a task (or an event node) completed, or reopen it. Completing a parent requires all of its children to be completed first.',
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
        description:
          'Remove an event block and its helper node. Rejected when the helper node has children; ask the user how to handle them first.',
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
    {
      definition: {
        name: 'cancel_recurring',
        description:
          'Delete one recurring calendar rule and its occurrences. Resolve the rule id with list_rules first; an unknown id is an error. This cannot restore single skipped occurrences.',
        parameters: {
          type: 'object',
          properties: { rule_id: { type: 'string', description: 'Rule id from list_rules.' } },
          required: ['rule_id'],
        },
      },
      run: (args, ctx) => runCancelRecurring(args, ctx),
    },
    {
      definition: {
        name: 'move_node',
        description:
          'Move a node (with its subtree) under another folder. The target path must exist. Moving a node into its own subtree is rejected.',
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'Node id from search_tasks or get_tree.' },
            parent_path: { type: 'string', description: 'Destination folder display path, e.g. /tmp or /.' },
          },
          required: ['node_id', 'parent_path'],
        },
      },
      run: (args, ctx) => runMoveNode(args, ctx),
    },
    {
      definition: {
        name: 'delete_node',
        description:
          'Delete a node permanently. Refused when the node has children unless with_children is true, and refused when a calendar block links it (cancel the event first). Confirm destructive deletes with the user via ask_user.',
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'Node id from search_tasks or get_tree.' },
            with_children: { type: 'boolean', description: 'true = delete the whole subtree (default false).' },
          },
          required: ['node_id'],
        },
      },
      run: (args, ctx) => runDeleteNode(args, ctx),
    },
    {
      definition: {
        name: 'import_timetable',
        description:
          'Prepare an editable timetable preview from extracted class rows. Pass every course × weekday × time × week row in ONE call; the tool validates each row and returns a preview card, it writes nothing. The user confirms or edits the card afterwards. Never use create_recurring for a timetable grid.',
        parameters: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_TIMETABLE_ROWS,
              description: 'Extracted class rows; a bad row fails the call with its 1-based index and field.',
              items: {
                type: 'object',
                properties: {
                  course: { type: 'string', description: 'Course name exactly as printed.' },
                  weekday: { type: 'integer', minimum: 1, maximum: 7, description: 'ISO weekday (1=Monday .. 7=Sunday).' },
                  start: { type: 'string', description: 'Start time, HH:mm.' },
                  end: { type: 'string', description: 'End time, HH:mm.' },
                  weeks: {
                    type: 'string',
                    description:
                      'Teaching weeks, e.g. 1-16, 1-16单, 2-16双. Required when no semester is configured; otherwise defaults to the whole semester (1-<totalWeeks>).',
                  },
                  teacher: { type: 'string', description: 'Optional teacher as printed.' },
                  location: { type: 'string', description: 'Optional location as printed.' },
                },
                required: ['course', 'weekday', 'start', 'end'],
              },
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              description: 'Anything unreadable or ambiguous that the user should review in the card.',
            },
          },
          required: ['rows'],
        },
      },
      run: (args, ctx) => runImportTimetable(args, ctx),
    },
    {
      definition: {
        name: 'ask_user',
        description:
          'Ask the human one short question and pause the turn until they answer. Use this instead of asking in prose whenever a required detail is missing or two readings are plausible. Provide 2-5 short options; omit options only when a free-text answer is needed. Ask one question at a time.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One short question, in the user’s language.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 5,
              description: 'Short answer buttons (2-5), one of which may be "use the default". Omit for free text.',
            },
          },
          required: ['question'],
        },
      },
      run: (args, ctx) => runAskUser(args, ctx),
    },
  ];
}
