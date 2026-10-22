import {
  DAY_MS,
  ROOT_ID,
  civilFromTimestamp,
  dayFromTimestamp,
  displayPathOf,
  endOfCivilDay,
  formatCivilDate,
} from '@worktree/core';
import type { Node, Timestamp, WorktreeState } from '@worktree/core';
import { dayOfDateString } from './semester';
import type { Suggestion } from './types';

const HOUR_MS = 60 * 60 * 1000;
const DUE_SOON_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 5;
/**
 * Score bands keep the category order fixed: an overdue task always outranks a
 * task with a deadline, which always outranks a task without one. Within a band
 * the order follows deadline proximity.
 */
const OVERDUE_BASE = 100_000;
const DEADLINE_BASE = 10_000;

export interface SuggestOptions {
  state: WorktreeState;
  now: Timestamp;
  tzOffset: number;
  /** Restrict to a civil date (defaults to today). */
  date?: string;
  /** Only suggest tasks that fit in this much free time. */
  availableMinutes?: number;
  limit?: number;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatClock(ms: Timestamp, tzOffset: number): string {
  const { time } = civilFromTimestamp(ms, tzOffset);
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

function formatDateTime(ms: Timestamp, tzOffset: number): string {
  const { date } = civilFromTimestamp(ms, tzOffset);
  return `${formatCivilDate(date)} ${formatClock(ms, tzOffset)}`;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareDeadline(a: Timestamp | undefined, b: Timestamp | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function scoreAndReason(node: Node, now: Timestamp, tzOffset: number): { score: number; reason: string } {
  const deadline = node.deadline;
  if (deadline === undefined) return { score: 0, reason: 'no deadline' };
  if (deadline < now) {
    const overdueDays = Math.min(Math.floor((now - deadline) / DAY_MS), 999);
    return {
      score: OVERDUE_BASE + overdueDays,
      reason: `overdue since ${formatDateTime(deadline, tzOffset)}`,
    };
  }
  const remaining = deadline - now;
  const closeness = Math.max(0, Math.floor((DUE_SOON_MS - remaining) / HOUR_MS));
  const nowDay = dayFromTimestamp(now, tzOffset);
  const deadlineDay = dayFromTimestamp(deadline, tzOffset);
  let reason: string;
  if (deadlineDay === nowDay) {
    reason = `due today ${formatClock(deadline, tzOffset)}`;
  } else if (deadlineDay === nowDay + 1) {
    reason = `due tomorrow ${formatClock(deadline, tzOffset)}`;
  } else {
    reason = `due ${formatDateTime(deadline, tzOffset)}`;
  }
  return { score: DEADLINE_BASE + closeness, reason };
}

/**
 * Deterministic ranking of actionable leaf tasks: overdue first, then deadline
 * proximity, then a small bonus for work that fits the available time. The
 * model phrases the result; it never invents the ranking.
 *
 * `availableMinutes` is accepted for a future duration model. Tasks carry no
 * duration estimate, so it cannot filter or score anything yet and is ignored.
 */
export function suggestTasks(opts: SuggestOptions): Suggestion[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer: ${limit}`);
  if (opts.availableMinutes !== undefined && (!Number.isInteger(opts.availableMinutes) || opts.availableMinutes < 1)) {
    throw new Error(`available_minutes must be a positive integer: ${opts.availableMinutes}`);
  }

  // A date restricts the horizon to the end of that day; without one every open
  // leaf is a candidate and future deadlines rank by proximity below overdue.
  const cutoff = opts.date === undefined ? undefined : endOfCivilDay(dayOfDateString(opts.date), opts.tzOffset);

  const suggestions: Suggestion[] = [];
  const visit = (node: Node): void => {
    for (const child of node.children) visit(child);
    if (node.id === ROOT_ID) return;
    if (node.children.length > 0) return;
    if (node.status) return;
    if (cutoff !== undefined && node.deadline !== undefined && node.deadline > cutoff) return;
    const path = displayPathOf(opts.state.tree, node.id);
    if (path === null) throw new Error(`invariant: node ${node.id} has no display path`);
    const { score, reason } = scoreAndReason(node, opts.now, opts.tzOffset);
    suggestions.push({
      taskId: node.id,
      name: node.name,
      path,
      deadline: node.deadline,
      score,
      reason,
    });
  };
  visit(opts.state.tree.getRoot());

  suggestions.sort(
    (a, b) =>
      b.score - a.score ||
      compareDeadline(a.deadline, b.deadline) ||
      compareText(a.name, b.name) ||
      compareText(a.taskId, b.taskId),
  );
  return suggestions.slice(0, limit);
}
