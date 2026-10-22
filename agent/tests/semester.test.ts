import { describe, expect, it } from 'vitest';
import { civilFromDays, daysFromCivil, formatCivilDate } from '@worktree/core';
import {
  assertWeekday,
  dateStringOfDay,
  dayOfDateString,
  firstMondayDay,
  semesterDayRange,
  semesterWeekDate,
  semesterWeekDay,
  validateSemester,
  weekOfDate,
  weekOfSemesterDay,
} from '../src/semester';

// 2026-09-07 is a Monday; the semester runs 16 teaching weeks.
const semester = { firstMonday: { year: 2026, month: 9, day: 7 }, totalWeeks: 16 };

describe('validateSemester', () => {
  it('accepts a Monday anchor', () => {
    expect(() => validateSemester(semester)).not.toThrow();
  });

  it('rejects a non-Monday anchor, a bad date and an invalid week count', () => {
    expect(() => validateSemester({ firstMonday: { year: 2026, month: 9, day: 8 }, totalWeeks: 16 })).toThrow(
      /must be a Monday/,
    );
    expect(() => validateSemester({ firstMonday: { year: 2026, month: 2, day: 30 }, totalWeeks: 16 })).toThrow(
      /invalid semester start date/,
    );
    expect(() => validateSemester({ ...semester, totalWeeks: 0 })).toThrow(/totalWeeks/);
    expect(() => validateSemester({ ...semester, totalWeeks: 61 })).toThrow(/totalWeeks/);
    expect(() => validateSemester({ ...semester, totalWeeks: 2.5 })).toThrow(/totalWeeks/);
  });
});

describe('semester week ↔ date', () => {
  it('maps week 1 Monday to the anchor', () => {
    expect(civilFromDays(semesterWeekDay(semester, 1, 1))).toEqual({ year: 2026, month: 9, day: 7 });
  });

  it('maps later weeks and weekdays', () => {
    expect(formatCivilDate(semesterWeekDate(semester, 16, 7))).toBe('2026-12-27');
    expect(formatCivilDate(semesterWeekDate(semester, 2, 3))).toBe('2026-09-16');
    expect(formatCivilDate(semesterWeekDate(semester, 3, 1))).toBe('2026-09-21');
  });

  it('rejects weeks outside the semester', () => {
    expect(() => semesterWeekDate(semester, 0, 1)).toThrow(/outside the semester/);
    expect(() => semesterWeekDate(semester, 17, 1)).toThrow(/outside the semester/);
  });

  it('computes the teaching week of a day, including days before week 1', () => {
    const first = firstMondayDay(semester);
    expect(weekOfSemesterDay(semester, first)).toBe(1);
    expect(weekOfSemesterDay(semester, first + 6)).toBe(1);
    expect(weekOfSemesterDay(semester, first + 7)).toBe(2);
    expect(weekOfSemesterDay(semester, first - 1)).toBe(0);
    expect(weekOfDate(semester, '2026-09-16')).toBe(2);
  });

  it('covers exactly totalWeeks weeks, both ends inclusive', () => {
    const range = semesterDayRange(semester);
    expect(range.fromDay).toBe(firstMondayDay(semester));
    expect(dateStringOfDay(range.toDay)).toBe('2026-12-27');
    expect(range.toDay - range.fromDay + 1).toBe(16 * 7);
  });
});

describe('date helpers', () => {
  it('round-trips a date string', () => {
    expect(dayOfDateString('2026-09-07')).toBe(daysFromCivil(2026, 9, 7));
    expect(dateStringOfDay(daysFromCivil(2026, 12, 27))).toBe('2026-12-27');
  });

  it('rejects malformed dates', () => {
    expect(() => dayOfDateString('2026-2-3')).toThrow(/invalid date/);
    expect(() => dayOfDateString('tomorrow')).toThrow(/invalid date/);
  });

  it('narrows weekdays', () => {
    expect(() => assertWeekday(1)).not.toThrow();
    expect(() => assertWeekday(7)).not.toThrow();
    expect(() => assertWeekday(0)).toThrow(/weekday out of range/);
    expect(() => assertWeekday(8)).toThrow(/weekday out of range/);
    expect(() => assertWeekday(1.5)).toThrow(/weekday out of range/);
  });
});
