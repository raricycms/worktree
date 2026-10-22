import { civilFromDays, daysFromCivil, formatCivilDate, isValidCivilDate, parseCivilDate, weekdayFromDays } from '@worktree/core';
import type { CivilDate } from '@worktree/core';
import type { DateString, Semester, Weekday } from './types';

const DAYS_PER_WEEK = 7;
const MAX_WEEKS = 60;

/**
 * Validates a teaching calendar. The anchor must be a real Monday: every
 * week↔date conversion is plain day arithmetic from it, so a wrong anchor
 * would silently shift an entire timetable.
 */
export function validateSemester(semester: Semester): void {
  if (!isValidCivilDate(semester.firstMonday)) {
    throw new Error(`invalid semester start date: ${describeDate(semester.firstMonday)}`);
  }
  const anchor = daysFromCivil(
    semester.firstMonday.year,
    semester.firstMonday.month,
    semester.firstMonday.day,
  );
  if (weekdayFromDays(anchor) !== 1) {
    throw new Error(`semester start must be a Monday: ${formatCivilDate(semester.firstMonday)}`);
  }
  if (!Number.isInteger(semester.totalWeeks) || semester.totalWeeks < 1 || semester.totalWeeks > MAX_WEEKS) {
    throw new Error(`semester totalWeeks must be an integer within 1..${MAX_WEEKS}: ${semester.totalWeeks}`);
  }
}

/** The civil day index of the semester's first Monday. */
export function firstMondayDay(semester: Semester): number {
  validateSemester(semester);
  return daysFromCivil(
    semester.firstMonday.year,
    semester.firstMonday.month,
    semester.firstMonday.day,
  );
}

/** The civil day index of `week`, `weekday` in the semester. */
export function semesterWeekDay(semester: Semester, week: number, weekday: Weekday): number {
  const anchor = firstMondayDay(semester);
  assertWeek(semester, week);
  return anchor + (week - 1) * DAYS_PER_WEEK + (weekday - 1);
}

/** The civil date of `week`, `weekday` in the semester. */
export function semesterWeekDate(semester: Semester, week: number, weekday: Weekday): CivilDate {
  return civilFromDays(semesterWeekDay(semester, week, weekday));
}

/** The teaching week a civil day index falls in; may legitimately be < 1 or > totalWeeks. */
export function weekOfSemesterDay(semester: Semester, day: number): number {
  return Math.floor((day - firstMondayDay(semester)) / DAYS_PER_WEEK) + 1;
}

/** The teaching week a `YYYY-MM-DD` date falls in. */
export function weekOfDate(semester: Semester, date: DateString): number {
  return weekOfSemesterDay(semester, dayOfDateString(date));
}

/** The semester's covered civil day indices, both ends inclusive. */
export function semesterDayRange(semester: Semester): { fromDay: number; toDay: number } {
  const fromDay = firstMondayDay(semester);
  return { fromDay, toDay: fromDay + semester.totalWeeks * DAYS_PER_WEEK - 1 };
}

/** `YYYY-MM-DD` → civil day index; throws on a malformed or nonexistent date. */
export function dayOfDateString(value: DateString): number {
  const date = parseCivilDate(value);
  if (date === null) throw new Error(`invalid date: ${value} (expected YYYY-MM-DD)`);
  return daysFromCivil(date.year, date.month, date.day);
}

/** Civil day index → `YYYY-MM-DD`. */
export function dateStringOfDay(day: number): DateString {
  return formatCivilDate(civilFromDays(day));
}

/** Throws unless `value` is an ISO weekday 1..7; narrows the type. */
export function assertWeekday(value: number): asserts value is Weekday {
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new Error(`weekday out of range (1..7): ${value}`);
  }
}

function assertWeek(semester: Semester, week: number): void {
  if (!Number.isInteger(week) || week < 1 || week > semester.totalWeeks) {
    throw new Error(`week ${week} is outside the semester (1..${semester.totalWeeks})`);
  }
}

function describeDate(date: CivilDate): string {
  return `${date.year}-${date.month}-${date.day}`;
}
