import { describe, expect, it } from 'vitest';
import { formatWeeksSpec, groupWeekRuns, parseWeeksSpec } from '../src/weeks';

describe('parseWeeksSpec', () => {
  it('parses a range', () => {
    expect(parseWeeksSpec('1-16')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('parses odd and even weeks', () => {
    expect(parseWeeksSpec('1-15单')).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(parseWeeksSpec('2-16双')).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(parseWeeksSpec('1-16(单)')).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(parseWeeksSpec('1-10双周')).toEqual([2, 4, 6, 8, 10]);
  });

  it('parses disjoint ranges, single weeks and duplicated weeks', () => {
    expect(parseWeeksSpec('1-8,10-16')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
    expect(parseWeeksSpec('3')).toEqual([3]);
    expect(parseWeeksSpec('1-4,2,4')).toEqual([1, 2, 3, 4]);
  });

  it('tolerates full-width digits, separators and the 周 suffix', () => {
    expect(parseWeeksSpec('１－４')).toEqual([1, 2, 3, 4]);
    expect(parseWeeksSpec('1-4周，6周')).toEqual([1, 2, 3, 4, 6]);
    expect(parseWeeksSpec(' 1 - 3 ')).toEqual([1, 2, 3]);
  });

  it('rejects malformed or out-of-range specs', () => {
    expect(() => parseWeeksSpec('')).toThrow(/empty/);
    expect(() => parseWeeksSpec('abc')).toThrow(/invalid week spec/);
    expect(() => parseWeeksSpec('1-')).toThrow(/invalid week spec/);
    expect(() => parseWeeksSpec('0-3')).toThrow(/out of range/);
    expect(() => parseWeeksSpec('1-100')).toThrow(/out of range/);
    expect(() => parseWeeksSpec('5-2')).toThrow(/reversed/);
    expect(() => parseWeeksSpec('4-4单')).toThrow(/selects no weeks/);
    expect(() => parseWeeksSpec('1,,2')).toThrow(/invalid week spec/);
  });
});

describe('groupWeekRuns', () => {
  it('groups contiguous weeks with step 1', () => {
    expect(groupWeekRuns([4, 1, 2, 3])).toEqual([{ start: 1, end: 4, step: 1 }]);
  });

  it('groups odd weeks with step 2 and splits when the step changes', () => {
    expect(groupWeekRuns([1, 3, 5, 6, 7])).toEqual([
      { start: 1, end: 5, step: 2 },
      { start: 6, end: 7, step: 1 },
    ]);
  });

  it('starts a new run across a gap larger than 2', () => {
    expect(groupWeekRuns([1, 4, 7])).toEqual([
      { start: 1, end: 1, step: 1 },
      { start: 4, end: 4, step: 1 },
      { start: 7, end: 7, step: 1 },
    ]);
  });

  it('handles a single week and an empty list', () => {
    expect(groupWeekRuns([9])).toEqual([{ start: 9, end: 9, step: 1 }]);
    expect(groupWeekRuns([])).toEqual([]);
  });
});

describe('formatWeeksSpec', () => {
  it('formats runs back into parseable specs', () => {
    expect(formatWeeksSpec([1, 2, 3, 4])).toBe('1-4');
    expect(formatWeeksSpec([1, 3, 5])).toBe('1-5单');
    expect(formatWeeksSpec([2, 4, 6])).toBe('2-6双');
    expect(formatWeeksSpec([1, 3, 5, 6, 7])).toBe('1-5单,6-7');
    expect(formatWeeksSpec([9])).toBe('9');
  });

  it('round-trips parse and format', () => {
    for (const spec of ['1-16', '1-15单', '2-16双', '1-8,10-16', '1-3,6,8-9']) {
      expect(parseWeeksSpec(formatWeeksSpec(parseWeeksSpec(spec)))).toEqual(parseWeeksSpec(spec));
    }
  });

  it('rejects an empty list', () => {
    expect(() => formatWeeksSpec([])).toThrow(/empty/);
  });
});
