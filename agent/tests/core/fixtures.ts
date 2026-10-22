import { ROOT_ID, WorktreeState, parseCivilDate, timestampFromCivil } from '@worktree/core';
import type { CivilDate, Operation, Timestamp } from '@worktree/core';
import type { ToolContext } from '../../src/types';

/** Asia/Shanghai, the offset every fixture uses. */
export const TZ = 8 * 60 * 60 * 1000;

export function timestampAt(date: string, time: string): Timestamp {
  const parsed = parseCivilDate(date);
  if (parsed === null) throw new Error(`fixture date is invalid: ${date}`);
  const [hour, minute] = time.split(':').map(Number);
  if (hour === undefined || minute === undefined) throw new Error(`fixture time is invalid: ${time}`);
  return timestampFromCivil(parsed, { hour, minute }, TZ);
}

/** A Friday morning; the semester fixture starts 2026-09-07, so this is teaching week 7. */
export const NOW = timestampAt('2026-10-23', '08:00');

export function civilDate(year: number, month: number, day: number): CivilDate {
  return { year, month, day };
}

/** Sequential ids keep planned ops and tool ids deterministic per context. */
export function makeIdFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
}

export function makeContext(state: WorktreeState, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    state,
    now: NOW,
    tzOffset: TZ,
    semester: null,
    newId: makeIdFactory(),
    ...overrides,
  };
}

export function addNode(
  parentId: string,
  id: string,
  name: string,
  extra: { weight?: number; note?: string; deadline?: Timestamp } = {},
): Operation {
  return {
    kind: 'add',
    parentId,
    id,
    name,
    weight: extra.weight ?? 1,
    ...(extra.note === undefined ? {} : { note: extra.note }),
    ...(extra.deadline === undefined ? {} : { deadline: extra.deadline }),
  };
}

export function addBlock(
  id: string,
  name: string,
  start: Timestamp,
  end: Timestamp,
  extra: { nodeId?: string; note?: string } = {},
): Operation {
  return {
    kind: 'add_block',
    id,
    name,
    start,
    end,
    ...(extra.nodeId === undefined ? {} : { nodeId: extra.nodeId }),
    ...(extra.note === undefined ? {} : { note: extra.note }),
  };
}

export function addWeeklyRule(
  id: string,
  name: string,
  startDate: CivilDate,
  timeOfDay: { hour: number; minute: number },
  duration: Timestamp,
  byDay: number[],
  until?: Timestamp,
): Operation {
  return {
    kind: 'add_block_rule',
    id,
    name,
    freq: 'weekly',
    interval: 1,
    startDate,
    timeOfDay,
    duration,
    byDay,
    ...(until === undefined ? {} : { until }),
    tzOffset: TZ,
  };
}

export { ROOT_ID };
