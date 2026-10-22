import { describe, expect, it } from 'vitest';
import { ROOT_ID, WorktreeState } from '@worktree/core';
import type { Operation } from '@worktree/core';
import { createTools } from '../../src/tools';
import type { Tool, ToolContext } from '../../src/types';
import { NOW, TZ, addNode, makeContext, timestampAt } from './fixtures';

const TOOL_NAMES = [
  'get_agenda',
  'search_tasks',
  'get_task',
  'find_free_slots',
  'suggest_tasks',
  'create_event',
  'create_task',
  'create_recurring',
  'update_event',
  'complete_task',
  'cancel_event',
];

const tools = createTools();

function getTool(name: string): Tool {
  const found = tools.find((tool) => tool.definition.name === name);
  if (found === undefined) throw new Error(`missing tool: ${name}`);
  return found;
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

function createEventTool(ctxVal: ToolContext, title = 'Standup'): { nodeId: string; blockId: string } {
  const result = getTool('create_event').run(
    { title, date: '2026-10-25', start_time: '09:00', end_time: '10:00' },
    ctxVal,
  );
  return { nodeId: addedNodeId(result.ops, title), blockId: addedBlockId(result.ops) };
}

describe('createTools', () => {
  it('exposes the eleven documented tools with object schemas', () => {
    expect(tools.map((tool) => tool.definition.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.definition.parameters.type).toBe('object');
      expect(tool.definition.description.length).toBeGreaterThan(0);
    }
  });

  it('rejects malformed arguments with the expected shape', () => {
    const ctxVal = makeContext(new WorktreeState());
    expect(() => getTool('create_event').run({}, ctxVal)).toThrow(/invalid arguments for create_event: expected \{title/);
    expect(() =>
      getTool('create_event').run({ title: 'x', date: '2026/10/25', start_time: '09:00', end_time: '10:00' }, ctxVal),
    ).toThrow(/expected YYYY-MM-DD/);
    expect(() =>
      getTool('create_event').run({ title: 'x', date: '2026-10-25', start_time: '9:00', end_time: '10:00' }, ctxVal),
    ).toThrow(/expected HH:mm/);
    expect(() =>
      getTool('create_recurring').run(
        { title: 'x', weekdays: [0], start_time: '09:00', end_time: '10:00', start_date: '2026-09-07' },
        ctxVal,
      ),
    ).toThrow(/invalid arguments for create_recurring/);
    expect(() => getTool('get_task').run({}, ctxVal)).toThrow(/task_id/);
    expect(() => getTool('complete_task').run({ task_id: 5 }, ctxVal)).toThrow(/invalid arguments/);
    expect(ctxVal.state.tree.nodeCount()).toBe(0);
  });
});

describe('read tools', () => {
  it('runs queries directly on the context and never mutates it', () => {
    const state = WorktreeState.fromOps([
      addNode(ROOT_ID, 'tmp', 'tmp'),
      addNode('tmp', 'task', 'Task', { deadline: NOW + 60 * 60 * 1000 }),
    ]);
    const ctxVal = makeContext(state);
    const before = state.tree.nodeCount();
    const agenda = getTool('get_agenda').run({}, ctxVal);
    expect(agenda.ops).toBeUndefined();
    const search = getTool('search_tasks').run({ keyword: 'Task' }, ctxVal);
    expect(search.summary).toContain('[task] Task');
    expect(getTool('get_task').run({ task_id: 'task' }, ctxVal).summary).toContain('Task [task] Task');
    expect(state.tree.nodeCount()).toBe(before);
  });

  it('surfaces unknown ids and paths as errors', () => {
    const ctxVal = makeContext(new WorktreeState());
    expect(() => getTool('get_task').run({ task_id: 'missing' }, ctxVal)).toThrow(/unknown task id/);
    expect(() => getTool('search_tasks').run({ path: '/nope' }, ctxVal)).toThrow(/unknown path/);
  });

  it('finds free slots inside the working window', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    createEventTool(ctxVal);
    const free = getTool('find_free_slots').run({ date: '2026-10-25' }, ctxVal);
    expect(free.summary).toContain('08:00-09:00 (60 min)');
    expect(free.summary).toContain('10:00-23:00 (780 min)');
    const narrow = getTool('find_free_slots').run({ date: '2026-10-25', min_minutes: 800 }, ctxVal);
    expect(narrow.summary).toContain('No free slots of at least 800 minutes');
  });
});

describe('write tools chain on the dry-run state', () => {
  it('create_event then get_agenda sees the write, and the ops replay cleanly', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = getTool('create_event').run(
      { title: 'Standup', date: '2026-10-25', start_time: '09:00', end_time: '10:00', location: 'Room 3' },
      ctxVal,
    );
    const blockId = addedBlockId(created.ops);
    expect(created.summary).toContain(`block ${blockId}`);
    expect(created.summary).toContain('reminder 15 min before');

    const agenda = getTool('get_agenda').run({ from: '2026-10-25', to: '2026-10-25' }, ctxVal);
    expect(agenda.summary).toContain('Standup');
    expect(agenda.summary).toContain(`block ${blockId}`);

    const replay = WorktreeState.fromOps(created.ops ?? []);
    expect(replay.calendar.blockCount()).toBe(1);
    expect(replay.tree.nodeCount()).toBe(2);
    expect(state.calendar.blockCount()).toBe(1);
  });

  it('create_task then search_tasks and get_task expose deadline, reminder and id', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = getTool('create_task').run(
      { title: 'Write report', due_date: '2026-10-30', due_time: '17:00', remind_minutes_before: 30 },
      ctxVal,
    );
    const nodeId = addedNodeId(created.ops, 'Write report');
    expect(created.summary).toContain(`node ${nodeId}`);
    expect(created.summary).toContain('/tmp/Write report');
    expect(state.tree.getNode(nodeId)?.deadline).toBeGreaterThan(0);

    const search = getTool('search_tasks').run({ keyword: 'report' }, ctxVal);
    expect(search.summary).toContain(`[${nodeId}] Write report`);
    expect(search.summary).toContain('due 2026-10-30 17:00');
    expect(search.summary).toContain('1 reminder(s)');

    const detail = getTool('get_task').run({ task_id: nodeId }, ctxVal);
    expect(detail.summary).toContain('/tmp/Write report');
    expect(detail.summary).toContain('Reminders: 1');
    expect(detail.summary).toContain('Linked block: none');
  });

  it('complete_task flips the node and search_tasks follows the filter', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = getTool('create_task').run({ title: 'Finish me' }, ctxVal);
    const nodeId = addedNodeId(created.ops, 'Finish me');

    expect(getTool('search_tasks').run({ keyword: 'Finish me' }, ctxVal).summary).toContain(`[${nodeId}]`);
    const completed = getTool('complete_task').run({ task_id: nodeId }, ctxVal);
    expect(completed.summary).toContain('Completed task');
    expect(state.tree.getNode(nodeId)?.status).toBe(true);
    expect(getTool('search_tasks').run({ keyword: 'Finish me' }, ctxVal).summary).toBe('No matching tasks.');
    expect(getTool('search_tasks').run({ keyword: 'Finish me', include_completed: true }, ctxVal).summary).toContain(
      'completed',
    );

    const reopened = getTool('complete_task').run({ task_id: nodeId, completed: false }, ctxVal);
    expect(reopened.summary).toContain('Uncompleted');
    expect(state.tree.getNode(nodeId)?.status).toBe(false);
  });

  it('create_recurring then get_agenda lists an occurrence', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const created = getTool('create_recurring').run(
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

    const agenda = getTool('get_agenda').run({ from: '2026-09-07', to: '2026-09-07' }, ctxVal);
    expect(agenda.summary).toContain('Math');
    expect(agenda.summary).toContain('occurrence');
  });

  it('update_event patches the block and cancel_event removes it', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const { nodeId, blockId } = createEventTool(ctxVal);

    const updated = getTool('update_event').run({ event_id: blockId, title: 'Daily', start_time: '11:00' }, ctxVal);
    expect(updated.summary).toContain(`Updated event ${blockId}`);
    expect(updated.summary).toContain('as "Daily"');
    expect(state.calendar.getBlocks()[0]?.start).toBe(timestampAt('2026-10-25', '11:00'));

    const cancelled = getTool('cancel_event').run({ event_id: nodeId }, ctxVal);
    expect(cancelled.summary).toContain('Cancelled event');
    expect(state.calendar.blockCount()).toBe(0);
    expect(state.tree.getNode(nodeId)).toBeUndefined();
  });

  it('leaves the context untouched when a write is rejected', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    expect(() =>
      getTool('create_event').run(
        { title: 'Broken', date: '2026-10-25', start_time: '10:00', end_time: '09:00' },
        ctxVal,
      ),
    ).toThrow(/end_time must be after start_time/);
    expect(state.tree.nodeCount()).toBe(0);
    expect(state.calendar.blockCount()).toBe(0);

    expect(() => getTool('update_event').run({ event_id: 'missing' }, ctxVal)).toThrow(/at least one of/);
    expect(() => getTool('cancel_event').run({ event_id: 'missing' }, ctxVal)).toThrow(/unknown event id/);
    expect(() => getTool('complete_task').run({ task_id: 'missing' }, ctxVal)).toThrow(/unknown task id/);
  });
});

describe('suggest_tasks tool', () => {
  it('returns the ranked ids with reasons', () => {
    const state = new WorktreeState();
    const ctxVal = makeContext(state);
    const overdue = getTool('create_task').run({ title: 'Late', due_date: '2026-10-20' }, ctxVal);
    const overdueId = addedNodeId(overdue.ops, 'Late');
    const leisure = getTool('create_task').run({ title: 'Leisure' }, ctxVal);
    const leisureId = addedNodeId(leisure.ops, 'Leisure');

    const suggested = getTool('suggest_tasks').run({}, ctxVal);
    const lines = suggested.summary.split('\n');
    expect(lines[0]).toContain(`[${overdueId}] Late`);
    expect(lines[0]).toContain('overdue since 2026-10-20 23:59');
    expect(lines[1]).toContain(`[${leisureId}] Leisure`);
    expect(lines[1]).toContain('no deadline');
    expect(suggested.ops).toBeUndefined();
  });
});
