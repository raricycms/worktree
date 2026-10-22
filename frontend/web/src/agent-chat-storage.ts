import { isRecord } from '@worktree/core';
import type { AgentHistoryMessage, AgentStep } from '@worktree/agent';
import { LOCAL_USER } from './config';

/**
 * One rendered chat message. Steps are the tool calls that produced an
 * assistant reply; they are shown as chips and never sent back to the model.
 */
export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps: AgentStep[];
  createdAt: number;
}

/** The conversation is a device-local convenience, so it is capped. */
export const MAX_STORED_MESSAGES = 60;

/** Only the most recent turns are model context; the rest is display only. */
export const MAX_PROMPT_MESSAGES = 20;

/**
 * The chat's localStorage namespace, mirroring `stateKey`: the reserved user
 * `local` is device-local and server-independent.
 */
export function chatKey(serverUrl: string, user: string): string {
  if (user === LOCAL_USER) return 'worktree.agent.local';
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const sanitized = user.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `worktree.agent.${host}.${sanitized}`;
}

function parseStep(raw: unknown): AgentStep | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.tool !== 'string' || typeof raw.summary !== 'string' || typeof raw.ok !== 'boolean') {
    return null;
  }
  return { tool: raw.tool, args: isRecord(raw.args) ? raw.args : {}, summary: raw.summary, ok: raw.ok };
}

function parseMessage(raw: unknown): StoredChatMessage | null {
  if (!isRecord(raw)) return null;
  const { id, role, text, createdAt } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof text !== 'string') return null;
  const steps: AgentStep[] = [];
  if (Array.isArray(raw.steps)) {
    for (const entry of raw.steps) {
      const step = parseStep(entry);
      if (step !== null) steps.push(step);
    }
  }
  return {
    id,
    role,
    text,
    steps,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}

/** The stored conversation; a corrupt entry is dropped, never fatal. */
export function loadChat(serverUrl: string, user: string): StoredChatMessage[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(chatKey(serverUrl, user));
  } catch (e) {
    console.error('failed to read agent chat:', e);
    return [];
  }
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('agent chat was corrupt — starting fresh:', e);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const messages: StoredChatMessage[] = [];
  for (const entry of parsed) {
    const message = parseMessage(entry);
    if (message !== null) messages.push(message);
  }
  return messages.slice(-MAX_STORED_MESSAGES);
}

export function saveChat(serverUrl: string, user: string, messages: StoredChatMessage[]): void {
  try {
    localStorage.setItem(chatKey(serverUrl, user), JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
  } catch (e) {
    console.error('failed to save agent chat:', e);
  }
}

export function clearChat(serverUrl: string, user: string): void {
  try {
    localStorage.removeItem(chatKey(serverUrl, user));
  } catch (e) {
    console.error('failed to clear agent chat:', e);
  }
}

/** The model sees the last turns only; the stored transcript may be longer. */
export function toModelHistory(messages: StoredChatMessage[]): AgentHistoryMessage[] {
  return messages
    .filter((message) => message.text.trim() !== '')
    .slice(-MAX_PROMPT_MESSAGES)
    .map((message): AgentHistoryMessage => ({ role: message.role, text: message.text }));
}
