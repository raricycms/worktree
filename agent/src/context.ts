import {
  DAY_MS,
  civilFromTimestamp,
  dayFromTimestamp,
  endOfCivilDay,
  formatCivilDate,
  startOfCivilDay,
  weekdayFromDays,
} from '@worktree/core';
import type { Timestamp, WorktreeState } from '@worktree/core';
import { dateStringOfDay, firstMondayDay, semesterDayRange, weekOfSemesterDay } from './semester';
import { agendaItems, freeSlots, taskSummaries } from './read';
import type { AgendaItem, Semester, TaskSummary } from './types';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_MAX_TASKS = 25;
/** Safety cap that is far above any real tree, used to read the open-task list once. */
const ALL_TASKS = 1_000_000;
const FREE_SLOT_MINUTES = 30;
const DUE_SOON_DAYS = 7;

export interface BuildSnapshotOptions {
  state: WorktreeState;
  now: number;
  tzOffset: number;
  semester: Semester | null;
  /** Maximum number of pending tasks listed; default 25. */
  maxTasks?: number;
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

function formatUtcOffset(tzOffset: number): string {
  const sign = tzOffset < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(tzOffset) / 60000);
  return `UTC${sign}${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

function semesterLine(semester: Semester | null, today: number): string {
  if (semester === null) return 'Semester: none configured';
  const week = weekOfSemesterDay(semester, today);
  if (week < 1) return `Semester: starts ${dateStringOfDay(firstMondayDay(semester))} (today is before week 1)`;
  if (week > semester.totalWeeks) {
    const range = semesterDayRange(semester);
    return `Semester: ended ${dateStringOfDay(range.toDay)} (today is after week ${semester.totalWeeks})`;
  }
  return `Semester: teaching week ${week} of ${semester.totalWeeks}`;
}

function agendaLine(item: AgendaItem, tzOffset: number): string {
  const range = `${formatClock(item.start, tzOffset)}-${formatClock(item.end, tzOffset)}`;
  const state = item.status ? ' (completed)' : '';
  return `- ${range} ${item.name} [${item.kind} ${item.id}]${state}`;
}

function freeLine(slots: ReturnType<typeof freeSlots>, tzOffset: number): string {
  if (slots.length === 0) return `Free today: no gap of ${FREE_SLOT_MINUTES} minutes or more`;
  const text = slots
    .map((slot) => `${formatClock(slot.start, tzOffset)}-${formatClock(slot.end, tzOffset)} (${slot.minutes} min)`)
    .join(', ');
  return `Free today: ${text}`;
}

function taskLine(task: TaskSummary, tzOffset: number): string {
  const deadline = task.deadline === undefined ? 'no deadline' : `due ${formatDateTime(task.deadline, tzOffset)}`;
  const open = task.openChildren === 0 ? '' : ` (${task.openChildren} open children)`;
  return `- [${task.id}] ${task.name} — ${deadline} — ${task.path}${open}`;
}

function takeSection(title: string, tasks: TaskSummary[], budget: { left: number }, tzOffset: number): string | null {
  if (tasks.length === 0) return null;
  const shown = tasks.slice(0, budget.left);
  budget.left -= shown.length;
  const lines = shown.map((task) => taskLine(task, tzOffset));
  if (shown.length < tasks.length) lines.push(`- ... ${tasks.length - shown.length} more`);
  return `${title}:\n${lines.join('\n')}`;
}

/**
 * A compact, deterministic text snapshot for the system prompt: local time,
 * semester week, today's agenda, free time, due/overdue tasks and pending
 * counts. Never the whole tree.
 */
export function buildContextSnapshot(opts: BuildSnapshotOptions): string {
  const { state, now, tzOffset, semester } = opts;
  const maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error(`maxTasks must be a positive integer: ${maxTasks}`);

  const today = dayFromTimestamp(now, tzOffset);
  const todayStart = startOfCivilDay(today, tzOffset);
  const todayEnd = endOfCivilDay(today, tzOffset);
  const todayDate = formatCivilDate(civilFromTimestamp(now, tzOffset).date);

  const openTasks = taskSummaries(state, { now, limit: ALL_TASKS });
  const overdue = openTasks.filter((task) => task.deadline !== undefined && task.deadline < now);
  const dueToday = openTasks.filter(
    (task) => task.deadline !== undefined && task.deadline >= todayStart && task.deadline <= todayEnd,
  );
  const weekEnd = todayEnd + DUE_SOON_DAYS * DAY_MS;
  const dueSoon = openTasks.filter(
    (task) => task.deadline !== undefined && task.deadline > todayEnd && task.deadline <= weekEnd,
  );

  const lines: string[] = [];
  lines.push('## Workspace context');
  lines.push(
    `Local time: ${todayDate} ${formatClock(now, tzOffset)} ${WEEKDAY_NAMES[weekdayFromDays(today)]} (${formatUtcOffset(tzOffset)})`,
  );
  lines.push(semesterLine(semester, today));
  lines.push(
    `Pending: ${openTasks.length} open tasks (${overdue.length} overdue, ${dueToday.length} due today, ${dueSoon.length} due within ${DUE_SOON_DAYS} days)`,
  );

  const agenda = agendaItems(state, todayStart, todayEnd + 1);
  if (agenda.length === 0) {
    lines.push(`Today (${todayDate}): nothing scheduled`);
  } else {
    lines.push(`Today (${todayDate}):`);
    for (const item of agenda) lines.push(agendaLine(item, tzOffset));
  }
  lines.push(freeLine(freeSlots(state, today, tzOffset, FREE_SLOT_MINUTES), tzOffset));

  const budget = { left: maxTasks };
  const sections = [
    takeSection('Overdue', overdue, budget, tzOffset),
    takeSection('Due today', dueToday, budget, tzOffset),
    takeSection(`Due within ${DUE_SOON_DAYS} days`, dueSoon, budget, tzOffset),
  ];
  lines.push(...sections.filter((section): section is string => section !== null));

  return lines.join('\n');
}
