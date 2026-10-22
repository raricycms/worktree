import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeState, civilFromTimestamp, newId } from '@worktree/core';
import { runAgentTurn } from '../src/agent';
import { buildContextSnapshot } from '../src/context';
import { buildSystemPrompt } from '../src/prompt';
import { createChatTransport } from '../src/provider';
import { createTools } from '../src/tools';
import { extractTimetable } from '../src/vision';
import type { Semester, ToolContext } from '../src/types';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
const imagePath = process.env.DEEPSEEK_TIMETABLE_IMAGE ?? '';

function liveKey(): string {
  if (apiKey === '') throw new Error('DEEPSEEK_API_KEY is not set');
  return apiKey;
}

function liveContext(): ToolContext {
  const now = Date.now();
  const tzOffset = -new Date().getTimezoneOffset() * 60_000;
  const state = new WorktreeState();
  return { state, now, tzOffset, semester: null, newId };
}

const live = apiKey === '' ? describe.skip : describe;

live('live DeepSeek provider', () => {
  it(
    'creates a reminded event through a real tool-calling turn',
    { timeout: 180_000 },
    async () => {
      const context = liveContext();
      const systemPrompt = buildSystemPrompt({
        now: context.now,
        tzOffset: context.tzOffset,
        lang: 'zh',
        semester: null,
        snapshot: buildContextSnapshot({
          state: context.state,
          now: context.now,
          tzOffset: context.tzOffset,
          semester: null,
        }),
      });
      const transport = createChatTransport({ baseUrl, model, apiKey: liveKey() });
      const result = await runAgentTurn({
        transport,
        systemPrompt,
        history: [],
        userText: '今天下午3点开会，提前15分钟提醒',
        context,
        tools: createTools(),
      });
      console.info('[live] final text:', result.text);
      console.info('[live] steps:', result.steps);
      console.info('[live] ops:', result.ops.map((op) => op.kind));

      expect(result.stoppedByLimit).toBe(false);
      expect(result.text.trim().length).toBeGreaterThan(0);
      const eventSteps = result.steps.filter((step) => step.tool === 'create_event');
      expect(eventSteps.length).toBeGreaterThan(0);
      expect(eventSteps[0].ok).toBe(true);

      const replay = WorktreeState.fromOps(result.ops);
      const blocks = replay.calendar.getBlocks();
      expect(blocks.length).toBeGreaterThan(0);
      const block = blocks[0];

      const { time } = civilFromTimestamp(block.start, context.tzOffset);
      expect(time.hour).toBe(15);

      if (block.nodeId === undefined) throw new Error('the created block should link a node');
      const node = replay.tree.getNode(block.nodeId);
      if (node === undefined) throw new Error('the linked node is missing after replay');
      expect(node.reminders.length).toBeGreaterThan(0);
      expect(node.reminders.some((reminder) => reminder.deadline === block.start - 15 * 60_000)).toBe(true);
      console.info(
        '[live] replay ok: block',
        new Date(block.start).toISOString(),
        '->',
        new Date(block.end).toISOString(),
        'node',
        node.name,
        'reminders',
        node.reminders.map((reminder) => reminder.deadline),
      );
    },
  );
});

describe.skipIf(imagePath === '' || apiKey === '')('live timetable vision', () => {
  it(
    'extracts courses from the configured timetable image',
    { timeout: 240_000 },
    async () => {
      const extension = extname(imagePath).toLowerCase();
      const mime =
        extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.webp'
            ? 'image/webp'
            : 'image/png';
      const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
      const semester: Semester = { firstMonday: { year: 2026, month: 8, day: 31 }, totalWeeks: 16 };
      const transport = createChatTransport({ baseUrl, model, apiKey });
      const draft = await extractTimetable({
        transport,
        imageDataUrl: dataUrl,
        semester,
        language: 'zh',
      });
      const sessionCount = draft.courses.reduce((total, course) => total + course.sessions.length, 0);
      console.info(
        '[live] vision:',
        draft.courses.length,
        'courses,',
        sessionCount,
        'sessions, warnings:',
        draft.warnings,
      );

      expect(draft.courses.length).toBeGreaterThan(0);
      expect(sessionCount).toBeGreaterThanOrEqual(8);
    },
  );
});
