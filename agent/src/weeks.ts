/** A maximal run of teaching weeks with a constant step (1 = every week, 2 = odd/even). */
export interface WeekRun {
  start: number;
  end: number;
  step: 1 | 2;
}

const MAX_WEEK = 99;

/**
 * Parses a teaching-week spec into ascending, unique week numbers.
 * Accepted: `1`, `1-16`, `1-16单`, `2-16双`, `1-8,10-16`, with `周`/`週`
 * suffixes, full-width digits/punctuation and whitespace tolerated.
 * Throws on an empty spec, a malformed range or a week outside 1..99 — a
 * timetable row without a trustworthy week range must not reach the calendar.
 */
export function parseWeeksSpec(spec: string): number[] {
  const normalized = normalizeSpec(spec);
  if (normalized === '') throw new Error('week spec is empty');
  const weeks = new Set<number>();
  for (const part of normalized.split(',')) {
    if (part === '') throw new Error(`invalid week spec: ${spec}`);
    const { range, parity } = splitParity(part);
    if (range.start > range.end) {
      throw new Error(`week range is reversed: ${part}`);
    }
    for (let week = range.start; week <= range.end; week++) {
      if (week < 1 || week > MAX_WEEK) throw new Error(`week out of range: ${week}`);
      if (parity === 'odd' && week % 2 === 0) continue;
      if (parity === 'even' && week % 2 === 1) continue;
      weeks.add(week);
    }
  }
  if (weeks.size === 0) throw new Error(`week spec selects no weeks: ${spec}`);
  return [...weeks].sort((a, b) => a - b);
}

/**
 * Formats week numbers back into a canonical spec: `[1,3,5]` → `1-5单`,
 * `[1,2,3,4]` → `1-4`. Parsing the result yields the same weeks.
 */
export function formatWeeksSpec(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('cannot format an empty week list');
  return groupWeekRuns(sorted)
    .map((run) => {
      if (run.step === 1 && run.start === run.end) return String(run.start);
      const parity = run.step === 2 ? (run.start % 2 === 1 ? '单' : '双') : '';
      return `${run.start}-${run.end}${parity}`;
    })
    .join(',');
}

/**
 * Groups ascending unique weeks into maximal runs with a constant step of 1
 * or 2. `[1,3,5,6,7]` → `[{1,5,2},{6,7,1}]`; a gap larger than 2 starts a new
 * singleton run, so each run maps to one weekly rule.
 */
export function groupWeekRuns(weeks: number[]): WeekRun[] {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const runs: WeekRun[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index];
    if (index + 1 === sorted.length) {
      runs.push({ start, end: start, step: 1 });
      break;
    }
    const gap = sorted[index + 1] - start;
    if (gap !== 1 && gap !== 2) {
      runs.push({ start, end: start, step: 1 });
      index++;
      continue;
    }
    const step: 1 | 2 = gap === 2 ? 2 : 1;
    let end = start;
    let cursor = index + 1;
    while (cursor < sorted.length && sorted[cursor] - sorted[cursor - 1] === step) {
      end = sorted[cursor];
      cursor++;
    }
    runs.push({ start, end, step });
    index = cursor;
  }
  return runs;
}

function normalizeSpec(spec: string): string {
  return spec
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[，、；;]/g, ',')
    .replace(/[－–—~～]/g, '-')
    .replace(/[周週]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function splitParity(part: string): { range: { start: number; end: number }; parity: 'odd' | 'even' | null } {
  let parity: 'odd' | 'even' | null = null;
  let text = part;
  const marker = /[单雙双]/.exec(text);
  if (marker !== null) {
    parity = marker[0] === '单' ? 'odd' : 'even';
    text = text.replace(/[()（）]?[单雙双][()（）]?/g, '');
  }
  const rangeMatch = /^(\d{1,3})-(\d{1,3})$/.exec(text);
  if (rangeMatch !== null) {
    return { range: { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) }, parity };
  }
  const singleMatch = /^\d{1,3}$/.exec(text);
  if (singleMatch !== null) {
    const week = Number(singleMatch[0]);
    return { range: { start: week, end: week }, parity };
  }
  throw new Error(`invalid week spec part: ${part}`);
}
