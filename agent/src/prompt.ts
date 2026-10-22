import {
  civilFromTimestamp,
  dayFromTimestamp,
  daysFromCivil,
  formatCivilDate,
  weekdayFromDays,
} from '@worktree/core';
import type { AgentHistoryMessage, LlmWireMessage, Semester } from './types';

export interface SystemPromptOptions {
  now: number;
  tzOffset: number;
  lang: string;
  semester: Semester | null;
  /** The context snapshot from buildContextSnapshot. */
  snapshot: string;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_PER_WEEK = 7;

/** Builds the system prompt: role, clock, semester, snapshot and tool discipline. */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { date, time } = civilFromTimestamp(opts.now, opts.tzOffset);
  const day = dayFromTimestamp(opts.now, opts.tzOffset);
  const clock = `${pad2(time.hour)}:${pad2(time.minute)}`;
  const weekday = WEEKDAY_NAMES[weekdayFromDays(day)];
  return [
    'You are the scheduling assistant built into Worktree, a tree-based task and calendar app.',
    'You can only see or change the user’s data through the provided tools, so every fact you state must come from a tool result.',
    '',
    `Current local time: ${formatCivilDate(date)} ${clock} (${weekday}), timezone ${formatOffset(opts.tzOffset)}.`,
    semesterLine(opts.semester, day),
    '',
    'Live context snapshot:',
    opts.snapshot,
    '',
    'Tool rules:',
    '- Always call a tool to read data or change anything; never claim an event or task exists without a tool result.',
    '- A tool result with ok:false is a failure: explain it or ask the user, never pretend the change happened.',
    '- Dates are YYYY-MM-DD and times are HH:mm (24-hour). Never send epoch milliseconds or timestamps.',
    '- Never invent ids: copy ids from tool results.',
    '- When a request is genuinely ambiguous (missing day, time or target), ask one short clarifying question; otherwise act immediately, because every change is undoable.',
    '- A start time without a duration means one hour; create the event and mention the assumption in your reply.',
    '- Keep replies short and concrete, and summarize what you changed.',
    `- Reply in the user’s language (current UI language: ${opts.lang}).`,
  ].join('\n');
}

/** Prior user/assistant turns as wire messages. */
export function buildHistoryMessages(history: AgentHistoryMessage[]): LlmWireMessage[] {
  return history.map((message) => ({ role: message.role, content: message.text }));
}

/** One user turn, with an optional image part (used by the vision flow if ever chatted). */
export function buildUserMessage(text: string, imageDataUrl?: string): LlmWireMessage {
  if (imageDataUrl === undefined) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  };
}

function semesterLine(semester: Semester | null, todayDay: number): string {
  if (semester === null) {
    return 'Semester: not configured, so week-based questions cannot be answered until the user sets the teaching calendar.';
  }
  const anchor = daysFromCivil(semester.firstMonday.year, semester.firstMonday.month, semester.firstMonday.day);
  const week = Math.floor((todayDay - anchor) / DAYS_PER_WEEK) + 1;
  const start = formatCivilDate(semester.firstMonday);
  if (week < 1) {
    return `Semester: teaching week 1 of ${semester.totalWeeks} starts on ${start}; today is before the semester.`;
  }
  if (week > semester.totalWeeks) {
    return `Semester: ended after ${semester.totalWeeks} weeks from ${start}; today is after the semester.`;
  }
  return `Semester: week ${week} of ${semester.totalWeeks} (week 1 starts ${start}).`;
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(offsetMs) / 60000);
  return `UTC${sign}${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
