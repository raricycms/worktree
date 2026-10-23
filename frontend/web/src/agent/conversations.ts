import { isRecord, newId } from '@worktree/core';
import type { AgentHistoryMessage, AgentStep, TimetableRow, Weekday } from '@worktree/agent';
import { LOCAL_USER } from '../config';

/** `note` is a local status line: it is rendered but never sent to the model. */
export type ChatRole = 'user' | 'assistant' | 'note';

export interface ChatAttachment {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ChatArtifact {
  kind: 'timetable';
  rows: TimetableRow[];
  warnings: string[];
  state: 'pending' | 'applied' | 'cancelled';
  ruleIds?: string[];
  note?: string;
}

export interface ChatAsk {
  question: string;
  options: string[];
  answer: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  steps: AgentStep[];
  images: ChatAttachment[];
  asks: ChatAsk[];
  artifact?: ChatArtifact;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ConversationState {
  version: 2;
  activeId: string;
  conversations: Conversation[];
}

/** The transcript is a device-local convenience, so it is bounded. */
export const MAX_CONVERSATIONS = 30;
export const MAX_MESSAGES_PER_CONVERSATION = 200;

/** Only the most recent turns are model context; the rest is display only. */
export const MAX_PROMPT_MESSAGES = 24;

/** The default conversation title budget; the sidebar is narrow. */
const AUTO_TITLE_CHARS = 40;
const STORAGE_VERSION = 2;

const WEEKDAY_VALUES: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * The localStorage scope, mirroring `stateKey`: the reserved user `local` is
 * device-local and server-independent.
 */
function scopeOf(serverUrl: string, user: string): string {
  if (user === LOCAL_USER) return 'local';
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const sanitized = user.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${host}.${sanitized}`;
}

export function conversationKey(serverUrl: string, user: string): string {
  return `worktree.agent.v2.${scopeOf(serverUrl, user)}`;
}

/** The v1 single-chat key, still read once so existing transcripts survive. */
function legacyKey(serverUrl: string, user: string): string {
  return `worktree.agent.${scopeOf(serverUrl, user)}`;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.error('failed to read agent conversations:', error);
    return null;
  }
}

function parseWeekday(raw: unknown): Weekday | null {
  for (const weekday of WEEKDAY_VALUES) {
    if (weekday === raw) return weekday;
  }
  return null;
}

function parseStep(raw: unknown): AgentStep | null {
  if (!isRecord(raw)) return null;
  const { tool, summary, ok } = raw;
  if (typeof tool !== 'string' || tool === '' || typeof summary !== 'string' || typeof ok !== 'boolean') {
    return null;
  }
  return { tool, args: isRecord(raw.args) ? raw.args : {}, summary, ok };
}

function parseAttachment(raw: unknown): ChatAttachment | null {
  if (!isRecord(raw)) return null;
  const { id, name, dataUrl, width, height } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string') return null;
  if (typeof dataUrl !== 'string' || dataUrl === '') return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return { id, name, dataUrl, width, height };
}

function parseAsk(raw: unknown): ChatAsk | null {
  if (!isRecord(raw)) return null;
  const { question, options, answer } = raw;
  if (typeof question !== 'string' || typeof answer !== 'string') return null;
  if (!Array.isArray(options)) return null;
  const list: string[] = [];
  for (const option of options) {
    if (typeof option !== 'string') return null;
    list.push(option);
  }
  return { question, options: list, answer };
}

function parseTimetableRow(raw: unknown): TimetableRow | null {
  if (!isRecord(raw)) return null;
  const { id, course, start, end, weeks } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof course !== 'string') return null;
  if (typeof start !== 'string' || typeof end !== 'string' || typeof weeks !== 'string') return null;
  const weekday = parseWeekday(raw.weekday);
  if (weekday === null) return null;
  const row: TimetableRow = { id, course, weekday, start, end, weeks };
  if (typeof raw.teacher === 'string') row.teacher = raw.teacher;
  if (typeof raw.location === 'string') row.location = raw.location;
  return row;
}

function parseArtifact(raw: unknown): ChatArtifact | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== 'timetable') return null;
  if (!Array.isArray(raw.rows) || !Array.isArray(raw.warnings)) return null;
  const state = raw.state;
  if (state !== 'pending' && state !== 'applied' && state !== 'cancelled') return null;

  const rows: TimetableRow[] = [];
  for (const entry of raw.rows) {
    const row = parseTimetableRow(entry);
    if (row !== null) rows.push(row);
  }
  const warnings: string[] = [];
  for (const entry of raw.warnings) {
    if (typeof entry === 'string') warnings.push(entry);
  }

  const artifact: ChatArtifact = { kind: 'timetable', rows, warnings, state };
  if (Array.isArray(raw.ruleIds)) {
    const ruleIds: string[] = [];
    for (const entry of raw.ruleIds) {
      if (typeof entry === 'string') ruleIds.push(entry);
    }
    artifact.ruleIds = ruleIds;
  }
  if (typeof raw.note === 'string') artifact.note = raw.note;
  return artifact;
}

function parseMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  const { id, role, text } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (role !== 'user' && role !== 'assistant' && role !== 'note') return null;
  if (typeof text !== 'string') return null;

  const steps: AgentStep[] = [];
  if (Array.isArray(raw.steps)) {
    for (const entry of raw.steps) {
      const step = parseStep(entry);
      if (step !== null) steps.push(step);
    }
  }
  const images: ChatAttachment[] = [];
  if (Array.isArray(raw.images)) {
    for (const entry of raw.images) {
      const attachment = parseAttachment(entry);
      if (attachment !== null) images.push(attachment);
    }
  }
  const asks: ChatAsk[] = [];
  if (Array.isArray(raw.asks)) {
    for (const entry of raw.asks) {
      const ask = parseAsk(entry);
      if (ask !== null) asks.push(ask);
    }
  }

  const message: ChatMessage = {
    id,
    role,
    text,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    steps,
    images,
    asks,
  };
  const artifact = parseArtifact(raw.artifact);
  if (artifact !== null) message.artifact = artifact;
  return message;
}

function parseConversation(raw: unknown): Conversation | null {
  if (!isRecord(raw)) return null;
  const { id, title, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (!Array.isArray(raw.messages)) return null;

  const messages: ChatMessage[] = [];
  for (const entry of raw.messages) {
    const message = parseMessage(entry);
    if (message !== null) messages.push(message);
  }
  return {
    id,
    title: typeof title === 'string' ? title : '',
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
    messages,
  };
}

/** Parses the stored v2 state; returns null when the whole document is unusable. */
function parseState(raw: unknown): ConversationState | null {
  if (!isRecord(raw) || raw.version !== STORAGE_VERSION || !Array.isArray(raw.conversations)) return null;
  const conversations: Conversation[] = [];
  const seen = new Set<string>();
  for (const entry of raw.conversations) {
    const conversation = parseConversation(entry);
    if (conversation === null || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    conversations.push(conversation);
  }
  if (conversations.length === 0) return null;
  const activeId = typeof raw.activeId === 'string' && seen.has(raw.activeId) ? raw.activeId : '';
  return { version: STORAGE_VERSION, activeId, conversations };
}

function createConversation(now: number): Conversation {
  return { id: newId(), title: '', createdAt: now, updatedAt: now, messages: [] };
}

function createEmptyState(now: number): ConversationState {
  const conversation = createConversation(now);
  return { version: STORAGE_VERSION, activeId: conversation.id, conversations: [conversation] };
}

/**
 * Enforces the caps and the "one valid active conversation" invariant. The
 * newest conversation by `updatedAt` comes first, oldest last.
 */
function normalize(state: ConversationState): ConversationState {
  const conversations = state.conversations
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  if (conversations.length === 0) return createEmptyState(Date.now());
  const activeId = conversations.some((conversation) => conversation.id === state.activeId)
    ? state.activeId
    : conversations[0].id;
  return { version: STORAGE_VERSION, activeId, conversations };
}

function migrateLegacy(serverUrl: string, user: string, now: number): ConversationState | null {
  const raw = read(legacyKey(serverUrl, user));
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('legacy agent chat was corrupt — ignoring it:', error);
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const messages: ChatMessage[] = [];
  for (const entry of parsed) {
    const message = parseMessage(entry);
    if (message !== null) messages.push(message);
  }
  if (messages.length === 0) return null;

  const firstUser = messages.find((message) => message.role === 'user' && message.text.trim() !== '');
  const conversation: Conversation = {
    id: newId(),
    title: firstUser === undefined ? '' : autoTitle(firstUser.text),
    createdAt: now,
    updatedAt: now,
    messages: messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
  };
  return { version: STORAGE_VERSION, activeId: conversation.id, conversations: [conversation] };
}

/**
 * The stored conversations for one (server, user) scope, always usable: at
 * least one conversation exists and `activeId` names it. Corrupt entries are
 * dropped; the v1 single chat is migrated on first load.
 */
export function loadConversations(serverUrl: string, user: string): ConversationState {
  const now = Date.now();
  const raw = read(conversationKey(serverUrl, user));
  if (raw === null || raw === '') {
    return migrateLegacy(serverUrl, user, now) ?? createEmptyState(now);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('agent conversations were corrupt — starting fresh:', error);
    return createEmptyState(now);
  }
  const state = parseState(parsed);
  return state === null ? createEmptyState(now) : normalize(state);
}

type WriteResult = 'ok' | 'quota' | 'failed';

function isQuotaError(error: unknown): boolean {
  // `instanceof Error` is not reliable here: jsdom's and some browsers'
  // DOMException do not inherit from Error, yet `name` is always present.
  if (!isRecord(error)) return false;
  const name = error.name;
  return typeof name === 'string' && (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

function writeConversations(key: string, state: ConversationState): WriteResult {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return 'ok';
  } catch (error) {
    if (isQuotaError(error)) return 'quota';
    console.error('failed to save agent conversations:', error);
    return 'failed';
  }
}

/** Frees the bulk of the payload: the images of the older half of each transcript. */
function stripOldImages(state: ConversationState): ConversationState {
  return {
    ...state,
    conversations: state.conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message, index) => {
        const olderHalf = index < Math.floor(conversation.messages.length / 2);
        return olderHalf && message.images.length > 0 ? { ...message, images: [] } : message;
      }),
    })),
  };
}

function dropOldestConversation(state: ConversationState): ConversationState {
  const conversations = state.conversations.slice(0, -1);
  const activeId = conversations.some((conversation) => conversation.id === state.activeId)
    ? state.activeId
    : conversations[0].id;
  return { ...state, activeId, conversations };
}

/**
 * Persists the conversations. Storage pressure is handled in two steps (drop
 * old image payloads, then drop the oldest conversations); the function logs
 * instead of throwing, because a full quota must never break the chat.
 */
export function saveConversations(serverUrl: string, user: string, state: ConversationState): void {
  const key = conversationKey(serverUrl, user);
  const normalized = normalize(state);
  const first = writeConversations(key, normalized);
  if (first === 'ok') return;
  if (first !== 'quota') return;

  const stripped = stripOldImages(normalized);
  const second = writeConversations(key, stripped);
  if (second === 'ok') return;
  if (second !== 'quota') return;

  let current = stripped;
  while (current.conversations.length > 1) {
    current = dropOldestConversation(current);
    const result = writeConversations(key, current);
    if (result === 'ok') return;
    if (result !== 'quota') return;
  }
  console.error('agent conversations exceed the storage quota — the oldest messages could not be saved:', key);
}

function findConversation(state: ConversationState, conversationId: string): Conversation {
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  if (conversation === undefined) throw new Error(`unknown conversation: ${conversationId}`);
  return conversation;
}

export function activeConversation(state: ConversationState): Conversation {
  return findConversation(state, state.activeId);
}

function mapConversation(
  state: ConversationState,
  conversationId: string,
  update: (conversation: Conversation) => Conversation,
): ConversationState {
  let found = false;
  const conversations = state.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    found = true;
    return update(conversation);
  });
  if (!found) throw new Error(`unknown conversation: ${conversationId}`);
  return { ...state, conversations };
}

export function newConversation(state: ConversationState, now = Date.now()): ConversationState {
  const conversation = createConversation(now);
  return {
    ...state,
    activeId: conversation.id,
    conversations: [conversation, ...state.conversations].slice(0, MAX_CONVERSATIONS),
  };
}

export function appendMessages(
  state: ConversationState,
  conversationId: string,
  messages: ChatMessage | ChatMessage[],
): ConversationState {
  const list = Array.isArray(messages) ? messages : [messages];
  const now = Date.now();
  return mapConversation(state, conversationId, (conversation) => ({
    ...conversation,
    updatedAt: now,
    messages: [...conversation.messages, ...list].slice(-MAX_MESSAGES_PER_CONVERSATION),
  }));
}

export function patchMessage(
  state: ConversationState,
  conversationId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): ConversationState {
  const now = Date.now();
  return mapConversation(state, conversationId, (conversation) => {
    let found = false;
    const messages = conversation.messages.map((message) => {
      if (message.id !== messageId) return message;
      found = true;
      return { ...message, ...patch };
    });
    if (!found) throw new Error(`unknown message: ${messageId}`);
    return { ...conversation, updatedAt: now, messages };
  });
}

export function renameConversation(
  state: ConversationState,
  conversationId: string,
  title: string,
): ConversationState {
  return mapConversation(state, conversationId, (conversation) => ({
    ...conversation,
    title: title.trim(),
  }));
}

export function deleteConversation(state: ConversationState, conversationId: string): ConversationState {
  findConversation(state, conversationId);
  if (state.conversations.length <= 1) return state;
  const conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
  const activeId = conversations.some((conversation) => conversation.id === state.activeId)
    ? state.activeId
    : conversations[0].id;
  return { ...state, activeId, conversations };
}

export function selectConversation(state: ConversationState, conversationId: string): ConversationState {
  findConversation(state, conversationId);
  return state.activeId === conversationId ? state : { ...state, activeId: conversationId };
}

function isModelMessage(message: ChatMessage): message is ChatMessage & { role: 'user' | 'assistant' } {
  return message.role !== 'note' && message.text.trim() !== '';
}

/**
 * The transcript window handed to the model. Older images are collapsed to a
 * marker because base64 payloads would blow up the request; only the newest
 * user message keeps its images, and the caller sends those separately.
 */
export function modelHistory(
  messages: ChatMessage[],
  max = MAX_PROMPT_MESSAGES,
): AgentHistoryMessage[] {
  if (max <= 0) return [];
  const usable = messages.filter(isModelMessage).slice(-max);
  let newestUser = -1;
  for (let index = usable.length - 1; index >= 0; index--) {
    if (usable[index].role === 'user') {
      newestUser = index;
      break;
    }
  }
  return usable.map((message, index) => {
    const withImage = message.images.length > 0 && index !== newestUser;
    return {
      role: message.role,
      text: withImage ? `${message.text} [image]` : message.text,
    };
  });
}

/** One-line title: collapsed whitespace, trimmed, truncated with an ellipsis. */
export function autoTitle(text: string, maxChars = AUTO_TITLE_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars)}…`;
}
