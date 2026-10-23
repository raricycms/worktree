import { describe, expect, it } from 'vitest';
import { ROOT_ID, WorktreeState } from '@worktree/core';
import type { Operation } from '@worktree/core';
import { createTools } from '../../src/tools';
import type { Semester, Tool, ToolContext, ToolRunResult } from '../../src/types';
import { NOW, addBlock, addNode, addWeeklyRule, makeContext, timestampAt } from './fixtures';

const TOOL_NAMES = [
  'get_agenda',
  'search_tasks',
  'get_task',
  'get_tree',
  'list_rules',
  'find_free_slots',
  'suggest_tasks',
  'create_event',
  'create_task',
  'create_tasks',
  'create_recurring',
  'update_event',
  'update_task',
  'complete_task',
  'cancel_event',
  'cancel_recurring',
  'move_node',
  'delete_node',
  'import_timetable',
  'ask_user',
];

const SEMESTER: Semester = { firstMonday: { year: 2026, month: 8, day: 31 }, totalWeeks: 16 };

const tools = createTools();

function getTool(name: string): Tool {
  const found = tools.find((tool) => tool.definition.name === name);
  if (found === undefined) throw new Error(`missing tool: ${name}`);
  return found;
}

/** Tool.run may be async (ask_user waits for the human), so every call awaits. */
async function run(name: string, args: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  return await getTool(name).run(args, ctx);
}

function addedNodeId(ops: Operation[] | undefined, name: string): string {
  if (ops === undefined) throw new Error('expected ops');
  const op = ops.find((candidate) => candidate.kind === 'add' && candidate.name === name);
  if (op === undefined || op.kind !== 'add') throw new Error(`missing add op for ${name}`);
  return op.id;
}

function addedBlockId(ops: Operation[] | undefined): string {
  if (ops === undefined) throw new Error('expected ops');
  const op = ops.find((candidate) => candidate.kind === 'add_block');
  if (op === undefined || op.kind !== 'add_block') throw new Error('missing add_block op');
  return op.id;
}

function addedRuleId(ops: Operation[] | undefined): string {
  if (ops === undefined) throw new Error('expected ops');
  const op = ops.find((candidate) => candidate.kind === 'add_block_rule');
  if (op === undefined || op.kind !== 'add_block_rule') throw new Error('missing add_block_rule op');
  return op.id;
}

function opKinds(ops: Operation[] | undefined): string[] {
  return (ops ?? []).map((op) => op.kind);
}

async function createEventTool(ctxVal: ToolContext, title = 'Standup'): Promise<{ nodeId: string; blockId: string }> {
  const result = await run(
    'create_event',
    { title, date: '2026-10-25', start_time: '09:00', end_time: '10:00' },
    ctxVal,
  );
  return { nodeId: addedNodeId(result.ops, title), blockId: addedBlockId(result.ops) };
}

describe('createTools', () => {
  it('exposes the twenty documented tools in contract order with object schemas', () => {
    expect(tools.map((tool) => tool.definition.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.definition.parameters.type).toBe('object');
      expect(tool.definition.description.length).toBeGreaterThan(60);
    }
  });

  it('tells the model when to use ask_user and import_timetable', () => {
    expect(getTool('ask_user').definition.description).toContain('instead of asking in prose');
    expect(getTool('ask_user').definition.description).toContain('one question at a time');
    expect(getTool('import_timetable').definition.description).toContain('Never use create_recurring for a timetable grid');
  });

  it('rejects malformed arguments with the expected shape', async () => {
    const ctxVal = makeContext(new WorktreeState());
    await expect(run('create_event', {}, ctxVal)).rejects.toThrow(/invalid arguments for create_event: expected \{title/);
    await expect(
      run('create_event', { title: 'x', date: '2026/10/25', start_time: '09:00', end_time: '10:00' }, ctxVal),
    ).rejects.toThrow(/expected YYYY-MM-DD/);
    await expect(
      run('create_event', { title: 'x', date: '2026-10-25', start_time: '9:00', end_time: '10:00' }, ctxVal),
    ).rejects.toThrow(/expected HH:mm/);
    await expect(
      run(
        'create_recurring',
        { title: 'x', weekdays: [0], start_time: '09:00', end_time: '10:00', start_date: '2026-09-07' },
        ctxVal,
      ),
    ).rejects.toThrow(/invalid arguments for create_recurring/);
    await expect(run('get_task', {}, ctxVal)).rejects.toThrow(/task_id/);
    await expect(run('complete_task', { task_id: 5 }, ctxVal)).rejects.toThrow(/invalid arguments/);
    expect(ctxVal.state.tree.nodeCount()).toBe(0);
  });
});

describe('read tools', () => {
  it('runs queries directly on the context and never mutates it', async () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'task', 'Task', { deadline: NOW + 60 * 60 * 1000 }),
    ]);
    const ctxVal = makeContext(state);
    const before = state.tree.nodeCount();
    const agenda = await run('get_agenda', {}, ctxVal);
    expect(agenda.ops).toBeUndefined();
    const search = await run('search_tasks', { keyword: 'Task' }, ctxVal);
    expect(search.summary).toContain('[task] Task');
    expect((await run('get_task', { task_id: 'task' }, ctxVal)).summary).toContain('Task [task] Task');
    expect(state.tree.nodeCount()).toBe(before);
  });

  it('surfaces unknown ids and paths as errors', async () => {
    const ctxVal = makeContext(new WorktreeState());
    await expect(run('get_task', { task_id: 'missing' }, ctxVal)).rejects.toThrow(/unknown task id/);
    await expect(run('search_tasks', { path: '/nope' }, ctxVal)).rejects.toThrow(/unknown path/);
  });

  it('finds free slots inside the working window', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    await createEventTool(ctxVal);
    const free = await run('find_free_slots', { date: '2026-10-25' }, ctxVal);
    expect(free.summary).toContain('08:00-09:00 (60 min)');
    expect(free.summary).toContain('10:00-23:00 (780 min)');
    const narrow = await run('find_free_slots', { date: '2026-10-25', min_minutes: 800 }, ctxVal);
    expect(narrow.summary).toContain('No free slots of at least 800 minutes');
  });
});

describe('write tools chain on the dry-run state', () => {
  it('create_event then get_agenda sees the write, and the ops replay cleanly', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run(
      'create_event',
      { title: 'Standup', date: '2026-10-25', start_time: '09:00', end_time: '10:00', location: 'Room 3' },
      ctxVal,
    );
    const blockId = addedBlockId(created.ops);
    expect(created.summary).toContain(`block ${blockId}`);
    expect(created.summary).toContain('reminder 15 min before');

    const agenda = await run('get_agenda', { from: '2026-10-25', to: '2026-10-25' }, ctxVal);
    expect(agenda.summary).toContain('Standup');
    expect(agenda.summary).toContain(`block ${blockId}`);

    const replay = WorktreeState.fromOps(created.ops ?? []);
    expect(replay.calendar.blockCount()).toBe(1);
    expect(replay.tree.nodeCount()).toBe(2);
    expect(state.calendar.blockCount()).toBe(1);
  });

  it('create_task then search_tasks and get_task expose deadline, reminder and id', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run(
      'create_task',
      { title: 'Write report', due_date: '2026-10-30', due_time: '17:00', remind_minutes_before: 30 },
      ctxVal,
    );
    const nodeId = addedNodeId(created.ops, 'Write report');
    expect(created.summary).toContain(`node ${nodeId}`);
    expect(created.summary).toContain('/tmp/Write report');
    expect(state.tree.getNode(nodeId)?.deadline).toBeGreaterThan(0);

    const search = await run('search_tasks', { keyword: 'report' }, ctxVal);
    expect(search.summary).toContain(`[${nodeId}] Write report`);
    expect(search.summary).toContain('due 2026-10-30 17:00');
    expect(search.summary).toContain('1 reminder(s)');

    const detail = await run('get_task', { task_id: nodeId }, ctxVal);
    expect(detail.summary).toContain('/tmp/Write report');
    expect(detail.summary).toContain('Reminders: 1');
    expect(detail.summary).toContain('Linked block: none');
  });

  it('complete_task flips the node and search_tasks follows the filter', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run('create_task', { title: 'Finish me' }, ctxVal);
    const nodeId = addedNodeId(created.ops, 'Finish me');

    expect((await run('search_tasks', { keyword: 'Finish me' }, ctxVal)).summary).toContain(`[${nodeId}]`);
    const completed = await run('complete_task', { task_id: nodeId }, ctxVal);
    expect(completed.summary).toContain('Completed task');
    expect(state.tree.getNode(nodeId)?.status).toBe(true);
    expect((await run('search_tasks', { keyword: 'Finish me' }, ctxVal)).summary).toBe('No matching tasks.');
    expect(
      (await run('search_tasks', { keyword: 'Finish me', include_completed: true }, ctxVal)).summary,
    ).toContain('completed');

    const reopened = await run('complete_task', { task_id: nodeId, completed: false }, ctxVal);
    expect(reopened.summary).toContain('Uncompleted');
    expect(state.tree.getNode(nodeId)?.status).toBe(false);
  });

  it('create_recurring then get_agenda lists an occurrence', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run(
      'create_recurring',
      {
        title: 'Math',
        weekdays: [1, 3],
        start_time: '09:00',
        end_time: '10:00',
        start_date: '2026-09-07',
        until_date: '2026-09-20',
      },
      ctxVal,
    );
    const ruleId = addedRuleId(created.ops);
    expect(created.summary).toContain(ruleId);
    expect(created.summary).toContain('Monday, Wednesday');
    expect(state.calendar.ruleCount()).toBe(1);

    const agenda = await run('get_agenda', { from: '2026-09-07', to: '2026-09-07' }, ctxVal);
    expect(agenda.summary).toContain('Math');
    expect(agenda.summary).toContain('occurrence');
  });

  it('update_event patches the block and cancel_event removes it', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const { nodeId, blockId } = await createEventTool(ctxVal);

    const updated = await run('update_event', { event_id: blockId, title: 'Daily', start_time: '11:00' }, ctxVal);
    expect(updated.summary).toContain(`Updated event ${blockId}`);
    expect(updated.summary).toContain('as "Daily"');
    expect(state.calendar.getBlocks()[0]?.start).toBe(timestampAt('2026-10-25', '11:00'));

    const cancelled = await run('cancel_event', { event_id: nodeId }, ctxVal);
    expect(cancelled.summary).toContain('Cancelled event');
    expect(state.calendar.blockCount()).toBe(0);
    expect(state.tree.getNode(nodeId)).toBeUndefined();
  });

  it('leaves the context untouched when a write is rejected', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    await expect(
      run('create_event', { title: 'Broken', date: '2026-10-25', start_time: '10:00', end_time: '09:00' }, ctxVal),
    ).rejects.toThrow(/end_time must be after start_time/);
    expect(state.tree.nodeCount()).toBe(0);
    expect(state.calendar.blockCount()).toBe(0);

    await expect(run('update_event', { event_id: 'missing' }, ctxVal)).rejects.toThrow(/at least one of/);
    await expect(run('cancel_event', { event_id: 'missing' }, ctxVal)).rejects.toThrow(/unknown event id/);
    await expect(run('complete_task', { task_id: 'missing' }, ctxVal)).rejects.toThrow(/unknown task id/);
  });
});

describe('suggest_tasks tool', () => {
  it('returns the ranked ids with reasons', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const overdue = await run('create_task', { title: 'Late', due_date: '2026-10-20' }, ctxVal);
    const overdueId = addedNodeId(overdue.ops, 'Late');
    const leisure = await run('create_task', { title: 'Leisure' }, ctxVal);
    const leisureId = addedNodeId(leisure.ops, 'Leisure');

    const suggested = await run('suggest_tasks', {}, ctxVal);
    const lines = suggested.summary.split('\n');
    expect(lines[0]).toContain(`[${overdueId}] Late`);
    expect(lines[0]).toContain('overdue since 2026-10-20 23:59');
    expect(lines[1]).toContain(`[${leisureId}] Leisure`);
    expect(lines[1]).toContain('no deadline');
    expect(suggested.ops).toBeUndefined();
  });
});

describe('ask_user tool', () => {
  it('pauses on the callback and reports the answer', async () => {
    const requests: { question: string; options: string[] }[] = [];
    const ctxVal = makeContext(new WorktreeState(), {
      askUser: async (request) => {
        requests.push(request);
        return 'Tomorrow';
      },
    });

    const result = await run('ask_user', { question: ' When? ', options: ['Today', 'Tomorrow'] }, ctxVal);

    expect(result.summary).toBe('User answered: Tomorrow');
    expect(result.ops).toBeUndefined();
    expect(requests).toEqual([{ question: 'When?', options: ['Today', 'Tomorrow'] }]);
  });

  it('passes an empty option list for a free-text question', async () => {
    const requests: { question: string; options: string[] }[] = [];
    const ctxVal = makeContext(new WorktreeState(), {
      askUser: async (request) => {
        requests.push(request);
        return 'next Monday';
      },
    });

    const result = await run('ask_user', { question: 'When should it be?' }, ctxVal);
    expect(requests[0].options).toEqual([]);
    expect(result.summary).toBe('User answered: next Monday');
  });

  it('throws a clear error when no interactive channel is attached', async () => {
    await expect(run('ask_user', { question: 'When?' }, makeContext(new WorktreeState()))).rejects.toThrow(
      /ask_user is unavailable in this run/,
    );
  });

  it('rejects an option list outside 2..5 entries', async () => {
    const ctxVal = makeContext(new WorktreeState(), { askUser: async () => 'x' });
    await expect(run('ask_user', { question: 'Q?', options: ['only one'] }, ctxVal)).rejects.toThrow(
      /invalid arguments for ask_user/,
    );
    await expect(
      run('ask_user', { question: 'Q?', options: ['a', 'b', 'c', 'd', 'e', 'f'] }, ctxVal),
    ).rejects.toThrow(/invalid arguments for ask_user/);
  });

  it('propagates an abort instead of turning it into a tool failure', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const ctxVal = makeContext(new WorktreeState(), {
      askUser: async () => {
        throw abortError;
      },
    });
    await expect(run('ask_user', { question: 'When?' }, ctxVal)).rejects.toBe(abortError);
  });
});

describe('import_timetable tool', () => {
  const rows = [
    { course: ' Calculus ', weekday: 1, start: '08:00', end: '09:40', weeks: '1-8', teacher: ' Li ', location: ' A101 ' },
    { course: 'Physics', weekday: 3, start: '10:00', end: '11:40' },
  ];

  it('builds a validated preview artifact and writes nothing', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state, { semester: SEMESTER });
    const result = await run('import_timetable', { rows, warnings: [' bottom row cut '] }, ctxVal);

    expect(result.ops).toBeUndefined();
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts?.[0];
    if (artifact === undefined) throw new Error('expected an artifact');
    expect(artifact.kind).toBe('timetable');
    expect(artifact.rows).toHaveLength(2);
    expect(artifact.rows[0]).toEqual({
      id: 'id-1',
      course: 'Calculus',
      weekday: 1,
      start: '08:00',
      end: '09:40',
      weeks: '1-8',
      teacher: 'Li',
      location: 'A101',
    });
    // weeks defaults to the whole configured semester
    expect(artifact.rows[1].weeks).toBe('1-16');
    expect(artifact.warnings).toEqual(['bottom row cut']);
    expect(result.summary).toContain('Prepared a timetable preview with 2 rows');
    expect(result.summary).toContain('confirms or edits');
    expect(state.tree.nodeCount()).toBe(0);
    expect(state.calendar.ruleCount()).toBe(0);
  });

  it('requires weeks when no semester is configured', async () => {
    const ctxVal = makeContext(new WorktreeState());
    await expect(run('import_timetable', { rows: [{ course: 'Math', weekday: 1, start: '08:00', end: '09:00' }] }, ctxVal)).rejects.toThrow(
      /row 1, field "weeks"/,
    );
  });

  it('mentions the missing semester in the summary', async () => {
    const ctxVal = makeContext(new WorktreeState());
    const result = await run(
      'import_timetable',
      { rows: [{ course: 'Math', weekday: 1, start: '08:00', end: '09:00', weeks: '1-16' }] },
      ctxVal,
    );
    expect(result.summary).toContain('No semester is configured');
  });

  it('names the 1-based row index and field for every invalid row', async () => {
    const ctxVal = makeContext(new WorktreeState(), { semester: SEMESTER });
    const good = { course: 'Math', weekday: 1, start: '08:00', end: '09:00', weeks: '1-16' };
    const invalid = [
      [{ ...good, course: '  ' }, /row 1, field "course"/],
      [{ ...good, weekday: 9 }, /row 1, field "weekday"/],
      [{ ...good, weekday: 'Monday' }, /row 1, field "weekday"/],
      [{ ...good, start: '8:00' }, /row 1, field "start"/],
      [{ ...good, end: '25:00' }, /row 1, field "end"/],
      [{ ...good, start: '10:00', end: '09:00' }, /row 1, field "end"/],
      [{ ...good, weeks: '16-1' }, /row 1, field "weeks"/],
      [{ ...good, weeks: 'abc' }, /row 1, field "weeks"/],
      [{ ...good, teacher: 42 }, /row 1, field "teacher"/],
    ] as const;
    for (const [row, pattern] of invalid) {
      await expect(run('import_timetable', { rows: [row] }, ctxVal)).rejects.toThrow(pattern);
    }
  });

  it('reports the failing row of a multi-row call by its 1-based index', async () => {
    const ctxVal = makeContext(new WorktreeState(), { semester: SEMESTER });
    const rowsInput = [
      { course: 'Math', weekday: 1, start: '08:00', end: '09:00', weeks: '1-16' },
      { course: 'Physics', weekday: 2, start: '08:00', end: '09:00', weeks: '1-16' },
      { course: 'Chem', weekday: 8, start: '08:00', end: '09:00', weeks: '1-16' },
    ];
    await expect(run('import_timetable', { rows: rowsInput }, ctxVal)).rejects.toThrow(/row 3, field "weekday"/);
  });

  it('rejects an empty row list', async () => {
    const ctxVal = makeContext(new WorktreeState(), { semester: SEMESTER });
    await expect(run('import_timetable', { rows: [] }, ctxVal)).rejects.toThrow(/invalid arguments for import_timetable/);
  });
});

describe('create_tasks tool', () => {
  it('creates every task in one call and returns all ops', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const result = await run(
      'create_tasks',
      {
        tasks: [
          { title: 'Read chapter 3', due_date: '2026-10-30', due_time: '17:00', remind_minutes_before: 30 },
          { title: 'Email tutor', note: 'ask about the lab' },
        ],
      },
      ctxVal,
    );

    expect(result.ops).toHaveLength(5);
    expect(opKinds(result.ops)).toEqual(['add', 'add', 'edit_node', 'add_reminder', 'add']);
    expect(result.summary).toContain('Created 2 tasks:');
    expect(result.summary).toContain('1. /tmp/Read chapter 3');
    expect(result.summary).toContain('2. /tmp/Email tutor');
    const firstId = addedNodeId(result.ops, 'Read chapter 3');
    expect(state.tree.getNode(firstId)?.deadline).toBe(timestampAt('2026-10-30', '17:00'));
    expect(state.tree.getNode(firstId)?.reminders).toHaveLength(1);
  });

  it('is atomic: a failing item rejects the whole batch and writes nothing', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    await expect(
      run(
        'create_tasks',
        { tasks: [{ title: 'Valid' }, { title: 'Bad/Name' }] },
        ctxVal,
      ),
    ).rejects.toThrow(/create_tasks: task 2 \("Bad\/Name"\)/);
    expect(state.tree.nodeCount()).toBe(0);
  });

  it('rejects an empty or oversized batch', async () => {
    const ctxVal = makeContext(new WorktreeState());
    await expect(run('create_tasks', { tasks: [] }, ctxVal)).rejects.toThrow(/invalid arguments for create_tasks/);
    const tooMany = Array.from({ length: 31 }, (_value, index) => ({ title: `t${index}` }));
    await expect(run('create_tasks', { tasks: tooMany }, ctxVal)).rejects.toThrow(
      /invalid arguments for create_tasks/,
    );
  });
});

describe('update_task tool', () => {
  async function createDeadlineTask(ctxVal: ToolContext): Promise<string> {
    const created = await run(
      'create_task',
      { title: 'Report', due_date: '2026-10-30', due_time: '17:00', remind_minutes_before: 30 },
      ctxVal,
    );
    return addedNodeId(created.ops, 'Report');
  }

  it('renames, edits the note and moves the deadline together with its reminder', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const nodeId = await createDeadlineTask(ctxVal);

    const updated = await run(
      'update_task',
      { task_id: nodeId, title: 'Final report', note: 'v2', due_date: '2026-10-31', due_time: '12:00' },
      ctxVal,
    );

    expect(opKinds(updated.ops)).toEqual(['edit_node', 'rename', 'edit_reminder']);
    const node = state.tree.getNode(nodeId);
    expect(node?.name).toBe('Final report');
    expect(node?.note).toBe('v2');
    expect(node?.deadline).toBe(timestampAt('2026-10-31', '12:00'));
    expect(node?.reminders).toHaveLength(1);
    expect(node?.reminders[0].name).toBe('Final report');
    // The 30-minute offset follows the deadline rather than the old instant.
    expect(node?.reminders[0].deadline).toBe(timestampAt('2026-10-31', '11:30'));
    expect(updated.summary).toContain('deadline 2026-10-31 12:00');
    expect(updated.summary).toContain('deadline reminders moved');
  });

  it('replaces the deadline reminder offset', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const nodeId = await createDeadlineTask(ctxVal);

    const updated = await run('update_task', { task_id: nodeId, remind_minutes_before: 60 }, ctxVal);

    expect(opKinds(updated.ops)).toEqual(['edit_reminder']);
    const node = state.tree.getNode(nodeId);
    expect(node?.deadline).toBe(timestampAt('2026-10-30', '17:00'));
    expect(node?.reminders[0].deadline).toBe(timestampAt('2026-10-30', '16:00'));
    expect(updated.summary).toContain('reminder 60 min before');
  });

  it('adds a deadline reminder when none exists yet', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run('create_task', { title: 'No reminder', due_date: '2026-10-30' }, ctxVal);
    const nodeId = addedNodeId(created.ops, 'No reminder');

    const updated = await run('update_task', { task_id: nodeId, remind_minutes_before: 15 }, ctxVal);
    expect(opKinds(updated.ops)).toEqual(['add_reminder']);
    expect(state.tree.getNode(nodeId)?.reminders).toHaveLength(1);
    expect(state.tree.getNode(nodeId)?.reminders[0].deadline).toBe(timestampAt('2026-10-30', '23:44'));
  });

  it('clears the deadline and its reminder', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const nodeId = await createDeadlineTask(ctxVal);

    const updated = await run('update_task', { task_id: nodeId, clear_deadline: true }, ctxVal);

    expect(opKinds(updated.ops)).toEqual(['edit_node', 'remove_reminder']);
    const node = state.tree.getNode(nodeId);
    expect(node?.deadline).toBeUndefined();
    expect(node?.reminders).toEqual([]);
    expect(updated.summary).toContain('deadline cleared');
  });

  it('treats remind_minutes_before 0 together with clear_deadline as one removal', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const nodeId = await createDeadlineTask(ctxVal);

    const updated = await run(
      'update_task',
      { task_id: nodeId, clear_deadline: true, remind_minutes_before: 0 },
      ctxVal,
    );
    expect(updated.ops).toBeDefined();
    expect(state.tree.getNode(nodeId)?.deadline).toBeUndefined();
    expect(state.tree.getNode(nodeId)?.reminders).toEqual([]);
  });

  it('validates contradictory or unknown edits', async () => {
    const ctxVal = makeContext(new WorktreeState());
    const noDeadline = await run('create_task', { title: 'Plain' }, ctxVal);
    const plainId = addedNodeId(noDeadline.ops, 'Plain');

    await expect(run('update_task', { task_id: 'missing', title: 'x' }, ctxVal)).rejects.toThrow(/unknown task id/);
    await expect(run('update_task', { task_id: plainId }, ctxVal)).rejects.toThrow(/at least one of/);
    await expect(
      run('update_task', { task_id: plainId, clear_deadline: true, due_date: '2026-11-01' }, ctxVal),
    ).rejects.toThrow(/clear_deadline cannot be combined/);
    await expect(run('update_task', { task_id: plainId, clear_deadline: true }, ctxVal)).rejects.toThrow(
      /has no deadline to clear/,
    );
    await expect(run('update_task', { task_id: plainId, due_time: '09:00' }, ctxVal)).rejects.toThrow(
      /due_time requires due_date/,
    );
    await expect(
      run('update_task', { task_id: plainId, remind_minutes_before: 15 }, ctxVal),
    ).rejects.toThrow(/requires a deadline/);
    expect(ctxVal.state.tree.getNode(plainId)?.deadline).toBeUndefined();
  });

  it('refuses to guess between several deadline reminders', async () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'task', 'Task', { deadline: timestampAt('2026-10-30', '17:00') }),
      { kind: 'add_reminder', nodeId: 'task', rmdId: 'r1', name: 'Task', deadline: timestampAt('2026-10-30', '16:00') },
      { kind: 'add_reminder', nodeId: 'task', rmdId: 'r2', name: 'Task', deadline: timestampAt('2026-10-30', '15:00') },
    ]);
    const ctxVal = makeContext(state);
    await expect(run('update_task', { task_id: 'task', remind_minutes_before: 10 }, ctxVal)).rejects.toThrow(
      /refusing to guess/,
    );
    await expect(run('update_task', { task_id: 'task', clear_deadline: true }, ctxVal)).resolves.toBeDefined();
  });
});

describe('get_tree tool', () => {
  function treeState(): WorktreeState {
    return WorktreeState.fromOps([
      addNode(ROOT_ID, 'work', 'work'),
      addNode('work', 'report', 'report'),
      addNode('report', 'sub', 'sub'),
      addNode(ROOT_ID, 'archive', 'archive'),
      addNode('archive', 'done', 'done'),
      { kind: 'complete', id: 'done' },
    ]);
  }

  it('renders ids, indentation and completion marks', async () => {
    const ctxVal = makeContext(treeState());
    const tree = await run('get_tree', { include_completed: true }, ctxVal);
    expect(tree.summary).toContain('Tree at / (depth 3):');
    expect(tree.summary).toContain('- [work] work');
    expect(tree.summary).toContain('  - [report] report');
    expect(tree.summary).toContain('    - [sub] sub');
    expect(tree.summary).toContain('  - [done] done (completed)');
  });

  it('hides completed nodes by default and honours the depth limit', async () => {
    const ctxVal = makeContext(treeState());
    const tree = await run('get_tree', { depth: 2 }, ctxVal);
    expect(tree.summary).not.toContain('[done]');
    expect(tree.summary).toContain('[report]');
    expect(tree.summary).not.toContain('[sub]');
  });

  it('scopes to a path', async () => {
    const ctxVal = makeContext(treeState());
    const tree = await run('get_tree', { path: '/work', depth: 1 }, ctxVal);
    expect(tree.summary).toContain('Tree at /work');
    expect(tree.summary).toContain('- [work] work');
    expect(tree.summary).toContain('  - [report] report');
    expect(tree.summary).not.toContain('[sub]');
  });

  it('caps a large tree and reports how many nodes are hidden', async () => {
    const ops: Operation[] = [];
    for (let index = 0; index < 305; index++) {
      ops.push(addNode(ROOT_ID, `n${index}`, `n${index}`));
    }
    const ctxVal = makeContext(WorktreeState.fromOps(ops));
    const tree = await run('get_tree', {}, ctxVal);
    const lines = tree.summary.split('\n');
    expect(lines).toHaveLength(302);
    expect(lines[lines.length - 1]).toBe('- ... 5 more');
  });

  it('rejects a missing path', async () => {
    await expect(run('get_tree', { path: '/nope' }, makeContext(treeState()))).rejects.toThrow(/unknown path/);
  });
});

describe('list_rules and cancel_recurring tools', () => {
  it('lists nothing when no rule exists', async () => {
    const result = await run('list_rules', {}, makeContext(new WorktreeState()));
    expect(result.summary).toBe('No recurring rules.');
  });

  it('lists a rule with id, weekdays, time range and dates', async () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = await run(
      'create_recurring',
      {
        title: 'Math',
        weekdays: [1, 3],
        start_time: '09:00',
        end_time: '10:30',
        start_date: '2026-09-07',
        until_date: '2026-09-20',
        note: 'room 3',
      },
      ctxVal,
    );
    const ruleId = addedRuleId(created.ops);

    const listed = await run('list_rules', {}, ctxVal);
    expect(listed.summary).toContain(`[${ruleId}] Math`);
    expect(listed.summary).toContain('Monday, Wednesday');
    expect(listed.summary).toContain('09:00-10:30');
    expect(listed.summary).toContain('first 2026-09-07');
    expect(listed.summary).toContain('until 2026-09-20');
    expect(listed.summary).toContain('note: room 3');
  });

  it('cancels an existing rule and rejects an unknown id', async () => {
    const state = WorktreeState.fromOps([
      addWeeklyRule('rule-1', 'Math', { year: 2026, month: 9, day: 7 }, { hour: 9, minute: 0 }, 60 * 60 * 1000, [1]),
    ]);
    const ctxVal = makeContext(state);

    const cancelled = await run('cancel_recurring', { rule_id: 'rule-1' }, ctxVal);
    expect(opKinds(cancelled.ops)).toEqual(['remove_block_rule']);
    expect(cancelled.summary).toContain('rule-1');
    expect(state.calendar.ruleCount()).toBe(0);

    await expect(run('cancel_recurring', { rule_id: 'rule-1' }, ctxVal)).rejects.toThrow(/unknown rule id/);
  });
});

describe('move_node tool', () => {
  function moveState(): WorktreeState {
    return WorktreeState.fromOps([
      addNode(ROOT_ID, 'work', 'work'),
      addNode('work', 'report', 'report'),
      addNode(ROOT_ID, 'archive', 'archive'),
    ]);
  }

  it('moves a node (and its subtree) under a new parent', async () => {
    const state = moveState();
    const ctxVal = makeContext(state);
    const moved = await run('move_node', { node_id: 'report', parent_path: '/archive' }, ctxVal);

    expect(opKinds(moved.ops)).toEqual(['move']);
    expect(state.tree.getParentId('report')).toBe('archive');
    expect(moved.summary).toContain('/archive/report');
  });

  it('rejects an unknown node, an unknown path and the root', async () => {
    const ctxVal = makeContext(moveState());
    await expect(run('move_node', { node_id: 'nope', parent_path: '/archive' }, ctxVal)).rejects.toThrow(
      /unknown node id/,
    );
    await expect(run('move_node', { node_id: 'report', parent_path: '/nope' }, ctxVal)).rejects.toThrow(/unknown path/);
    await expect(run('move_node', { node_id: ROOT_ID, parent_path: '/archive' }, ctxVal)).rejects.toThrow(
      /unknown node id/,
    );
  });

  it('surfaces core rejections without mutating the state', async () => {
    const state = moveState();
    const ctxVal = makeContext(state);
    await expect(run('move_node', { node_id: 'work', parent_path: '/work/report/sub' }, ctxVal)).rejects.toThrow(
      /unknown path/,
    );
    await expect(run('move_node', { node_id: 'work', parent_path: '/work/report' }, ctxVal)).rejects.toThrow(
      /own subtree/,
    );
    expect(state.tree.getParentId('work')).toBe(ROOT_ID);
  });

  it('rejects a sibling name collision', async () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'work', 'work'),
      addNode('work', 'report', 'report'),
      addNode(ROOT_ID, 'archive', 'archive'),
      addNode('archive', 'report2', 'report', { weight: 2 }),
    ]);
    const ctxVal = makeContext(state);
    await expect(run('move_node', { node_id: 'report', parent_path: '/archive' }, ctxVal)).rejects.toThrow(
      /duplicate sibling name/,
    );
  });
});

describe('delete_node tool', () => {
  it('deletes a leaf node', async () => {
    const state = WorktreeState.fromOps([addNode(ROOT_ID, 'a', 'a')]);
    const ctxVal = makeContext(state);
    const deleted = await run('delete_node', { node_id: 'a' }, ctxVal);

    expect(opKinds(deleted.ops)).toEqual(['remove']);
    expect(state.tree.getNode('a')).toBeUndefined();
    expect(deleted.summary).toContain('Deleted node a');
  });

  it('refuses a node with children unless with_children is true', async () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'work', 'work'),
      addNode('work', 'report', 'report'),
      addNode('report', 'sub', 'sub'),
    ]);
    const ctxVal = makeContext(state);

    await expect(run('delete_node', { node_id: 'work' }, ctxVal)).rejects.toThrow(/it has 1 child node/);
    expect(state.tree.getNode('work')).toBeDefined();

    const deleted = await run('delete_node', { node_id: 'work', with_children: true }, ctxVal);
    expect(deleted.summary).toContain('and 2 descendant node(s)');
    expect(state.tree.getNode('work')).toBeUndefined();
    expect(state.tree.getNode('report')).toBeUndefined();
    expect(state.tree.getNode('sub')).toBeUndefined();
  });

  it('refuses to delete a node linked to a calendar block', async () => {
    const start = timestampAt('2026-10-25', '09:00');
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'ev', 'Event'),
      addBlock('blk', 'Event', start, start + 60 * 60 * 1000, { nodeId: 'ev' }),
    ]);
    const ctxVal = makeContext(state);
    await expect(run('delete_node', { node_id: 'ev' }, ctxVal)).rejects.toThrow(/cancel the event first/);
    expect(state.tree.getNode('ev')).toBeDefined();
    expect(state.calendar.blockCount()).toBe(1);
  });

  it('rejects an unknown node', async () => {
    await expect(run('delete_node', { node_id: 'nope' }, makeContext(new WorktreeState()))).rejects.toThrow(
      /unknown node id/,
    );
  });
});
