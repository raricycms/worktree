import { z } from 'zod';
import { formatCivilDate } from '@worktree/core';
import { buildUserMessage } from './prompt';
import { assertWeekday } from './semester';
import { parseWeeksSpec } from './weeks';
import type {
  LlmTransport,
  LlmWireMessage,
  Semester,
  TimetableCourse,
  TimetableDraft,
  TimetableSession,
} from './types';

export interface ExtractTimetableOptions {
  transport: LlmTransport;
  /** A `data:image/...;base64,...` URL of the timetable image. */
  imageDataUrl: string;
  semester: Semester;
  /** BCP-47-ish UI language; the extraction itself is language-agnostic. */
  language?: string;
  signal?: AbortSignal;
}

const sessionSchema = z.object({
  weekday: z.coerce.number().int().min(1).max(7),
  start: z.string(),
  end: z.string(),
  weeks: z.string(),
});

const courseSchema = z.object({
  name: z.string(),
  teacher: z.string().nullish(),
  location: z.string().nullish(),
  sessions: z.array(sessionSchema).min(1),
});

const draftSchema = z.object({
  courses: z.array(courseSchema),
  warnings: z.array(z.string()).nullish(),
});

/**
 * Sends the timetable image to a multimodal model and returns a validated,
 * normalised draft. Malformed JSON is retried once with the validation error;
 * a second failure throws. Nothing here touches worktree state.
 */
export async function extractTimetable(opts: ExtractTimetableOptions): Promise<TimetableDraft> {
  const messages: LlmWireMessage[] = [
    { role: 'system', content: buildVisionInstruction(opts.semester, opts.language) },
    buildUserMessage('Extract every class from this timetable image.', [
      { id: 'vision', dataUrl: opts.imageDataUrl },
    ]),
  ];
  const first = await opts.transport.complete({
    messages: [...messages],
    temperature: 0,
    // Reasoning tokens count against the completion budget; a timetable needs
    // a long JSON body on top of them.
    maxTokens: 8000,
    signal: opts.signal,
  });
  let reason = 'the reply was empty';
  try {
    return parseDraft(first.content, opts.semester);
  } catch (error) {
    reason = describeError(error);
  }
  const retry = await opts.transport.complete({
    messages: [
      ...messages,
      { role: 'assistant', content: first.content === '' ? '(empty reply)' : first.content },
      {
        role: 'user',
        content: `Your reply could not be used: ${reason}\nReply again with only the JSON object described in the system prompt, no prose and no code fences.`,
      },
    ],
    temperature: 0,
    maxTokens: 8000,
    signal: opts.signal,
  });
  try {
    return parseDraft(retry.content, opts.semester);
  } catch (error) {
    throw new Error(`timetable extraction failed after one retry: ${describeError(error)}`);
  }
}

function buildVisionInstruction(semester: Semester, language?: string): string {
  const lines = [
    'You extract a weekly class timetable from an image.',
    'Reply with ONLY one JSON object, no prose and no markdown code fences.',
    'Shape: {"courses":[{"name":string,"teacher":string,"location":string,"sessions":[{"weekday":1,"start":"HH:mm","end":"HH:mm","weeks":"1-16"}]}],"warnings":[string]}',
    'Rules:',
    '- weekday is an ISO weekday: 1 = Monday .. 7 = Sunday.',
    '- start and end are 24-hour HH:mm times.',
    '- Group all meetings of the same course under one course entry, one session per distinct weekday, time and week range.',
    `- weeks is the teaching-week expression printed for the class, normalised without the 周 suffix, e.g. "1-16", "1-16单", "2-16双", "1-8,10-16"; if the image gives no week range use "1-${semester.totalWeeks}".`,
    '- Use names exactly as printed (course, teacher, location); omit teacher or location when absent.',
    '- Add a warning string for anything unreadable or ambiguous instead of inventing a value.',
    `- The semester covers ${semester.totalWeeks} teaching weeks starting ${formatCivilDate(semester.firstMonday)}.`,
  ];
  if (language !== undefined && language !== '') {
    lines.push(`- The app UI language is ${language}; keep every extracted name in the language printed on the image.`);
  }
  return lines.join('\n');
}

function parseDraft(content: string, semester: Semester): TimetableDraft {
  const jsonText = extractJsonObject(content);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`the reply is not valid JSON: ${describeError(error)}`);
  }
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the reply does not match the timetable schema: ${describeIssues(parsed.error)}`);
  }
  return normaliseDraft(parsed.data, semester);
}

function normaliseDraft(parsed: z.infer<typeof draftSchema>, semester: Semester): TimetableDraft {
  const warnings: string[] = [];
  const courses: TimetableCourse[] = parsed.courses.map((course) => {
    const name = course.name.trim();
    if (name === '') throw new Error('a course has an empty name');
    const sessions = course.sessions.map((session) => normaliseSession(session, name));
    const teacher = optionalText(course.teacher);
    const location = optionalText(course.location);
    return {
      name,
      ...(teacher === undefined ? {} : { teacher }),
      ...(location === undefined ? {} : { location }),
      sessions,
    };
  });
  for (const warning of parsed.warnings ?? []) {
    const text = warning.trim();
    if (text !== '') warnings.push(text);
  }
  if (courses.length === 0) warnings.push('no courses were recognised in the image');
  for (const course of courses) {
    for (const session of course.sessions) {
      const weeks = weeksOutsideSemester(session.weeks, semester, course.name, warnings);
      if (weeks.length > 0) {
        warnings.push(
          `course "${course.name}" on weekday ${session.weekday} has weeks outside the semester (1..${semester.totalWeeks}): ${weeks.join(', ')}`,
        );
      }
    }
  }
  return { courses, warnings };
}

function normaliseSession(
  session: z.infer<typeof sessionSchema>,
  courseName: string,
): TimetableSession {
  assertWeekday(session.weekday);
  const start = normaliseClock(session.start);
  if (start === null) {
    throw new Error(`invalid start time "${session.start}" for course "${courseName}" (expected HH:mm)`);
  }
  const end = normaliseClock(session.end);
  if (end === null) {
    throw new Error(`invalid end time "${session.end}" for course "${courseName}" (expected HH:mm)`);
  }
  const weeks = normaliseWeeks(session.weeks);
  if (weeks === '') {
    throw new Error(`missing teaching weeks for course "${courseName}"`);
  }
  return { weekday: session.weekday, start, end, weeks };
}

/** Weeks in the spec that fall beyond the semester; unreadable specs become warnings. */
function weeksOutsideSemester(
  spec: string,
  semester: Semester,
  courseName: string,
  warnings: string[],
): number[] {
  let weeks: number[];
  try {
    weeks = parseWeeksSpec(spec);
  } catch (error) {
    warnings.push(`course "${courseName}": cannot read teaching weeks "${spec}": ${describeError(error)}`);
    return [];
  }
  return weeks.filter((week) => week > semester.totalWeeks);
}

function extractJsonObject(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('the reply contains no JSON object');
  return content.slice(start, end + 1);
}

function normaliseClock(value: string): string | null {
  const text = toHalfWidthNumber(value).replace(/\s+/g, '');
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function normaliseWeeks(value: string): string {
  return toHalfWidthNumber(value)
    .replace(/[，、；;]/g, ',')
    .replace(/[－–—~～]/g, '-')
    .replace(/[周週]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function toHalfWidthNumber(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/：/g, ':');
}

function optionalText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
