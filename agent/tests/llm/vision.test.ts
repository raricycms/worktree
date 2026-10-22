import { describe, expect, it } from 'vitest';
import { extractTimetable } from '../../src/vision';
import type { Semester } from '../../src/types';
import { failingTransport, llmResponse, scriptedTransport } from './fakes';

const semester: Semester = { firstMonday: { year: 2026, month: 8, day: 31 }, totalWeeks: 16 };
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function validDraft(): Record<string, unknown> {
  return {
    courses: [
      {
        name: 'Calculus',
        sessions: [
          { weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' },
        ],
      },
    ],
    warnings: [],
  };
}

function fenced(value: unknown): string {
  return `Here is the timetable:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

describe('extractTimetable', () => {
  it('sends the image and parses a fenced JSON reply', async () => {
    const reply = {
      courses: [
        {
          name: '  Calculus  ',
          teacher: ' Li ',
          location: '',
          sessions: [{ weekday: '2', start: '9:00', end: '10:40', weeks: '1-18周' }],
        },
      ],
      warnings: [' bottom row cut off '],
    };
    const { transport, requests } = scriptedTransport([llmResponse({ content: fenced(reply) })]);

    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester, language: 'zh' });

    expect(draft.courses).toEqual([
      {
        name: 'Calculus',
        teacher: 'Li',
        sessions: [{ weekday: 2, start: '09:00', end: '10:40', weeks: '1-18' }],
      },
    ]);
    expect(draft.warnings).toEqual([
      'bottom row cut off',
      'course "Calculus" on weekday 2 has weeks outside the semester (1..16): 17, 18',
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].temperature).toBe(0);
    expect(requests[0].maxTokens).toBe(8000);
    expect(requests[0].messages).toHaveLength(2);
    const system = requests[0].messages[0];
    expect(system.role).toBe('system');
    expect(typeof system.content).toBe('string');
    if (typeof system.content !== 'string') throw new Error('expected a string system prompt');
    expect(system.content).toContain('Reply with ONLY one JSON object');
    expect(system.content).toContain('ISO weekday: 1 = Monday .. 7 = Sunday');
    expect(system.content).toContain('16 teaching weeks starting 2026-08-31');

    const user = requests[0].messages[1];
    expect(user.role).toBe('user');
    expect(Array.isArray(user.content)).toBe(true);
    if (!Array.isArray(user.content)) throw new Error('expected content parts');
    expect(user.content[0]).toEqual({ type: 'text', text: 'Extract every class from this timetable image.' });
    expect(user.content[1]).toEqual({ type: 'image_url', image_url: { url: DATA_URL } });
  });

  it('accepts optional fields being absent', async () => {
    const reply = {
      courses: [
        {
          name: '高等数学（上）',
          sessions: [{ weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' }],
        },
      ],
    };
    const { transport } = scriptedTransport([llmResponse({ content: JSON.stringify(reply) })]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses).toHaveLength(1);
    const course = draft.courses[0];
    expect(course.name).toBe('高等数学（上）');
    expect('teacher' in course).toBe(false);
    expect('location' in course).toBe(false);
    expect(draft.warnings).toEqual([]);
  });

  it('normalises full-width digits, punctuation and colons', async () => {
    const reply = {
      courses: [
        {
          name: 'Physics',
          sessions: [{ weekday: 3, start: '９：００', end: '10：４０', weeks: '１－１６' }],
        },
      ],
    };
    const { transport } = scriptedTransport([llmResponse({ content: JSON.stringify(reply) })]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses[0].sessions[0]).toEqual({
      weekday: 3,
      start: '09:00',
      end: '10:40',
      weeks: '1-16',
    });
  });

  it('warns when no course was recognised', async () => {
    const { transport, requests } = scriptedTransport([
      llmResponse({ content: JSON.stringify({ courses: [], warnings: [] }) }),
    ]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses).toEqual([]);
    expect(draft.warnings).toEqual(['no courses were recognised in the image']);
    expect(requests).toHaveLength(1);
  });

  it('retries once with the parse error when the reply is not JSON', async () => {
    const { transport, requests } = scriptedTransport([
      llmResponse({ content: 'I could not read that image.' }),
      llmResponse({ content: JSON.stringify(validDraft()) }),
    ]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toHaveLength(4);
    expect(requests[1].messages[2]).toMatchObject({ role: 'assistant', content: 'I could not read that image.' });
    const retryMessage = requests[1].messages[3];
    expect(retryMessage.role).toBe('user');
    expect(retryMessage.content).toContain('could not be used');
    expect(retryMessage.content).toContain('no JSON object');
  });

  it('retries once when a time is invalid', async () => {
    const bad = {
      courses: [
        { name: 'Chemistry', sessions: [{ weekday: 4, start: '25:00', end: '26:00', weeks: '1-8' }] },
      ],
    };
    const { transport, requests } = scriptedTransport([
      llmResponse({ content: JSON.stringify(bad) }),
      llmResponse({ content: JSON.stringify(validDraft()) }),
    ]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses).toHaveLength(1);
    const retryMessage = requests[1].messages[3];
    expect(retryMessage.content).toContain('invalid start time');
    expect(retryMessage.content).toContain('25:00');
  });

  it('retries once when the JSON has the wrong shape', async () => {
    const { transport, requests } = scriptedTransport([
      llmResponse({ content: JSON.stringify({ courses: 'all of them' }) }),
      llmResponse({ content: JSON.stringify(validDraft()) }),
    ]);
    const draft = await extractTimetable({ transport, imageDataUrl: DATA_URL, semester });

    expect(draft.courses).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[3].content).toContain('does not match the timetable schema');
  });

  it('throws after the single retry', async () => {
    const { transport, requests } = scriptedTransport([
      llmResponse({ content: 'nope' }),
      llmResponse({ content: 'still nope' }),
    ]);
    await expect(extractTimetable({ transport, imageDataUrl: DATA_URL, semester })).rejects.toThrowError(
      /timetable extraction failed after one retry/,
    );
    expect(requests).toHaveLength(2);
  });

  it('propagates an abort without retrying', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const { transport, requests } = failingTransport(abortError);
    await expect(extractTimetable({ transport, imageDataUrl: DATA_URL, semester })).rejects.toBe(abortError);
    expect(requests).toHaveLength(1);
  });
});
