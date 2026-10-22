import { describe, expect, it } from 'vitest';
import { WorktreeState, civilFromTimestamp, formatCivilDate, timestampFromCivil } from '@worktree/core';
import type { BlockOccurrence, BlockRule, Timestamp } from '@worktree/core';
import { analyzeTimetableRows, draftToRows, rowFirstDate, rowsToDraft, rowsToRules } from '../src/timetable';
import type { Semester, TimetableDraft, TimetablePlan, TimetableRow, Weekday } from '../src/types';

// 2026-09-07 is a Monday; the semester runs 16 teaching weeks.
const semester: Semester = { firstMonday: { year: 2026, month: 9, day: 7 }, totalWeeks: 16 };
const UTC = 0;
const UTC_PLUS_8 = 8 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const END_OF_TEST_WINDOW = timestampFromCivil({ year: 2027, month: 6, day: 1 }, { hour: 0, minute: 0 }, UTC);

let rowSequence = 0;

function makeRow(overrides: Partial<TimetableRow> = {}): TimetableRow {
  rowSequence += 1;
  return {
    id: `row-${rowSequence}`,
    course: 'Math',
    weekday: 2,
    start: '08:00',
    end: '09:40',
    weeks: '1-16',
    ...overrides,
  };
}

function idFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `rule-${count}`;
  };
}

function planFor(rows: TimetableRow[], options: { tzOffset?: number; existingRules?: BlockRule[] } = {}): TimetablePlan {
  return rowsToRules(rows, {
    semester,
    tzOffset: options.tzOffset ?? UTC,
    newId: idFactory(),
    existingRules: options.existingRules,
  });
}

function ruleList(plan: TimetablePlan) {
  return plan.ops.map((op) => {
    if (op.kind !== 'add_block_rule') throw new Error(`expected add_block_rule, got ${op.kind}`);
    return op;
  });
}

function firstRule(plan: TimetablePlan) {
  const [rule] = ruleList(plan);
  if (rule === undefined) throw new Error('expected at least one rule op');
  return rule;
}

function planState(plan: TimetablePlan): WorktreeState {
  const state = new WorktreeState();
  for (const op of plan.ops) state.apply(op);
  return state;
}

function expandPlan(plan: TimetablePlan, tzOffset = UTC): BlockOccurrence[] {
  return planState(plan).calendar.expand(0, END_OF_TEST_WINDOW);
}

function dateStrings(occurrences: BlockOccurrence[], tzOffset = UTC): string[] {
  return occurrences.map((occurrence) => formatCivilDate(civilFromTimestamp(occurrence.occStart, tzOffset).date));
}

function at(date: { year: number; month: number; day: number }, hour: number, minute = 0, tzOffset = UTC): Timestamp {
  return timestampFromCivil(date, { hour, minute }, tzOffset);
}

describe('draftToRows', () => {
  const draft: TimetableDraft = {
    courses: [
      {
        name: 'Math',
        teacher: 'Li',
        location: 'A101',
        sessions: [
          { weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' },
          { weekday: 3, start: ' 10:00 ', end: '11:40', weeks: '1-16' },
        ],
      },
      { name: 'Physics', sessions: [{ weekday: 5, start: '14:00', end: '15:40', weeks: '2-16双' }] },
    ],
    warnings: ['cropped header'],
  };

  it('flattens courses into rows with deterministic ids', () => {
    const rows = draftToRows(draft);
    expect(rows.map((row) => row.id)).toEqual(['c1-s1', 'c1-s2', 'c2-s1']);
    expect(rows[0]).toEqual({
      id: 'c1-s1',
      course: 'Math',
      weekday: 1,
      start: '08:00',
      end: '09:40',
      weeks: '1-16',
      teacher: 'Li',
      location: 'A101',
    });
    expect(rows[1].start).toBe('10:00');
    expect(rows[2].teacher).toBeUndefined();
    expect(rows[2].location).toBeUndefined();
  });

  it('is deterministic for the same draft', () => {
    expect(draftToRows(draft)).toEqual(draftToRows(draft));
  });
});

describe('rowsToDraft', () => {
  it('round-trips rows back to the extraction draft', () => {
    const original: TimetableDraft = {
      courses: [
        {
          name: 'Math',
          teacher: 'Li',
          location: 'A101',
          sessions: [
            { weekday: 2, start: '08:00', end: '09:40', weeks: '1-15单' },
            { weekday: 4, start: '10:00', end: '11:40', weeks: '1-8,10-16' },
          ],
        },
        { name: 'Physics', sessions: [{ weekday: 6, start: '14:00', end: '15:40', weeks: '1-16' }] },
      ],
      warnings: [],
    };
    expect(rowsToDraft(draftToRows(original)).courses).toEqual(original.courses);
  });

  it('groups by course, teacher and location while keeping row order', () => {
    const draft = rowsToDraft([
      makeRow({ course: 'Math', teacher: 'Li', location: 'A101', weekday: 2 }),
      makeRow({ course: 'Physics', weekday: 4 }),
      makeRow({ course: 'Math', teacher: 'Li', location: 'A101', weekday: 5 }),
    ]);
    expect(draft.courses).toHaveLength(2);
    expect(draft.courses[0].name).toBe('Math');
    expect(draft.courses[0].sessions.map((session) => session.weekday)).toEqual([2, 5]);
    expect(draft.courses[1].name).toBe('Physics');
    expect(draft.warnings).toEqual([]);
  });
});

describe('rowFirstDate', () => {
  it('is the date of the first selected week for that weekday', () => {
    expect(rowFirstDate(makeRow({ weekday: 2 }), semester, UTC)).toBe('2026-09-08');
    expect(rowFirstDate(makeRow({ weekday: 4 }), semester, UTC)).toBe('2026-09-10');
    expect(rowFirstDate(makeRow({ weekday: 7, weeks: '2-16双' }), semester, UTC)).toBe('2026-09-20');
  });
});

describe('rowsToRules: one weekly rule per week run', () => {
  it('builds a single-rule row from the anchor down to the last week', () => {
    const rule = firstRule(planFor([makeRow()]));
    expect(rule.name).toBe('Math');
    expect(rule.freq).toBe('weekly');
    expect(rule.interval).toBe(1);
    expect(rule.startDate).toEqual({ year: 2026, month: 9, day: 8 });
    expect(rule.timeOfDay).toEqual({ hour: 8, minute: 0 });
    expect(rule.duration).toBe(100 * MINUTE);
    expect(rule.until).toBe(at({ year: 2026, month: 12, day: 22 }, 8));
  });

  it('anchors startDate at the row weekday, not at the Monday', () => {
    const monday = firstRule(planFor([makeRow({ weekday: 1 })]));
    expect(monday.startDate).toEqual({ year: 2026, month: 9, day: 7 });
    const thursday = firstRule(planFor([makeRow({ weekday: 4, weeks: '3' })]));
    expect(thursday.startDate).toEqual({ year: 2026, month: 9, day: 24 });
    expect(thursday.until).toBe(at({ year: 2026, month: 9, day: 24 }, 8));
  });

  it("converts ISO weekdays to core's 0=Sunday byDay", () => {
    expect(firstRule(planFor([makeRow({ weekday: 1 })])).byDay).toEqual([1]);
    expect(firstRule(planFor([makeRow({ weekday: 2 })])).byDay).toEqual([2]);
    expect(firstRule(planFor([makeRow({ weekday: 6 })])).byDay).toEqual([6]);
    expect(firstRule(planFor([makeRow({ weekday: 7 })])).byDay).toEqual([0]);
  });

  it('turns odd/even specs into interval 2 anchored at the first selected week', () => {
    const odd = firstRule(planFor([makeRow({ weeks: '1-15单' })]));
    expect(odd.interval).toBe(2);
    expect(odd.startDate).toEqual({ year: 2026, month: 9, day: 8 });
    expect(odd.until).toBe(at({ year: 2026, month: 12, day: 15 }, 8));

    const even = firstRule(planFor([makeRow({ weeks: '2-16双' })]));
    expect(even.interval).toBe(2);
    expect(even.startDate).toEqual({ year: 2026, month: 9, day: 15 });
    expect(even.until).toBe(at({ year: 2026, month: 12, day: 22 }, 8));
  });

  it('splits a gapped spec into several rules', () => {
    const rules = ruleList(planFor([makeRow({ weeks: '1-5,8' })]));
    expect(rules).toHaveLength(2);
    expect(rules[0].startDate).toEqual({ year: 2026, month: 9, day: 8 });
    expect(rules[0].until).toBe(at({ year: 2026, month: 10, day: 6 }, 8));
    expect(rules[1].startDate).toEqual({ year: 2026, month: 10, day: 27 });
    expect(rules[1].until).toBe(at({ year: 2026, month: 10, day: 27 }, 8));

    const gapRules = ruleList(planFor([makeRow({ weeks: '1-8,10-16' })]));
    expect(gapRules).toHaveLength(2);
    expect(gapRules[0].interval).toBe(1);
    expect(gapRules[1].interval).toBe(1);
  });

  it('joins teacher and location into the note', () => {
    expect(firstRule(planFor([makeRow({ teacher: 'Li', location: 'A101' })])).note).toBe('Li · A101');
    expect(firstRule(planFor([makeRow({ teacher: 'Li' })])).note).toBe('Li');
    expect(firstRule(planFor([makeRow({ location: ' A101 ' })])).note).toBe('A101');
    expect(firstRule(planFor([makeRow()])).note).toBe('');
  });

  it('is deterministic and never mutates its input', () => {
    const rows = [makeRow({ course: 'Math', weeks: '1-15单' }), makeRow({ course: 'Physics', weekday: 4 })];
    const before = JSON.stringify(rows);
    const first = planFor(rows);
    const second = planFor(rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(second.ops).toEqual(first.ops);
  });
});

describe('rowsToRules: occurrences verified through core expansion', () => {
  it('produces 16 weekly occurrences for 1-16', () => {
    const occurrences = expandPlan(planFor([makeRow()]));
    expect(occurrences).toHaveLength(16);
    expect(occurrences[0].occStart).toBe(at({ year: 2026, month: 9, day: 8 }, 8));
    expect(occurrences[0].occEnd - occurrences[0].occStart).toBe(100 * MINUTE);
    expect(dateStrings(occurrences)[0]).toBe('2026-09-08');
    expect(dateStrings(occurrences)[15]).toBe('2026-12-22');
  });

  it('keeps only odd weeks for 1-15单', () => {
    const occurrences = expandPlan(planFor([makeRow({ weeks: '1-15单' })]));
    expect(occurrences).toHaveLength(8);
    expect(dateStrings(occurrences)).toEqual([
      '2026-09-08',
      '2026-09-22',
      '2026-10-06',
      '2026-10-20',
      '2026-11-03',
      '2026-11-17',
      '2026-12-01',
      '2026-12-15',
    ]);
  });

  it('keeps only even weeks for 2-16双', () => {
    const occurrences = expandPlan(planFor([makeRow({ weeks: '2-16双' })]));
    expect(occurrences).toHaveLength(8);
    expect(dateStrings(occurrences)).toEqual([
      '2026-09-15',
      '2026-09-29',
      '2026-10-13',
      '2026-10-27',
      '2026-11-10',
      '2026-11-24',
      '2026-12-08',
      '2026-12-22',
    ]);
  });

  it('bounds occurrences with until: nothing starts after the last selected week', () => {
    const plan = planFor([makeRow()]);
    const state = planState(plan);
    const rule = firstRule(plan);
    expect(rule.until).toBeDefined();
    if (rule.until === undefined) throw new Error('expected until');
    // `until` bounds the occurrence start, so the last occurrence is still
    // returned by a window that begins at `until`; one that begins after its
    // end returns nothing.
    expect(state.calendar.expand(rule.until, rule.until + rule.duration)).toHaveLength(1);
    expect(state.calendar.expand(rule.until + rule.duration, END_OF_TEST_WINDOW)).toEqual([]);
  });

  it('accepts full-width week specs', () => {
    const occurrences = expandPlan(planFor([makeRow({ weeks: '１－１６' })]));
    expect(occurrences).toHaveLength(16);
    expect(dateStrings(occurrences)[0]).toBe('2026-09-08');
  });

  it('produces the union of every run for 1-8,10-16', () => {
    const occurrences = expandPlan(planFor([makeRow({ weeks: '1-8,10-16' })]));
    expect(occurrences).toHaveLength(15);
    expect(dateStrings(occurrences)).not.toContain('2026-11-03');
  });

  it('expands correctly in a non-UTC offset', () => {
    const plan = planFor([makeRow()], { tzOffset: UTC_PLUS_8 });
    const rule = firstRule(plan);
    expect(rule.tzOffset).toBe(UTC_PLUS_8);
    const occurrences = expandPlan(plan, UTC_PLUS_8);
    expect(occurrences).toHaveLength(16);
    expect(occurrences[0].occStart).toBe(at({ year: 2026, month: 9, day: 8 }, 8, 0, UTC_PLUS_8));
  });
});

describe('rowsToRules: duplicate handling', () => {
  it('skips a row whose identical rule already exists', () => {
    const rows = [makeRow()];
    const existing = planState(planFor(rows)).calendar.getRules();
    let minted = 0;
    const plan = rowsToRules(rows, {
      semester,
      tzOffset: UTC,
      newId: () => {
        minted += 1;
        return `late-${minted}`;
      },
      existingRules: existing,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].row).toBe(rows[0]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/already exists/);
    expect(minted).toBe(0);
  });

  it('skips duplicate rows inside the input', () => {
    const first = makeRow();
    const second = makeRow();
    const plan = planFor([first, second]);
    expect(ruleList(plan)).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].row).toBe(second);
    expect(plan.warnings[0]).toMatch(/identical row was already imported/);
  });

  it('keeps the missing runs when only part of a row already exists', () => {
    const existing = planState(planFor([makeRow({ weeks: '1-5' })])).calendar.getRules();
    const plan = planFor([makeRow({ weeks: '1-5,8' })], { existingRules: existing });
    const rules = ruleList(plan);
    expect(rules).toHaveLength(1);
    expect(rules[0].startDate).toEqual({ year: 2026, month: 10, day: 27 });
    expect(plan.warnings[0]).toMatch(/skipped 1 of 2/);
  });

  it('does not treat the same time under another course as a duplicate', () => {
    const plan = planFor([makeRow({ course: 'Math' }), makeRow({ course: 'Physics' })]);
    expect(ruleList(plan)).toHaveLength(2);
    expect(plan.duplicates).toEqual([]);
  });
});

describe('rowsToRules: strict validation', () => {
  it('rejects an empty course name', () => {
    expect(() => planFor([makeRow({ course: '  ' })])).toThrow(/course name is empty/);
  });

  it('rejects an unparseable time', () => {
    expect(() => planFor([makeRow({ start: '8am' })])).toThrow(/invalid start time "8am"/);
    expect(() => planFor([makeRow({ end: '24:00' })])).toThrow(/invalid end time/);
  });

  it('rejects a non-positive period', () => {
    expect(() => planFor([makeRow({ start: '10:00', end: '10:00' })])).toThrow(/start must be before end/);
    expect(() => planFor([makeRow({ start: '11:00', end: '10:00' })])).toThrow(/start must be before end/);
  });

  it('accepts single-digit hours and normalises them', () => {
    const rule = firstRule(planFor([makeRow({ start: '8:00', end: '9:40' })]));
    expect(rule.timeOfDay).toEqual({ hour: 8, minute: 0 });
    expect(rule.duration).toBe(100 * MINUTE);
  });

  it('rejects an invalid weekday', () => {
    expect(() => planFor([makeRow({ weekday: 8 as Weekday })])).toThrow(/weekday out of range/);
    expect(() => planFor([makeRow({ weekday: 0 as Weekday })])).toThrow(/weekday out of range/);
  });

  it('rejects weeks outside the semester', () => {
    expect(() => planFor([makeRow({ weeks: '1-20' })])).toThrow(/weeks 17-20 are outside the semester \(1\.\.16\)/);
    expect(() => planFor([makeRow({ weeks: '17' })])).toThrow(/week 17 is outside the semester \(1\.\.16\)/);
  });

  it('rejects a malformed week spec', () => {
    expect(() => planFor([makeRow({ weeks: '1-foo' })])).toThrow(/invalid week spec/);
    expect(() => planFor([makeRow({ weeks: '' })])).toThrow(/week spec is empty/);
  });

  it('rejects an invalid semester and a fractional tz offset', () => {
    expect(() =>
      rowsToRules([makeRow()], {
        semester: { firstMonday: { year: 2026, month: 9, day: 8 }, totalWeeks: 16 },
        tzOffset: UTC,
        newId: idFactory(),
      }),
    ).toThrow(/must be a Monday/);
    expect(() => planFor([makeRow()], { tzOffset: 90 * 1000 })).toThrow(/whole number of minutes/);
  });
});

describe('analyzeTimetableRows: preview resolution', () => {
  it('resolves weeks and first/last dates for valid rows', () => {
    const rows = [makeRow({ weeks: '1-15单' }), makeRow({ course: 'Physics', weekday: 4, weeks: '2-16双' })];
    const views = analyzeTimetableRows(rows, { semester, tzOffset: UTC });
    expect(views).toHaveLength(2);
    expect(views[0].row).toBe(rows[0]);
    expect(views[0].weeksList).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(views[0].firstDate).toBe('2026-09-08');
    expect(views[0].lastDate).toBe('2026-12-15');
    expect(views[0].conflicts).toEqual([]);
    expect(views[1].weeksList).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(views[1].firstDate).toBe('2026-09-17');
    expect(views[1].lastDate).toBe('2026-12-24');
    expect(views[1].conflicts).toEqual([]);
  });

  it('collects an invalid week spec without throwing', () => {
    const views = analyzeTimetableRows([makeRow({ weeks: '1-foo' })], { semester, tzOffset: UTC });
    expect(views[0].weeksList).toEqual([]);
    expect(views[0].firstDate).toBe('');
    expect(views[0].lastDate).toBe('');
    expect(views[0].conflicts[0]).toMatch(/invalid weeks "1-foo"/);
  });

  it('flags weeks outside the semester but keeps the in-range dates', () => {
    const views = analyzeTimetableRows([makeRow({ weeks: '1-20' })], { semester, tzOffset: UTC });
    expect(views[0].weeksList).toContain(20);
    expect(views[0].conflicts).toContain('weeks 17-20 are outside the semester (1..16)');
    expect(views[0].lastDate).toBe('2026-12-22');
  });

  it('flags an empty course, a bad weekday, a bad time and a reversed period', () => {
    const views = analyzeTimetableRows(
      [
        makeRow({ course: '' }),
        makeRow({ weekday: 9 as Weekday }),
        makeRow({ start: '8am' }),
        makeRow({ start: '10:00', end: '09:00' }),
      ],
      { semester, tzOffset: UTC },
    );
    expect(views[0].conflicts).toContain('course name is empty');
    expect(views[1].conflicts[0]).toMatch(/weekday out of range/);
    expect(views[2].conflicts[0]).toMatch(/invalid start time "8am"/);
    expect(views[3].conflicts[0]).toMatch(/start must be before end/);
  });

  it('flags overlapping preview rows in both directions', () => {
    const math = makeRow({ course: 'Math', start: '08:00', end: '09:40' });
    const physics = makeRow({ course: 'Physics', start: '09:00', end: '10:40' });
    const views = analyzeTimetableRows([math, physics], { semester, tzOffset: UTC });
    expect(views[0].conflicts[0]).toBe('overlaps "Physics" 09:00-10:40 (weeks 1-16)');
    expect(views[1].conflicts[0]).toBe('overlaps "Math" 08:00-09:40 (weeks 1-16)');
  });

  it('does not flag disjoint weeks, touching periods or another weekday', () => {
    const disjointWeeks = analyzeTimetableRows(
      [makeRow({ weeks: '1-8' }), makeRow({ course: 'Physics', weeks: '9-16' })],
      { semester, tzOffset: UTC },
    );
    expect(disjointWeeks[0].conflicts).toEqual([]);
    expect(disjointWeeks[1].conflicts).toEqual([]);

    const touching = analyzeTimetableRows(
      [makeRow({ end: '09:00' }), makeRow({ course: 'Physics', start: '09:00', end: '10:00' })],
      { semester, tzOffset: UTC },
    );
    expect(touching[0].conflicts).toEqual([]);

    const otherDay = analyzeTimetableRows(
      [makeRow(), makeRow({ course: 'Physics', weekday: 3 })],
      { semester, tzOffset: UTC },
    );
    expect(otherDay[0].conflicts).toEqual([]);

    const partialWeekOverlap = analyzeTimetableRows(
      [makeRow({ weeks: '1-8' }), makeRow({ course: 'Physics', weeks: '8-16' })],
      { semester, tzOffset: UTC },
    );
    expect(partialWeekOverlap[0].conflicts[0]).toBe('overlaps "Physics" 08:00-09:40 (weeks 8)');
  });

  it('does not report identical rows as an overlap', () => {
    const views = analyzeTimetableRows([makeRow(), makeRow()], { semester, tzOffset: UTC });
    expect(views[0].conflicts).toEqual([]);
    expect(views[1].conflicts).toEqual([]);
  });

  it('never throws on an invalid semester or tz offset', () => {
    const badSemester = analyzeTimetableRows([makeRow()], {
      semester: { firstMonday: { year: 2026, month: 9, day: 8 }, totalWeeks: 16 },
      tzOffset: UTC,
    });
    expect(badSemester[0].conflicts[0]).toMatch(/invalid semester: .*must be a Monday/);
    expect(badSemester[0].firstDate).toBe('');

    const badOffset = analyzeTimetableRows([makeRow()], { semester, tzOffset: 90 * 1000 });
    expect(badOffset[0].conflicts[0]).toMatch(/whole number of minutes/);
    expect(badOffset[0].firstDate).toBe('2026-09-08');
  });
});

describe('analyzeTimetableRows: conflicts with the existing calendar', () => {
  it('reports an existing rule that overlaps the row', () => {
    const rows = [makeRow()];
    const state = planState(planFor(rows));
    const views = analyzeTimetableRows(rows, { semester, tzOffset: UTC, state });
    expect(views[0].conflicts[0]).toBe(
      'overlaps existing rule "Math" on 2026-09-08 08:00-09:40 (+15 more)',
    );
  });

  it('reports an existing block that overlaps the row', () => {
    const state = new WorktreeState();
    state.apply({
      kind: 'add_block',
      id: 'block-1',
      name: 'Lab',
      start: at({ year: 2026, month: 9, day: 8 }, 8, 30),
      end: at({ year: 2026, month: 9, day: 8 }, 9, 0),
    });
    const views = analyzeTimetableRows([makeRow()], { semester, tzOffset: UTC, state });
    expect(views[0].conflicts).toEqual(['overlaps existing block "Lab" on 2026-09-08 08:00-09:40']);
  });

  it('ignores blocks and rules that fall outside the semester window', () => {
    const state = new WorktreeState();
    state.apply({
      kind: 'add_block',
      id: 'block-1',
      name: 'Summer',
      start: at({ year: 2026, month: 7, day: 1 }, 8),
      end: at({ year: 2026, month: 7, day: 1 }, 9),
    });
    const views = analyzeTimetableRows([makeRow()], { semester, tzOffset: UTC, state });
    expect(views[0].conflicts).toEqual([]);
  });

  it('ignores an existing rule on another weekday', () => {
    const state = planState(planFor([makeRow({ weekday: 4 })]));
    const views = analyzeTimetableRows([makeRow({ weekday: 2 })], { semester, tzOffset: UTC, state });
    expect(views[0].conflicts).toEqual([]);
  });

  it('detects a rule created in another time offset that crosses the semester start', () => {
    // Local (+08:00) Monday 06:00 for 3h is Sunday 22:00 - Monday 01:00 UTC,
    // so the occurrence starts before the semester window in the device offset.
    const state = new WorktreeState();
    state.apply({
      kind: 'add_block_rule',
      id: 'early',
      name: 'Early',
      freq: 'weekly',
      interval: 1,
      startDate: { year: 2026, month: 9, day: 7 },
      timeOfDay: { hour: 6, minute: 0 },
      duration: 3 * 60 * MINUTE,
      byDay: [1],
      tzOffset: UTC_PLUS_8,
    });
    const views = analyzeTimetableRows([makeRow({ weekday: 1, start: '00:00', end: '03:00', weeks: '1' })], {
      semester,
      tzOffset: UTC,
      state,
    });
    expect(views[0].conflicts).toEqual(['overlaps existing rule "Early" on 2026-09-07 00:00-03:00']);
  });
});
