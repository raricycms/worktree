import { ROOT_ID, displayPathOf, startOfCivilDay } from '@worktree/core';
import type { Node, Timestamp, WorktreeState } from '@worktree/core';
import type { AgendaItem, FreeSlot, TaskDetail, TaskSummary } from './types';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 23;
const DEFAULT_MIN_FREE_MINUTES = 30;
const DEFAULT_TASK_LIMIT = 20;

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Ascending deadline, nodes without a deadline last. */
function compareDeadline(a: Timestamp | undefined, b: Timestamp | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/** Standalone blocks and rule occurrences overlapping `[from, to)`, sorted by start. */
export function agendaItems(state: WorktreeState, from: Timestamp, to: Timestamp): AgendaItem[] {
  if (to <= from) return [];
  const items: AgendaItem[] = [];
  for (const block of state.calendar.getBlocks()) {
    if (block.start >= to || block.end <= from) continue;
    items.push({
      kind: 'block',
      id: block.id,
      name: block.name,
      start: block.start,
      end: block.end,
      status: block.status,
      note: block.note,
      nodeId: block.nodeId,
    });
  }
  for (const occurrence of state.calendar.expand(from, to)) {
    items.push({
      kind: 'occurrence',
      id: occurrence.id,
      name: occurrence.name,
      start: occurrence.occStart,
      end: occurrence.occEnd,
      // Occurrences are derived from a rule, so they carry no completion state.
      status: false,
      note: occurrence.note,
      ruleId: occurrence.ruleId,
    });
  }
  items.sort((a, b) => a.start - b.start || compareText(a.id, b.id));
  return items;
}

/** A live, non-root node; the root is a container, never a task. */
export function findNodeById(state: WorktreeState, id: string): Node | undefined {
  if (id === ROOT_ID) return undefined;
  return state.tree.getNode(id);
}

/** Resolves a display path like `/tmp/report`; null when it does not exist. */
export function findNodeByPath(state: WorktreeState, path: string): Node | undefined {
  if (!path.startsWith('/')) throw new Error(`path must start with "/": ${path}`);
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  let node = state.tree.getRoot();
  for (const segment of segments) {
    const child = node.children.find((candidate) => candidate.name === segment);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

/** The display path of a live node, or null when it is gone. */
export function nodePath(state: WorktreeState, id: string): string | null {
  return displayPathOf(state.tree, id);
}

function toSummary(state: WorktreeState, node: Node): TaskSummary {
  const path = displayPathOf(state.tree, node.id);
  if (path === null) throw new Error(`invariant: node ${node.id} has no display path`);
  return {
    id: node.id,
    name: node.name,
    path,
    status: node.status,
    note: node.note,
    deadline: node.deadline,
    reminders: node.reminders.length,
    openChildren: node.children.filter((child) => !child.status).length,
  };
}

/**
 * Matching nodes with their path, deadline, status and id. Ordered by
 * (deadline, name, id), so callers and the model always see the same list for
 * the same state. `limit` defaults to 20.
 */
export function taskSummaries(
  state: WorktreeState,
  opts: {
    keyword?: string;
    includeCompleted?: boolean;
    overdueOnly?: boolean;
    dueWithinDays?: number;
    path?: string;
    limit?: number;
    now?: Timestamp;
  } = {},
): TaskSummary[] {
  const now = opts.now ?? Date.now();
  const includeCompleted = opts.includeCompleted ?? false;
  const limit = opts.limit ?? DEFAULT_TASK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer: ${limit}`);
  const dueWithinDays = opts.dueWithinDays;
  if (dueWithinDays !== undefined && (!Number.isInteger(dueWithinDays) || dueWithinDays < 0)) {
    throw new Error(`due_within_days must be a non-negative integer: ${dueWithinDays}`);
  }
  const dueCutoff = dueWithinDays === undefined ? undefined : now + dueWithinDays * 24 * HOUR_MS;
  const trimmedKeyword = opts.keyword?.trim().toLowerCase();
  const keyword = trimmedKeyword === '' ? undefined : trimmedKeyword;

  let scope: Node;
  if (opts.path === undefined) {
    scope = state.tree.getRoot();
  } else {
    const resolved = findNodeByPath(state, opts.path);
    if (resolved === undefined) throw new Error(`unknown path: ${opts.path}`);
    scope = resolved;
  }

  const matches = (node: Node): boolean => {
    if (node.id === ROOT_ID) return false;
    if (!includeCompleted && node.status) return false;
    if (opts.overdueOnly === true && (node.status || node.deadline === undefined || node.deadline >= now)) return false;
    if (dueCutoff !== undefined && (node.deadline === undefined || node.deadline > dueCutoff)) return false;
    if (keyword !== undefined && !node.name.toLowerCase().includes(keyword) && !node.note.toLowerCase().includes(keyword)) {
      return false;
    }
    return true;
  };

  const summaries: TaskSummary[] = [];
  const visit = (node: Node): void => {
    if (matches(node)) summaries.push(toSummary(state, node));
    for (const child of node.children) visit(child);
  };
  visit(scope);

  summaries.sort(
    (a, b) =>
      compareDeadline(a.deadline, b.deadline) || compareText(a.name, b.name) || compareText(a.id, b.id),
  );
  return summaries.slice(0, limit);
}

export function taskDetail(state: WorktreeState, id: string): TaskDetail | null {
  const node = findNodeById(state, id);
  if (node === undefined) return null;

  const ancestors: { id: string; name: string }[] = [];
  let parentId = state.tree.getParentId(node.id);
  while (parentId !== undefined && parentId !== ROOT_ID) {
    const parent = state.tree.getNode(parentId);
    if (parent === undefined) break;
    ancestors.unshift({ id: parent.id, name: parent.name });
    parentId = state.tree.getParentId(parent.id);
  }

  const block = state.calendar.getBlocks().find((candidate) => candidate.nodeId === node.id);
  return {
    task: toSummary(state, node),
    ancestors,
    children: node.children.map((child) => toSummary(state, child)),
    reminders: node.reminders.map((reminder) => ({
      id: reminder.id,
      deadline: reminder.deadline,
      active: reminder.active,
      auto: reminder.auto,
    })),
    block: block === undefined ? undefined : { id: block.id, name: block.name, start: block.start, end: block.end },
  };
}

interface Interval {
  start: Timestamp;
  end: Timestamp;
}

/** The busy intervals of the day, clipped to the working window and merged. */
function busyIntervals(state: WorktreeState, windowStart: Timestamp, windowEnd: Timestamp): Interval[] {
  const clipped: Interval[] = [];
  for (const item of agendaItems(state, windowStart, windowEnd)) {
    const start = Math.max(item.start, windowStart);
    const end = Math.min(item.end, windowEnd);
    if (end > start) clipped.push({ start, end });
  }
  clipped.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Interval[] = [];
  for (const interval of clipped) {
    const last: Interval | undefined = merged[merged.length - 1];
    if (last === undefined) {
      merged.push({ ...interval });
    } else if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Free intervals of `minMinutes` or more inside the 08:00–23:00 local working
 * window of `day`. Completed blocks still occupy their time: the block was
 * scheduled either way, and free-slot advice must not double-book it.
 */
export function freeSlots(state: WorktreeState, day: number, tzOffset: number, minMinutes = DEFAULT_MIN_FREE_MINUTES): FreeSlot[] {
  if (!Number.isInteger(minMinutes) || minMinutes < 1) {
    throw new Error(`min_minutes must be a positive integer: ${minMinutes}`);
  }
  const dayStart = startOfCivilDay(day, tzOffset);
  const windowStart = dayStart + WORK_START_HOUR * HOUR_MS;
  const windowEnd = dayStart + WORK_END_HOUR * HOUR_MS;
  const minimum = minMinutes * MINUTE_MS;
  if (windowEnd - windowStart < minimum) return [];

  const slots: FreeSlot[] = [];
  let cursor = windowStart;
  for (const busy of busyIntervals(state, windowStart, windowEnd)) {
    if (busy.start - cursor >= minimum) {
      slots.push({ start: cursor, end: busy.start, minutes: (busy.start - cursor) / MINUTE_MS });
    }
    cursor = Math.max(cursor, busy.end);
  }
  if (windowEnd - cursor >= minimum) {
    slots.push({ start: cursor, end: windowEnd, minutes: (windowEnd - cursor) / MINUTE_MS });
  }
  return slots;
}
