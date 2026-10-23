import { describe, expect, it } from 'vitest';
import { MAX_TURN_IMAGES, buildHistoryMessages, buildSystemPrompt, buildUserMessage } from '../../src/prompt';
import type { Semester } from '../../src/types';

const TZ_SHANGHAI = 8 * 60 * 60 * 1000;

const semester: Semester = { firstMonday: { year: 2026, month: 8, day: 31 }, totalWeeks: 20 };

function promptAt(now: number, options: { tzOffset?: number; semester?: Semester | null } = {}): string {
  return buildSystemPrompt({
    now,
    tzOffset: options.tzOffset ?? TZ_SHANGHAI,
    lang: 'zh',
    semester: options.semester === undefined ? semester : options.semester,
    snapshot: 'SNAPSHOT-LINE-1\nSNAPSHOT-LINE-2',
  });
}

describe('buildSystemPrompt', () => {
  it('states the local clock, weekday and offset', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('Current local time: 2026-10-23 09:20 (Friday), timezone UTC+08:00');
  });

  it('formats a negative offset', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 2, 0), { tzOffset: -5 * 60 * 60 * 1000 });
    expect(prompt).toContain('Current local time: 2026-10-22 21:00 (Thursday), timezone UTC-05:00');
  });

  it('states the current teaching week', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('Semester: week 8 of 20 (week 1 starts 2026-08-31).');
  });

  it('explains a date before and after the semester', () => {
    expect(promptAt(Date.UTC(2026, 6, 15, 0, 0))).toContain(
      'Semester: teaching week 1 of 20 starts on 2026-08-31; today is before the semester.',
    );
    expect(promptAt(Date.UTC(2027, 1, 1, 0, 0))).toContain(
      'Semester: ended after 20 weeks from 2026-08-31; today is after the semester.',
    );
  });

  it('says when no semester is configured', () => {
    expect(promptAt(Date.UTC(2026, 9, 23, 1, 20), { semester: null })).toContain('Semester: not configured');
  });

  it('includes the snapshot verbatim', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('Live context snapshot:\nSNAPSHOT-LINE-1\nSNAPSHOT-LINE-2');
  });

  it('spells out the hard rules', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('Facts only from tool results');
    expect(prompt).toContain('Every change goes through a tool');
    expect(prompt).toContain('ok:false is a failure');
    expect(prompt).toContain('Dates are YYYY-MM-DD and times are HH:mm (24-hour)');
    expect(prompt).toContain('Never invent ids');
  });

  it('tells the model to ask with the tool and use the playbook', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('## Ask, don’t guess');
    expect(prompt).toContain('call ask_user with 2–5 short options');
    expect(prompt).toContain('Ask one question at a time');

    for (const skill of [
      'capture_from_text',
      'timetable_import',
      'screenshot_to_todos',
      'day_planning',
      'reschedule',
      'timetable_qa',
      'cleanup',
    ]) {
      expect(prompt).toContain(`### ${skill}`);
    }
    expect(prompt).toContain('Never call create_recurring for a grid');
    expect(prompt).toContain('Never do week math from memory');
  });

  it('states the image rules and reply style', () => {
    const prompt = promptAt(Date.UTC(2026, 9, 23, 1, 20));
    expect(prompt).toContain('An attached image is not automatically a timetable');
    expect(prompt).toContain('classify it first');
    expect(prompt).toContain('use ask_user instead of guessing');
    expect(prompt).toContain('No HTML, no Markdown tables, no headings');
    expect(prompt).toContain('current UI language is zh');
  });
});

describe('buildHistoryMessages', () => {
  it('maps stored turns to wire messages in order', () => {
    expect(
      buildHistoryMessages([
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'second' },
        { role: 'user', text: 'third' },
      ]),
    ).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
  });

  it('returns an empty list for no history', () => {
    expect(buildHistoryMessages([])).toEqual([]);
  });
});

describe('buildUserMessage', () => {
  it('builds a text-only user message', () => {
    expect(buildUserMessage('hello')).toEqual({ role: 'user', content: 'hello' });
  });

  it('adds the image as a content part after the text', () => {
    const message = buildUserMessage('what is this?', [
      { id: 'img-1', dataUrl: 'data:image/png;base64,AAAA', name: 'timetable.png' },
    ]);
    expect(message.role).toBe('user');
    expect(Array.isArray(message.content)).toBe(true);
    if (!Array.isArray(message.content)) throw new Error('expected content parts');
    expect(message.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('keeps at most MAX_TURN_IMAGES images', () => {
    const images = Array.from({ length: MAX_TURN_IMAGES + 2 }, (_value, index) => ({
      id: `img-${index}`,
      dataUrl: `data:image/png;base64,${index}`,
    }));
    const message = buildUserMessage('many', images);
    if (!Array.isArray(message.content)) throw new Error('expected content parts');
    expect(message.content).toHaveLength(1 + MAX_TURN_IMAGES);
  });

  it('sends an image-only turn without an empty text part', () => {
    const message = buildUserMessage('', [{ id: 'img-1', dataUrl: 'data:image/png;base64,AAAA' }]);
    expect(message.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  });
});
