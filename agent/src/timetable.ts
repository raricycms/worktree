import {
  DAY_MS,
  endOfCivilDay,
  startOfCivilDay,
  timestampFromCivil,
  validateRule,
} from '@worktree/core';
import type {
  Block,
  BlockOccurrence,
  BlockRule,
  CivilDate,
  CivilTime,
  Operation,
  Timestamp,
  WorktreeState,
} from '@worktree/core';
import type {
  DateString,
  Semester,
  TimetableCourse,
  TimetableDraft,
  TimetablePlan,
  TimetableRow,
  TimetableRowView,
  Weekday,
} from './types';
import { dateStringOfDay, semesterDayRange, semesterWeekDate, semesterWeekDay, validateSemester } from './semester';
import { formatWeeksSpec, groupWeekRuns, parseWeeksSpec } from './weeks';
import type { WeekRun } from './weeks';

const MINUTE_MS = 60 * 1000;

/** Flattens an extraction draft into editable preview rows (deterministic ids). */
export function draftToRows(draft: TimetableDraft): TimetableRow[] {
  const rows: TimetableRow[] = [];
  draft.courses.forEach((course, courseIndex) => {
    const teacher = normalizeOptional(course.teacher);
    const location = normalizeOptional(course.location);
    const name = course.name.trim();
    course.sessions.forEach((session, sessionIndex) => {
      const row: TimetableRow = {
        id: `c${courseIndex + 1}-s${sessionIndex + 1}`,
        course: name,
        weekday: session.weekday,
        start: session.start.trim(),
        end: session.end.trim(),
        weeks: session.weeks.trim(),
      };
      if (teacher !== undefined) row.teacher = teacher;
      if (location !== undefined) row.location = location;
      rows.push(row);
    });
  });
  return rows;
}

/** Resolves weeks, first/last dates and conflicts for every row. */
export function analyzeTimetableRows(
  rows: TimetableRow[],
  opts: { semester: Semester; tzOffset: number; state?: WorktreeState },
): TimetableRowView[] {
  const semesterProblem = problemOf(() => validateSemester(opts.semester));
  const offsetProblem = problemOf(() => assertTzOffset(opts.tzOffset));
  const globalProblems: string[] = [];
  if (semesterProblem !== null) globalProblems.push(`invalid semester: ${semesterProblem}`);
  if (offsetProblem !== null) globalProblems.push(offsetProblem);

  // The analysis is the preview: it must describe broken rows, never abort the
  // whole table because one row (or the semester) is wrong.
  const scans = rows.map((row) => scanRow(row, semesterProblem === null ? opts.semester : null));
  const problems = scans.map((scan) => [...globalProblems, ...scan.problems]);

  addPreviewOverlaps(rows, scans, problems);

  if (opts.state !== undefined && semesterProblem === null && offsetProblem === null) {
    addCalendarOverlaps(scans, problems, opts.semester, opts.tzOffset, opts.state);
  }

  return rows.map((row, index) => ({
    row,
    weeksList: scans[index].weeks,
    firstDate: scans[index].firstDate,
    lastDate: scans[index].lastDate,
    conflicts: problems[index],
  }));
}

/**
 * Converts confirmed rows into `add_block_rule` ops (one per week run), and
 * reports rows whose identical rule already exists. Throws on invalid rows —
 * a broken preview must be fixed, never silently written.
 */
export function rowsToRules(
  rows: TimetableRow[],
  opts: { semester: Semester; tzOffset: number; newId: () => string; existingRules?: BlockRule[] },
): TimetablePlan {
  validateSemester(opts.semester);
  assertTzOffset(opts.tzOffset);

  const ops: Operation[] = [];
  const duplicates: TimetableRowView[] = [];
  const warnings: string[] = [];
  const existing = new Set<string>((opts.existingRules ?? []).map(ruleKey));
  const planned = new Set<string>();

  for (const row of rows) {
    const resolved = resolveRow(row, opts.semester);
    const runs = groupWeekRuns(resolved.weeks);
    const rowOps: Operation[] = [];
    let skippedExisting = 0;
    let skippedDuplicate = 0;

    for (const run of runs) {
      const rule = buildWeeklyRule(row, run, resolved, opts.semester, opts.tzOffset);
      const key = ruleKey(rule);
      if (existing.has(key)) {
        skippedExisting++;
        continue;
      }
      if (planned.has(key)) {
        skippedDuplicate++;
        continue;
      }
      planned.add(key);
      rowOps.push(ruleOp(rule, opts.newId()));
    }

    if (rowOps.length > 0) {
      ops.push(...rowOps);
      const skipped = skippedExisting + skippedDuplicate;
      if (skipped > 0) {
        warnings.push(`row ${rowLabel(row)}: skipped ${skipped} of ${runs.length} rules that already exist`);
      }
      continue;
    }

    duplicates.push({
      row,
      weeksList: resolved.weeks,
      firstDate: resolved.firstDate,
      lastDate: resolved.lastDate,
      conflicts: [],
    });
    warnings.push(
      `skipped row ${rowLabel(row)} (weeks ${row.weeks}): ${duplicateReason(skippedExisting, skippedDuplicate)}`,
    );
  }

  return { ops, duplicates, warnings };
}

/** Rows back to an extraction draft (round-trip for the preview and tests). */
export function rowsToDraft(rows: TimetableRow[]): TimetableDraft {
  const courses: TimetableCourse[] = [];
  const byCourse = new Map<string, TimetableCourse>();
  for (const row of rows) {
    const name = row.course.trim();
    const teacher = normalizeOptional(row.teacher);
    const location = normalizeOptional(row.location);
    const key = `${name}\u0000${teacher ?? ''}\u0000${location ?? ''}`;
    let course = byCourse.get(key);
    if (course === undefined) {
      course = { name, sessions: [] };
      if (teacher !== undefined) course.teacher = teacher;
      if (location !== undefined) course.location = location;
      byCourse.set(key, course);
      courses.push(course);
    }
    course.sessions.push({
      weekday: row.weekday,
      start: row.start,
      end: row.end,
      weeks: row.weeks,
    });
  }
  return { courses, warnings: [] };
}

/** `YYYY-MM-DD` for the first/last occurrence of a row (exposed for the UI). */
export function rowFirstDate(row: TimetableRow, semester: Semester, tzOffset: number): DateString {
  assertTzOffset(tzOffset);
  return resolveRow(row, semester).firstDate;
}

interface RowTime {
  start: CivilTime;
  end: CivilTime;
  startMs: number;
  endMs: number;
  duration: Timestamp;
}

/** One row, parsed as far as it parses; problem places stay `null`/empty. */
interface RowScan {
  weekday: Weekday | null;
  time: RowTime | null;
  weeks: number[];
  inRange: number[];
  firstDate: DateString;
  lastDate: DateString;
  problems: string[];
}

interface RowOccurrence {
  /** Civil day index of the occurrence in the injected offset. */
  day: number;
  start: Timestamp;
  end: Timestamp;
}

/** The parts of a weekly rule that identify it as a duplicate. */
interface RuleIdentity {
  freq: string;
  name: string;
  interval: number;
  startDate: CivilDate;
  timeOfDay: CivilTime;
  duration: Timestamp;
  until?: Timestamp;
  byDay?: number[];
}

/** A validated weekly rule before an id is assigned (ids are only minted for ops). */
interface TimetableRule extends RuleIdentity {
  freq: 'weekly';
  note: string;
  interval: 1 | 2;
  byDay: number[];
  until: Timestamp;
  tzOffset: number;
}

interface ResolvedRow {
  weekday: Weekday;
  timeOfDay: CivilTime;
  duration: Timestamp;
  weeks: number[];
  firstDate: DateString;
  lastDate: DateString;
}

function scanRow(row: TimetableRow, semester: Semester | null): RowScan {
  const problems: string[] = [];
  const scan: RowScan = {
    weekday: null,
    time: null,
    weeks: [],
    inRange: [],
    firstDate: '',
    lastDate: '',
    problems,
  };

  if (row.course.trim() === '') problems.push('course name is empty');

  const weekday = validWeekday(row.weekday);
  if (weekday === null) problems.push(`weekday out of range (1..7): ${String(row.weekday)}`);
  else scan.weekday = weekday;

  const start = parseTimeOfDay(row.start);
  const end = parseTimeOfDay(row.end);
  if (start === null) problems.push(`invalid start time "${row.start}" (expected HH:mm)`);
  if (end === null) problems.push(`invalid end time "${row.end}" (expected HH:mm)`);
  if (start !== null && end !== null) {
    const startMs = minutesOfTime(start) * MINUTE_MS;
    const endMs = minutesOfTime(end) * MINUTE_MS;
    if (startMs >= endMs) {
      problems.push(`start must be before end: ${formatTime(start)} >= ${formatTime(end)}`);
    } else {
      scan.time = { start, end, startMs, endMs, duration: endMs - startMs };
    }
  }

  try {
    scan.weeks = parseWeeksSpec(row.weeks);
  } catch (error) {
    problems.push(`invalid weeks "${row.weeks}": ${messageOf(error)}`);
  }

  if (semester !== null && scan.weeks.length > 0) {
    const outside = scan.weeks.filter((week) => week > semester.totalWeeks);
    if (outside.length > 0) problems.push(describeOutside(outside, semester.totalWeeks));
    scan.inRange = scan.weeks.filter((week) => week <= semester.totalWeeks);
    if (scan.weekday !== null && scan.inRange.length > 0) {
      const first = scan.inRange[0];
      const last = scan.inRange[scan.inRange.length - 1];
      scan.firstDate = dateStringOfDay(semesterWeekDay(semester, first, scan.weekday));
      scan.lastDate = dateStringOfDay(semesterWeekDay(semester, last, scan.weekday));
    }
  }

  return scan;
}

function addPreviewOverlaps(rows: TimetableRow[], scans: RowScan[], problems: string[][]): void {
  for (let left = 0; left < rows.length; left++) {
    for (let right = left + 1; right < rows.length; right++) {
      const leftScan = scans[left];
      const rightScan = scans[right];
      if (leftScan.weekday === null || rightScan.weekday === null) continue;
      if (leftScan.weekday !== rightScan.weekday) continue;
      if (leftScan.time === null || rightScan.time === null) continue;
      if (leftScan.time.startMs >= rightScan.time.endMs) continue;
      if (rightScan.time.startMs >= leftScan.time.endMs) continue;
      const shared = intersectWeeks(leftScan.weeks, rightScan.weeks);
      if (shared.length === 0) continue;
      // Identical rows produce identical rules; rowsToRules reports them as
      // duplicates, so flagging them as a conflict too would double-report.
      if (isSameRow(rows[left], rows[right], leftScan, rightScan)) continue;
      problems[left].push(`overlaps ${describeRow(rows[right], rightScan, shared)}`);
      problems[right].push(`overlaps ${describeRow(rows[left], leftScan, shared)}`);
    }
  }
}

function isSameRow(left: TimetableRow, right: TimetableRow, leftScan: RowScan, rightScan: RowScan): boolean {
  if (left.course.trim() !== right.course.trim()) return false;
  if (leftScan.weekday !== rightScan.weekday) return false;
  if (leftScan.time === null || rightScan.time === null) return false;
  if (leftScan.time.startMs !== rightScan.time.startMs) return false;
  if (leftScan.time.endMs !== rightScan.time.endMs) return false;
  return sameNumbers(leftScan.weeks, rightScan.weeks);
}

function describeRow(row: TimetableRow, scan: RowScan, weeks: number[]): string {
  const name = row.course.trim();
  const time =
    scan.time === null ? `${row.start.trim()}-${row.end.trim()}` : `${formatTime(scan.time.start)}-${formatTime(scan.time.end)}`;
  return `"${name === '' ? '(unnamed)' : name}" ${time} (weeks ${formatWeeksSpec(weeks)})`;
}

function addCalendarOverlaps(
  scans: RowScan[],
  problems: string[][],
  semester: Semester,
  tzOffset: number,
  state: WorktreeState,
): void {
  const { fromDay, toDay } = semesterDayRange(semester);
  const from = startOfCivilDay(fromDay, tzOffset);
  const to = endOfCivilDay(toDay, tzOffset) + 1;
  const live = state.calendar.expand(from, to);
  const blocks = state.calendar.getBlocks().filter((block) => block.start < to && block.end > from);

  scans.forEach((scan, index) => {
    if (scan.weekday === null || scan.time === null || scan.inRange.length === 0) return;
    const occurrences = rowOccurrences(scan.inRange, scan.weekday, scan.time, semester, tzOffset);
    problems[index].push(...describeCalendarOverlaps(scan, occurrences, live, blocks));
  });
}

function describeCalendarOverlaps(
  scan: RowScan,
  occurrences: RowOccurrence[],
  live: BlockOccurrence[],
  blocks: Block[],
): string[] {
  const messages: string[] = [];
  const range =
    scan.time === null ? '' : `${formatTime(scan.time.start)}-${formatTime(scan.time.end)}`;

  for (const block of blocks) {
    const hits = occurrences.filter((occurrence) => occurrence.start < block.end && occurrence.end > block.start);
    if (hits.length === 0) continue;
    const first = hits[0];
    messages.push(`overlaps existing block "${block.name}" on ${dateStringOfDay(first.day)} ${range}${moreSuffix(hits.length)}`);
  }

  const byRule = new Map<string, { name: string; first: RowOccurrence; count: number }>();
  for (const occurrence of live) {
    let first: RowOccurrence | undefined;
    let count = 0;
    for (const rowOccurrence of occurrences) {
      if (rowOccurrence.start < occurrence.occEnd && rowOccurrence.end > occurrence.occStart) {
        count++;
        if (first === undefined) first = rowOccurrence;
      }
    }
    if (first === undefined) continue;
    const entry = byRule.get(occurrence.ruleId);
    if (entry === undefined) byRule.set(occurrence.ruleId, { name: occurrence.name, first, count });
    else entry.count += count;
  }
  for (const entry of byRule.values()) {
    messages.push(
      `overlaps existing rule "${entry.name}" on ${dateStringOfDay(entry.first.day)} ${range}${moreSuffix(entry.count)}`,
    );
  }

  return messages;
}

function rowOccurrences(
  weeks: number[],
  weekday: Weekday,
  time: RowTime,
  semester: Semester,
  tzOffset: number,
): RowOccurrence[] {
  return weeks.map((week) => {
    const day = semesterWeekDay(semester, week, weekday);
    const start = day * DAY_MS - tzOffset + time.startMs;
    return { day, start, end: start + time.duration };
  });
}

function resolveRow(row: TimetableRow, semester: Semester): ResolvedRow {
  if (row.course.trim() === '') throw rowError(row, 'course name is empty');
  const weekday = requireWeekday(row);
  const start = requireTime(row, 'start', row.start);
  const end = requireTime(row, 'end', row.end);
  const startMs = minutesOfTime(start) * MINUTE_MS;
  const endMs = minutesOfTime(end) * MINUTE_MS;
  if (startMs >= endMs) throw rowError(row, `start must be before end: ${formatTime(start)} >= ${formatTime(end)}`);
  const weeks = requireWeeks(row, semester);
  const firstWeek = weeks[0];
  const lastWeek = weeks[weeks.length - 1];
  return {
    weekday,
    timeOfDay: start,
    duration: endMs - startMs,
    weeks,
    firstDate: dateStringOfDay(semesterWeekDay(semester, firstWeek, weekday)),
    lastDate: dateStringOfDay(semesterWeekDay(semester, lastWeek, weekday)),
  };
}

function buildWeeklyRule(
  row: TimetableRow,
  run: WeekRun,
  resolved: ResolvedRow,
  semester: Semester,
  tzOffset: number,
): TimetableRule {
  const startDate = semesterWeekDate(semester, run.start, resolved.weekday);
  const lastDate = semesterWeekDate(semester, run.end, resolved.weekday);
  const rule: TimetableRule = {
    freq: 'weekly',
    name: row.course.trim(),
    note: rowNote(row),
    interval: run.step,
    startDate,
    timeOfDay: resolved.timeOfDay,
    duration: resolved.duration,
    byDay: [coreWeekday(resolved.weekday)],
    // `until` bounds the occurrence *start* inclusively, so the last selected
    // week's own start is exactly the right bound for an off-phase run.
    until: timestampFromCivil(lastDate, resolved.timeOfDay, tzOffset),
    tzOffset,
  };
  validateRule({ ...rule, id: '', active: true });
  return rule;
}

function ruleOp(rule: TimetableRule, id: string): Operation {
  return {
    kind: 'add_block_rule',
    id,
    name: rule.name,
    freq: rule.freq,
    interval: rule.interval,
    startDate: rule.startDate,
    timeOfDay: rule.timeOfDay,
    duration: rule.duration,
    byDay: rule.byDay,
    until: rule.until,
    tzOffset: rule.tzOffset,
    note: rule.note,
  };
}

function ruleKey(rule: RuleIdentity): string {
  const date = `${rule.startDate.year}-${rule.startDate.month}-${rule.startDate.day}`;
  const time = `${rule.timeOfDay.hour}:${rule.timeOfDay.minute}`;
  const until = rule.until === undefined ? 'open' : String(rule.until);
  const byDay = rule.byDay === undefined ? '' : [...rule.byDay].sort((a, b) => a - b).join(',');
  return `${rule.freq}|${rule.name}|${rule.interval}|${date}|${time}|${rule.duration}|${until}|${byDay}`;
}

function requireWeekday(row: TimetableRow): Weekday {
  const weekday = validWeekday(row.weekday);
  if (weekday === null) throw rowError(row, `weekday out of range (1..7): ${String(row.weekday)}`);
  return weekday;
}

function requireTime(row: TimetableRow, field: 'start' | 'end', value: string): CivilTime {
  const time = parseTimeOfDay(value);
  if (time === null) throw rowError(row, `invalid ${field} time "${value}" (expected HH:mm)`);
  return time;
}

function requireWeeks(row: TimetableRow, semester: Semester): number[] {
  let weeks: number[];
  try {
    weeks = parseWeeksSpec(row.weeks);
  } catch (error) {
    throw rowError(row, messageOf(error));
  }
  const outside = weeks.filter((week) => week > semester.totalWeeks);
  if (outside.length > 0) throw rowError(row, describeOutside(outside, semester.totalWeeks));
  return weeks;
}

function rowNote(row: TimetableRow): string {
  const parts: string[] = [];
  const teacher = normalizeOptional(row.teacher);
  const location = normalizeOptional(row.location);
  if (teacher !== undefined) parts.push(teacher);
  if (location !== undefined) parts.push(location);
  return parts.join(' · ');
}

function rowLabel(row: TimetableRow): string {
  const name = row.course.trim();
  return `"${name === '' ? '(unnamed)' : name}" ${row.start.trim()}-${row.end.trim()}`;
}

function duplicateReason(existing: number, duplicateRows: number): string {
  if (existing > 0 && duplicateRows === 0) return 'an identical rule already exists';
  if (duplicateRows > 0 && existing === 0) return 'an identical row was already imported';
  return 'identical rules already exist';
}

function describeOutside(weeks: number[], totalWeeks: number): string {
  if (weeks.length === 1) return `week ${weeks[0]} is outside the semester (1..${totalWeeks})`;
  return `weeks ${formatWeeksSpec(weeks)} are outside the semester (1..${totalWeeks})`;
}

function validWeekday(value: Weekday): Weekday | null {
  return Number.isInteger(value) && value >= 1 && value <= 7 ? value : null;
}

function coreWeekday(weekday: Weekday): number {
  return weekday % 7;
}

function parseTimeOfDay(value: string): CivilTime | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function minutesOfTime(time: CivilTime): number {
  return time.hour * 60 + time.minute;
}

function formatTime(time: CivilTime): string {
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function intersectWeeks(left: number[], right: number[]): number[] {
  const other = new Set(right);
  return left.filter((week) => other.has(week));
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function moreSuffix(count: number): string {
  return count > 1 ? ` (+${count - 1} more)` : '';
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function assertTzOffset(tzOffset: number): void {
  if (!Number.isInteger(tzOffset) || tzOffset % MINUTE_MS !== 0) {
    throw new Error(`tzOffset must be a whole number of minutes: ${tzOffset}`);
  }
}

function rowError(row: TimetableRow, message: string): Error {
  return new Error(`row ${row.id}: ${message}`);
}

function problemOf(action: () => void): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
