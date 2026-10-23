import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@worktree/agent';
import { LOCAL_USER } from '../src/config';
import {
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_PROMPT_MESSAGES,
  activeConversation,
  appendMessages,
  autoTitle,
  conversationKey,
  deleteConversation,
  loadConversations,
  modelHistory,
  newConversation,
  patchMessage,
  renameConversation,
  saveConversations,
  selectConversation,
} from '../src/agent/conversations';
import type { ChatArtifact, ChatAttachment, ChatMessage, Conversation, ConversationState } from '../src/agent/conversations';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MB,
  attachmentFromDataUrl,
  imageFileProblem,
  prepareAttachment,
} from '../src/agent/attachments';
import { agentErrorText, deviceTzOffsetMs, isAbortError } from '../src/agent/runtime';
import type { Translate } from '../src/i18n';

const SERVER = 'http://localhost:1';
const KEY = conversationKey(SERVER, LOCAL_USER);

function attachment(index: number): ChatAttachment {
  return {
    id: `img${index}`,
    name: `photo${index}.jpg`,
    dataUrl: `data:image/jpeg;base64,AAAA${index}`,
    width: 10,
    height: 20,
  };
}

function message(id: string, role: ChatMessage['role'] = 'user', overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: `text ${id}`, createdAt: 1, steps: [], images: [], asks: [], ...overrides };
}

function conversation(id: string, updatedAt: number, messages: ChatMessage[] = []): Conversation {
  return { id, title: id, createdAt: updatedAt, updatedAt, messages };
}

function stateOf(conversations: Conversation[], activeId = conversations.length > 0 ? conversations[0].id : ''): ConversationState {
  return { version: 2, activeId, conversations };
}

function textMessage(index: number): ChatMessage {
  return message(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', { text: `m${index}` });
}

function storedState(): ConversationState {
  const raw = localStorage.getItem(KEY);
  if (raw === null) throw new Error(`nothing stored at ${KEY}`);
  return JSON.parse(raw) as ConversationState;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('conversationKey', () => {
  it('keys the local user without a server', () => {
    expect(conversationKey('http://localhost:1', LOCAL_USER)).toBe('worktree.agent.v2.local');
    expect(conversationKey('https://anything.example', LOCAL_USER)).toBe('worktree.agent.v2.local');
  });

  it('keys a server user by sanitized host and name', () => {
    expect(conversationKey('https://example.com:9997', 'someone')).toBe(
      'worktree.agent.v2.example.com_9997.someone',
    );
    expect(conversationKey('https://example.com', 'a/b c')).toBe('worktree.agent.v2.example.com.a_b_c');
  });

  it('isolates the transcripts per scope', () => {
    saveConversations(SERVER, LOCAL_USER, stateOf([conversation('c1', 1, [message('m1')])], 'c1'));
    const other = loadConversations('http://localhost:2', 'someone');
    expect(other.conversations).toHaveLength(1);
    expect(other.conversations[0].messages).toHaveLength(0);
  });
});

describe('loadConversations', () => {
  it('starts with one empty active conversation', () => {
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.version).toBe(2);
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].messages).toHaveLength(0);
    expect(state.conversations[0].title).toBe('');
    expect(state.activeId).toBe(state.conversations[0].id);
  });

  it('returns a usable state for corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json');
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations).toHaveLength(1);
    expect(state.activeId).toBe(state.conversations[0].id);
  });

  it('returns a usable state for a wrong document shape', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, conversations: 'nope' }));
    expect(loadConversations(SERVER, LOCAL_USER).conversations).toHaveLength(1);
    localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
    expect(loadConversations(SERVER, LOCAL_USER).conversations).toHaveLength(1);
  });

  it('fills absent message collections with defaults', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 2,
        activeId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: '',
            createdAt: 1,
            updatedAt: 1,
            messages: [{ id: 'm1', role: 'user', text: 'hello', createdAt: 1 }],
          },
        ],
      }),
    );
    const loaded = loadConversations(SERVER, LOCAL_USER).conversations[0].messages[0];
    expect(loaded.steps).toEqual([]);
    expect(loaded.images).toEqual([]);
    expect(loaded.asks).toEqual([]);
    expect(loaded.artifact).toBeUndefined();
  });

  it('drops corrupt conversations, messages and attachments', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 2,
        activeId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'kept',
            createdAt: 1,
            updatedAt: 1,
            messages: [
              message('m1'),
              { id: '', role: 'user', text: 'no id' },
              { id: 'm2', role: 'system', text: 'bad role' },
              message('m3', 'user', { images: [{ id: '', name: 'x', dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 }] }),
            ],
          },
          { id: 'c2' },
          { id: 'c3', messages: 'nope' },
          null,
        ],
      }),
    );
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations.map((entry) => entry.id)).toEqual(['c1']);
    expect(state.conversations[0].messages.map((entry) => entry.id)).toEqual(['m1', 'm3']);
    expect(state.conversations[0].messages[1].images).toHaveLength(0);
  });

  it('deduplicates conversation ids', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 2,
        activeId: 'dup',
        conversations: [conversation('dup', 2), conversation('dup', 1)],
      }),
    );
    expect(loadConversations(SERVER, LOCAL_USER).conversations).toHaveLength(1);
  });

  it('keeps the newest 30 conversations', () => {
    const conversations = Array.from({ length: 35 }, (_value, index) => conversation(`c${index}`, index));
    localStorage.setItem(KEY, JSON.stringify(stateOf(conversations, 'c0')));
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(state.conversations[0].id).toBe('c34');
    expect(state.conversations[MAX_CONVERSATIONS - 1].id).toBe('c5');
  });

  it('keeps the newest 200 messages of a conversation', () => {
    const messages = Array.from({ length: 250 }, (_value, index) => textMessage(index));
    localStorage.setItem(KEY, JSON.stringify(stateOf([conversation('c1', 1, messages)], 'c1')));
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations[0].messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(state.conversations[0].messages[0].id).toBe('m50');
  });

  it('repairs an invalid active id', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 2,
        activeId: 'missing',
        conversations: [conversation('older', 1), conversation('newer', 2)],
      }),
    );
    expect(loadConversations(SERVER, LOCAL_USER).activeId).toBe('newer');
  });

  it('keeps a valid active id even when it is not the newest conversation', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 2, activeId: 'older', conversations: [conversation('newer', 2), conversation('older', 1)] }),
    );
    expect(loadConversations(SERVER, LOCAL_USER).activeId).toBe('older');
  });
});

describe('legacy single-chat migration', () => {
  const LEGACY_KEY = 'worktree.agent.local';

  it('migrates the v1 transcript into one titled conversation', () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { id: 'old1', role: 'user', text: '  Plan   my\tweek ', steps: [], createdAt: 10 },
        { id: 'old2', role: 'assistant', text: 'Sure', steps: [{ tool: 'get_agenda', args: {}, summary: 'ok', ok: true }], createdAt: 11 },
      ]),
    );
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].title).toBe('Plan my week');
    expect(state.conversations[0].messages).toHaveLength(2);
    expect(state.conversations[0].messages[0]).toMatchObject({
      id: 'old1',
      role: 'user',
      text: '  Plan   my\tweek ',
      createdAt: 10,
      images: [],
      asks: [],
    });
    expect(state.conversations[0].messages[1].steps).toHaveLength(1);
    expect(state.conversations[0].messages[0].artifact).toBeUndefined();
    expect(state.activeId).toBe(state.conversations[0].id);
  });

  it('ignores a corrupt or empty legacy transcript', () => {
    localStorage.setItem(LEGACY_KEY, '{not json');
    expect(loadConversations(SERVER, LOCAL_USER).conversations[0].messages).toHaveLength(0);
    localStorage.clear();
    localStorage.setItem(LEGACY_KEY, JSON.stringify([]));
    expect(loadConversations(SERVER, LOCAL_USER).conversations[0].messages).toHaveLength(0);
  });

  it('prefers the v2 state over the legacy one', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([{ id: 'old', role: 'user', text: 'legacy', steps: [], createdAt: 1 }]));
    localStorage.setItem(KEY, JSON.stringify(stateOf([conversation('v2', 1, [message('new')])], 'v2')));
    const state = loadConversations(SERVER, LOCAL_USER);
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].id).toBe('v2');
    expect(state.conversations[0].messages[0].id).toBe('new');
  });
});

describe('state transforms', () => {
  it('creates a new active conversation at the front and caps the list', () => {
    const conversations = Array.from({ length: MAX_CONVERSATIONS }, (_value, index) => conversation(`c${index}`, index));
    const state = stateOf(conversations, 'c0');
    const next = newConversation(state, 99);
    expect(next.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(next.activeId).toBe(next.conversations[0].id);
    expect(next.conversations[0].messages).toHaveLength(0);
    expect(next.conversations[0].createdAt).toBe(99);
    expect(next.conversations.some((entry) => entry.id === `c${MAX_CONVERSATIONS - 1}`)).toBe(false);
  });

  it('appends messages one at a time or as a batch', () => {
    const state = stateOf([conversation('c1', 1, [message('m1')])], 'c1');
    const single = appendMessages(state, 'c1', message('m2'));
    expect(single.conversations[0].messages.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    const batch = appendMessages(single, 'c1', [message('m3'), message('m4')]);
    expect(batch.conversations[0].messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(batch.conversations[0].updatedAt).toBeGreaterThanOrEqual(state.conversations[0].updatedAt);
  });

  it('caps a conversation at 200 messages when appending', () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_CONVERSATION }, (_value, index) => textMessage(index));
    const state = stateOf([conversation('c1', 1, messages)], 'c1');
    const next = appendMessages(state, 'c1', textMessage(999));
    expect(next.conversations[0].messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(next.conversations[0].messages[0].id).toBe('m1');
    expect(next.conversations[0].messages[MAX_MESSAGES_PER_CONVERSATION - 1].id).toBe('m999');
  });

  it('patches one message and leaves the rest untouched', () => {
    const state = stateOf([conversation('c1', 1, [message('m1'), message('m2')])], 'c1');
    const next = patchMessage(state, 'c1', 'm1', { text: 'changed' });
    expect(next.conversations[0].messages[0].text).toBe('changed');
    expect(next.conversations[0].messages[1]).toEqual(state.conversations[0].messages[1]);
  });

  it('renames and trims the title', () => {
    const state = stateOf([conversation('c1', 1)], 'c1');
    expect(renameConversation(state, 'c1', '  New name  ').conversations[0].title).toBe('New name');
  });

  it('selects an existing conversation only', () => {
    const state = stateOf([conversation('c1', 1), conversation('c2', 2)], 'c2');
    expect(selectConversation(state, 'c1').activeId).toBe('c1');
    expect(() => selectConversation(state, 'nope')).toThrow('unknown conversation: nope');
  });

  it('switches the active id when the active conversation is deleted', () => {
    const state = stateOf([conversation('c1', 2), conversation('c2', 1)], 'c1');
    const next = deleteConversation(state, 'c1');
    expect(next.conversations.map((entry) => entry.id)).toEqual(['c2']);
    expect(next.activeId).toBe('c2');
  });

  it('keeps at least one conversation when deleting', () => {
    const state = stateOf([conversation('only', 1)], 'only');
    const next = deleteConversation(state, 'only');
    expect(next.conversations).toHaveLength(1);
    expect(next.activeId).toBe('only');
    expect(() => deleteConversation(state, 'nope')).toThrow('unknown conversation: nope');
  });

  it('exposes the active conversation', () => {
    const state = stateOf([conversation('c1', 1), conversation('c2', 2)], 'c2');
    expect(activeConversation(state).id).toBe('c2');
  });

  it('never mutates the input state', () => {
    const state = stateOf([conversation('c1', 1, [message('m1')]), conversation('c2', 2, [message('m2')])], 'c2');
    const before = JSON.stringify(state);
    newConversation(state, 10);
    appendMessages(state, 'c1', message('m3'));
    patchMessage(state, 'c1', 'm1', { text: 'changed' });
    renameConversation(state, 'c1', 'renamed');
    deleteConversation(state, 'c2');
    selectConversation(state, 'c1');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('throws for unknown conversations and messages', () => {
    const state = stateOf([conversation('c1', 1, [message('m1')])], 'c1');
    expect(() => appendMessages(state, 'nope', message('m2'))).toThrow('unknown conversation: nope');
    expect(() => patchMessage(state, 'c1', 'nope', { text: 'x' })).toThrow('unknown message: nope');
    expect(() => renameConversation(state, 'nope', 'x')).toThrow('unknown conversation: nope');
  });
});

describe('autoTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(autoTitle('  Plan \n  my\tweek  ')).toBe('Plan my week');
  });

  it('truncates to the budget with an ellipsis', () => {
    expect(autoTitle('abcdefghij', 5)).toBe('abcde…');
    expect(autoTitle('abcde', 5)).toBe('abcde');
    expect(autoTitle('')).toBe('');
  });
});

describe('modelHistory', () => {
  it('drops note and empty messages', () => {
    const messages = [
      message('u1', 'user', { text: 'hello' }),
      message('n1', 'note', { text: 'Stopped.' }),
      message('a1', 'assistant', { text: '' }),
      message('a2', 'assistant', { text: 'answer' }),
    ];
    expect(modelHistory(messages)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'answer' },
    ]);
  });

  it('keeps only the last 24 messages', () => {
    const messages = Array.from({ length: 30 }, (_value, index) => textMessage(index));
    const history = modelHistory(messages);
    expect(history).toHaveLength(MAX_PROMPT_MESSAGES);
    expect(history[0].text).toBe('m6');
    expect(history[MAX_PROMPT_MESSAGES - 1].text).toBe('m29');
  });

  it('marks the images of older messages with a trailing [image]', () => {
    const messages = [
      message('u1', 'user', { text: 'look at this', images: [attachment(0)] }),
      message('a1', 'assistant', { text: 'I see' }),
      message('u2', 'user', { text: 'and this', images: [attachment(1), attachment(2)] }),
    ];
    const history = modelHistory(messages);
    expect(history[0].text).toBe('look at this [image]');
    expect(history[1].text).toBe('I see');
    expect(history[2].text).toBe('and this');
    expect(history[0].text.match(/\[image\]/g)).toHaveLength(1);
  });

  it('marks an older assistant message that carries an image', () => {
    const messages = [
      message('a1', 'assistant', { text: 'chart', images: [attachment(0)] }),
      message('u1', 'user', { text: 'newest' }),
    ];
    expect(modelHistory(messages)[0].text).toBe('chart [image]');
  });

  it('returns nothing when max is zero', () => {
    expect(modelHistory([message('u1', 'user', { text: 'hi' })], 0)).toEqual([]);
  });
});

describe('saveConversations', () => {
  it('persists and prunes to the newest 30 conversations', () => {
    const conversations = Array.from({ length: 35 }, (_value, index) => conversation(`c${index}`, index));
    saveConversations(SERVER, LOCAL_USER, stateOf(conversations, 'c0'));
    const stored = storedState();
    expect(stored.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(stored.conversations[0].id).toBe('c34');
    expect(stored.activeId).toBe('c34');
  });

  it('caps a stored conversation at 200 messages', () => {
    const messages = Array.from({ length: 250 }, (_value, index) => textMessage(index));
    saveConversations(SERVER, LOCAL_USER, stateOf([conversation('c1', 1, messages)], 'c1'));
    const stored = storedState();
    expect(stored.conversations[0].messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(stored.conversations[0].messages[0].id).toBe('m50');
  });

  it('retries after dropping old image payloads when the quota is exceeded once', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    setItem.mockImplementationOnce(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const older = conversation('c1', 1, [
      message('m1', 'user', { images: [attachment(0)] }),
      message('m2', 'assistant', { images: [attachment(1)] }),
    ]);
    const newer = conversation('c2', 2, [
      message('m3', 'user', { images: [attachment(2)] }),
      message('m4', 'assistant', { images: [attachment(3)] }),
    ]);
    saveConversations(SERVER, LOCAL_USER, stateOf([older, newer], 'c2'));

    expect(setItem.mock.calls.length).toBeGreaterThanOrEqual(2);
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('AAAA0');
    expect(raw).not.toContain('AAAA2');
    const stored = storedState();
    const byId = new Map(stored.conversations.map((entry) => [entry.id, entry]));
    expect(byId.get('c1')?.messages[0].images).toHaveLength(0);
    expect(byId.get('c1')?.messages[1].images).toHaveLength(1);
    expect(byId.get('c2')?.messages[0].images).toHaveLength(0);
    expect(byId.get('c2')?.messages[1].images).toHaveLength(1);
  });

  it('drops the oldest conversations when the quota stays exceeded', () => {
    const original = localStorage.setItem.bind(localStorage);
    let calls = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      calls += 1;
      if (calls <= 2) throw new DOMException('quota exceeded', 'QuotaExceededError');
      original(key, value);
    });
    const conversations = [conversation('c1', 1), conversation('c2', 2), conversation('c3', 3)];
    saveConversations(SERVER, LOCAL_USER, stateOf(conversations, 'c1'));

    const stored = storedState();
    expect(stored.conversations.map((entry) => entry.id)).toEqual(['c3', 'c2']);
    expect(stored.activeId).toBe('c3');
  });

  it('never throws when the quota stays exceeded', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => saveConversations(SERVER, LOCAL_USER, stateOf([conversation('c1', 1)], 'c1'))).not.toThrow();
  });

  it('logs and gives up on a non-quota storage error without retrying', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage is disabled');
    });
    expect(() => saveConversations(SERVER, LOCAL_USER, stateOf([conversation('c1', 1)], 'c1'))).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it('roundtrips images, asks and an applied artifact', () => {
    const artifact: ChatArtifact = {
      kind: 'timetable',
      rows: [
        { id: 'r1', course: 'Math', weekday: 2, start: '08:00', end: '09:40', weeks: '1-16', teacher: 'A', location: 'B101' },
      ],
      warnings: ['check week 3'],
      state: 'applied',
      ruleIds: ['rule-1'],
      note: 'done',
    };
    const rich = message('m1', 'assistant', {
      text: 'done',
      images: [attachment(0)],
      asks: [{ question: 'Which week?', options: ['1', '2'], answer: '2' }],
      artifact,
    });
    saveConversations(SERVER, LOCAL_USER, stateOf([conversation('c1', 1, [rich])], 'c1'));
    expect(loadConversations(SERVER, LOCAL_USER).conversations[0].messages[0]).toEqual(rich);
  });
});

describe('attachment validation', () => {
  it('exposes the contract limits', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_IMAGE_MB).toBe(10);
    expect(MAX_ATTACHMENTS).toBe(3);
  });

  it('rejects non-image files by type', () => {
    expect(imageFileProblem(new File(['notes'], 'notes.txt', { type: 'text/plain' }))).toBe('type');
    expect(imageFileProblem(new File(['notes'], 'notes.pdf', { type: '' }))).toBe('type');
  });

  it('rejects images above the size limit', () => {
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 });
    expect(imageFileProblem(big)).toBe('size');
  });

  it('accepts a small image, even when the browser gives no MIME type', () => {
    expect(imageFileProblem(new File(['x'], 'photo.png', { type: 'image/png' }))).toBeNull();
    expect(imageFileProblem(new File(['x'], 'photo.HEIC', { type: '' }))).toBeNull();
  });

  it('rejects an invalid file in prepareAttachment before touching the canvas', async () => {
    await expect(prepareAttachment(new File(['x'], 'notes.txt', { type: 'text/plain' }))).rejects.toThrow(
      'choose an image file',
    );
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 });
    await expect(prepareAttachment(big)).rejects.toThrow(`${MAX_IMAGE_MB} MB`);
  });

  it('wraps a data URL as an attachment', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    expect(attachmentFromDataUrl(dataUrl)).toEqual({
      id: expect.any(String),
      name: 'image',
      dataUrl,
      width: 0,
      height: 0,
    });
    expect(attachmentFromDataUrl(dataUrl, 'shot.png').name).toBe('shot.png');
    expect(attachmentFromDataUrl(dataUrl).id).not.toBe(attachmentFromDataUrl(dataUrl).id);
  });
});

describe('runtime helpers', () => {
  function fakeTranslate(): Translate {
    return (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
  }

  it('detects abort errors', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('stopped'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });

  it('reports the device offset in whole minutes', () => {
    expect(Math.abs(deviceTzOffsetMs()) % 60000).toBe(0);
    expect(Math.abs(deviceTzOffsetMs())).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('maps provider status codes and generic failures to messages', () => {
    const t = fakeTranslate();
    expect(agentErrorText(new ProviderError('rejected', 401), t)).toBe('agent.error.unauthorized');
    expect(agentErrorText(new ProviderError('forbidden', 403), t)).toBe('agent.error.unauthorized');
    expect(agentErrorText(new ProviderError('no balance', 402), t)).toBe('agent.error.quota');
    expect(agentErrorText(new ProviderError('slow down', 429), t)).toBe('agent.error.rateLimit');
    expect(agentErrorText(new ProviderError('model does not support image input', 400), t)).toBe(
      'agent.error.imageUnsupported',
    );
    expect(agentErrorText(new ProviderError('server error', 500), t)).toBe(
      'agent.error.status:{"status":500,"message":"server error"}',
    );
    expect(agentErrorText(new ProviderError('offline'), t)).toBe('agent.error.generic:{"message":"offline"}');
    expect(agentErrorText(new Error('boom'), t)).toBe('agent.error.generic:{"message":"boom"}');
  });
});
