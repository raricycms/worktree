import type { Node } from '@worktree/core';

/**
 * Pure helpers for the tree page's daily loop: which open nodes are due today
 * (or already overdue), how to bucket their remaining time, and which
 * descendants must be completed before a parent can be. No React and no DOM,
 * so the rules are unit-testable on their own.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The unit a relative time is expressed in; the full key lives in i18n. */
export type RelativeUnit = 'minutes' | 'hours' | 'days';

export interface RelativeTime {
  /** 'due' means the deadline is still ahead, 'overdue' that it has passed. */
  kind: 'due' | 'overdue';
  unit: RelativeUnit;
  /** Whole units, never 0: a deadline seconds away still reads "1m". */
  amount: number;
}

export interface DueEntry {
  node: Node;
  relative: RelativeTime;
}

/** Local midnight of the civil day containing `ms` (DST-safe: built from fields). */
export function civilDayStart(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whether `deadlineMs` falls on the local civil day of `nowMs` or an earlier one. */
export function isDueByToday(deadlineMs: number, nowMs: number): boolean {
  return civilDayStart(deadlineMs) <= civilDayStart(nowMs);
}

/**
 * Buckets the distance between `nowMs` and `deadlineMs`: full days win, then
 * full hours, otherwise minutes. The magnitude is floored but clamped to 1, so
 * the label never reads "0m" for something that has not happened yet.
 */
export function relativeTime(deadlineMs: number, nowMs: number): RelativeTime {
  const delta = deadlineMs - nowMs;
  const kind = delta < 0 ? 'overdue' : 'due';
  const distance = Math.abs(delta);
  if (distance >= DAY_MS) {
    return { kind, unit: 'days', amount: Math.max(1, Math.floor(distance / DAY_MS)) };
  }
  if (distance >= HOUR_MS) {
    return { kind, unit: 'hours', amount: Math.max(1, Math.floor(distance / HOUR_MS)) };
  }
  return { kind, unit: 'minutes', amount: Math.max(1, Math.floor(distance / MINUTE_MS)) };
}

function byDeadline(a: DueEntry, b: DueEntry): number {
  const deadlineA = a.node.deadline ?? Number.POSITIVE_INFINITY;
  const deadlineB = b.node.deadline ?? Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA - deadlineB;
  // Same-ms deadlines keep a stable order so the list never reshuffles between
  // renders: name first, then id (ids are unique).
  if (a.node.name !== b.node.name) return a.node.name < b.node.name ? -1 : 1;
  if (a.node.id === b.node.id) return 0;
  return a.node.id < b.node.id ? -1 : 1;
}

/**
 * Open nodes of the whole tree whose deadline is today (local civil day) or
 * earlier, earliest deadline first. The workspace root is never a task row.
 */
export function dueToday(root: Node, nowMs: number): DueEntry[] {
  const entries: DueEntry[] = [];
  const walk = (node: Node): void => {
    for (const child of node.children) {
      const deadline = child.deadline;
      if (!child.status && deadline !== undefined && isDueByToday(deadline, nowMs)) {
        entries.push({ node: child, relative: relativeTime(deadline, nowMs) });
      }
      walk(child);
    }
  };
  walk(root);
  return entries.sort(byDeadline);
}

/**
 * Children-first ids of every uncompleted descendant of `node`. Completing
 * them in this order is always valid, so `node` itself can be completed last;
 * this mirrors the detail panel's cascade.
 */
export function uncompletedDescendants(node: Node): string[] {
  const ids: string[] = [];
  for (const child of node.children) {
    ids.push(...uncompletedDescendants(child));
    if (!child.status) ids.push(child.id);
  }
  return ids;
}
