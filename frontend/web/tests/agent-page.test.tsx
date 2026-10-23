import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorktreeClient } from '@worktree/client';
import type { Node } from '@worktree/core';
import type { LlmRequest, LlmResponse, LlmStreamHandlers, LlmTransport, Semester } from '@worktree/agent';
import { ProviderError } from '@worktree/agent';
import { I18nProvider } from '../src/i18n';
import { LOCAL_USER, loadConfig } from '../src/config';
import type { AiConfig, AppConfig } from '../src/config';
import { conversationKey, loadConversations } from '../src/agent/conversations';
import { LocalStorageClientStorage } from '../src/storage';
import { AgentPage } from '../src/pages/AgentPage';
import App from '../src/App';

const SERVER_URL = 'http://localhost:1';

const SEMESTER: Semester = { firstMonday: { year: 2026, month: 10, day: 19 }, totalWeeks: 16 };

function makeConfig(ai: Partial<AiConfig> = {}): AppConfig {
  return {
    serverUrl: SERVER_URL,
    user: LOCAL_USER,
    display: { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' },
    filter: {},
    lang: 'en',
    calendarDays: 7,
    autoReminder: { enabled: true, pct: 15 },
    quickAddPath: '/tmp',
    theme: 'system',
    ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-test', semester: null, ...ai },
    onboarded: true,
  };
}

function makeClient(): WorktreeClient {
  const client = new WorktreeClient({
    serverUrl: SERVER_URL,
    user: LOCAL_USER,
    local: true,
    storage: new LocalStorageClientStorage('test.agent.state'),
  });
  client.connect();
  return client;
}

function textResponse(text: string): LlmResponse {
  return { content: text, reasoning: '', toolCalls: [], finishReason: 'stop' };
}

function toolCallResponse(name: string, args: Record<string, unknown>, id: string): LlmResponse {
  return {
    content: '',
    reasoning: '',
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: 'tool_calls',
  };
}

/** A transport that replays scripted responses through the non-streaming path. */
class ScriptedTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  private readonly responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    this.responses = responses;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('the scripted transport ran out of responses');
    return next;
  }
}

/** A streaming transport: every response is delivered as word-sized deltas. */
class StreamingTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  completeCalls = 0;
  private readonly responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    this.responses = responses;
  }

  async complete(): Promise<LlmResponse> {
    this.completeCalls += 1;
    throw new Error('the streaming path should be used');
  }

  async stream(request: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('the streaming transport ran out of responses');
    if (next.reasoning !== '') handlers.onReasoningDelta?.(next.reasoning);
    for (const chunk of next.content.split(' ')) {
      handlers.onTextDelta?.(`${chunk} `);
    }
    return next;
  }
}

/** A streaming transport that pauses mid-turn until `release()` is called. */
class GatedStreamingTransport implements LlmTransport {
  completeCalls = 0;
  streamCalls = 0;
  private releaseGate: (() => void) | null = null;
  private readonly gate: Promise<void>;

  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  async complete(): Promise<LlmResponse> {
    this.completeCalls += 1;
    throw new Error('the streaming path should be used');
  }

  async stream(_request: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResponse> {
    this.streamCalls += 1;
    handlers.onReasoningDelta?.('let me think');
    await this.gate;
    handlers.onTextDelta?.('Done.');
    return textResponse('Done.');
  }

  release(): void {
    const release = this.releaseGate;
    this.releaseGate = null;
    release?.();
  }
}

function nodeNames(node: Node): string[] {
  return [node.name, ...node.children.flatMap((child) => nodeNames(child))];
}

function renderAgent(options: {
  ai?: Partial<AiConfig>;
  client?: WorktreeClient;
  transport?: LlmTransport;
  onOpenSettings?: () => void;
}) {
  const client = options.client ?? makeClient();
  const onOpenSettings = options.onOpenSettings ?? vi.fn();
  const updateConfig = vi.fn();
  const result = render(
    <I18nProvider lang="en">
      <AgentPage
        client={client}
        config={makeConfig(options.ai)}
        updateConfig={updateConfig}
        onOpenSettings={onOpenSettings}
        transport={options.transport}
      />
    </I18nProvider>,
  );
  return { client, onOpenSettings, updateConfig, unmount: result.unmount };
}

function typeAndSend(text: string): void {
  fireEvent.change(screen.getByTestId('agent-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('agent-send'));
}

/** Sidebar rows, whether active or not. */
function conversationRows(): HTMLElement[] {
  return screen.getAllByTestId(/^agent-conversation(-active)?$/);
}

const EVENT_ARGS = {
  title: 'Standup',
  date: '2026-10-24',
  start_time: '09:00',
  end_time: '09:30',
};

beforeEach(() => {
  localStorage.clear();
});

describe('AgentPage configuration gate', () => {
  it('explains how to configure the assistant and links to Settings', () => {
    const { onOpenSettings } = renderAgent({ ai: { apiKey: '' } });

    expect(screen.getByTestId('agent-needs-key')).toBeDefined();
    expect(screen.getByTestId('agent-input')).toBeDisabled();
    expect(screen.getByTestId('agent-send')).toBeDisabled();
    fireEvent.click(screen.getByTestId('agent-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('is reachable from the topbar', () => {
    localStorage.setItem('worktree.config', JSON.stringify({ user: LOCAL_USER, lang: 'en' }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByTestId('agent-needs-key')).toBeDefined();
  });
});

describe('AgentPage turn', () => {
  it('sends the user message, applies the tool ops and shows the step chips', async () => {
    const client = makeClient();
    const transport = new ScriptedTransport([
      toolCallResponse('create_event', EVENT_ARGS, 'call-1'),
      textResponse('Added the event.'),
    ]);
    renderAgent({ client, transport });

    typeAndSend('Add standup tomorrow at 9');

    expect(await screen.findByText('Added the event.')).toBeDefined();
    expect(within(screen.getByTestId('agent-log')).getByText('Add standup tomorrow at 9')).toBeDefined();
    // The user text reached the model as the turn's user message.
    expect(JSON.stringify(transport.requests[0].messages)).toContain('Add standup tomorrow at 9');

    // The planned ops were applied through the client: the event node exists.
    expect(nodeNames(client.getTree())).toContain('Standup');
    expect(client.getConfirmed().length).toBeGreaterThan(0);

    const toggle = screen.getByTestId('agent-steps-toggle');
    expect(toggle.textContent).toContain('1 step');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Create event')).toBeDefined();

    // The conversation (and its auto title) is persisted for the current scope.
    const stored = loadConversations(SERVER_URL, LOCAL_USER);
    expect(stored.conversations[0].messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(stored.conversations[0].title).toBe('Add standup tomorrow at 9');
  });

  it('streams deltas into the live bubble before the turn completes', async () => {
    const transport = new GatedStreamingTransport();
    renderAgent({ transport });

    typeAndSend('Stream please');

    const liveText = await screen.findByTestId('agent-live-text');
    expect(liveText.textContent).toBe('');
    expect(screen.getByTestId('agent-thinking')).toBeDefined();

    transport.release();

    expect(await screen.findByText('Done.')).toBeDefined();
    expect(transport.streamCalls).toBe(1);
    expect(transport.completeCalls).toBe(0);
    await waitFor(() => expect(screen.queryByTestId('agent-live-text')).toBeNull());
  });

  it('uses a streaming transport end to end for a complete reply', async () => {
    const transport = new StreamingTransport([textResponse('Streaming works.')]);
    renderAgent({ transport });

    typeAndSend('Hello');

    expect(await screen.findByText('Streaming works.')).toBeDefined();
    expect(transport.completeCalls).toBe(0);
  });

  it('starts a turn from an empty-state suggestion', async () => {
    const transport = new ScriptedTransport([textResponse('You have two events.')]);
    renderAgent({ transport });

    expect(screen.getByTestId('agent-empty')).toBeDefined();
    const suggestions = screen.getAllByTestId('agent-suggestion');
    expect(suggestions).toHaveLength(4);
    fireEvent.click(suggestions[0]);

    expect(await screen.findByText('You have two events.')).toBeDefined();
    expect(transport.requests).toHaveLength(1);
    expect(JSON.stringify(transport.requests[0].messages)).toContain('What is on my calendar today?');
  });

  it('sends on Enter but leaves Shift+Enter alone', () => {
    const transport = new ScriptedTransport([textResponse('Never sent.')]);
    renderAgent({ transport });
    const input = screen.getByTestId('agent-input');

    fireEvent.change(input, { target: { value: 'Keep writing' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(transport.requests).toHaveLength(0);
    expect(input).toHaveValue('Keep writing');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(transport.requests).toHaveLength(1);
  });
});

describe('AgentPage conversations', () => {
  it('creates a new chat and keeps one active conversation', async () => {
    renderAgent({ transport: new ScriptedTransport([]) });

    expect(conversationRows()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('agent-new-chat'));
    expect(conversationRows()).toHaveLength(2);
    expect(screen.getAllByTestId('agent-conversation-active')).toHaveLength(1);
  });

  it('switches between conversations and restores their messages', async () => {
    const transport = new ScriptedTransport([textResponse('Reply A'), textResponse('Reply B')]);
    renderAgent({ transport });

    typeAndSend('First message');
    expect(await screen.findByText('Reply A')).toBeDefined();

    fireEvent.click(screen.getByTestId('agent-new-chat'));
    typeAndSend('Second message');
    expect(await screen.findByText('Reply B')).toBeDefined();

    // Switch back through the sidebar title.
    fireEvent.click(screen.getByText('First message'));
    expect(await screen.findByText('Reply A')).toBeDefined();
    expect(screen.queryByText('Reply B')).toBeNull();
  });

  it('renames and deletes a conversation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAgent({ transport: new ScriptedTransport([]) });

    fireEvent.click(screen.getByTestId('agent-rename'));
    const input = screen.getByTestId('agent-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed chat' } });
    fireEvent.click(screen.getByTestId('agent-rename-save'));
    expect(within(screen.getByTestId('agent-sidebar')).getByText('Renamed chat')).toBeDefined();

    fireEvent.click(screen.getByTestId('agent-new-chat'));
    expect(conversationRows()).toHaveLength(2);

    // Delete the renamed conversation: it must be active first.
    fireEvent.click(within(screen.getByTestId('agent-sidebar')).getByText('Renamed chat'));
    fireEvent.click(screen.getByTestId('agent-delete'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(conversationRows()).toHaveLength(1);
    expect(screen.queryByText('Renamed chat')).toBeNull();
    confirm.mockRestore();
  });

  it('persists the conversation across a remount', async () => {
    const first = renderAgent({ transport: new ScriptedTransport([textResponse('Persisted reply')]) });

    typeAndSend('Remember me');
    expect(await screen.findByText('Persisted reply')).toBeDefined();
    first.unmount();

    renderAgent({ client: first.client });
    expect(await screen.findByText('Persisted reply')).toBeDefined();
    expect(within(screen.getByTestId('agent-log')).getByText('Remember me')).toBeDefined();
  });

  it('disables switching while a turn is running', async () => {
    const transport = new GatedStreamingTransport();
    renderAgent({ transport });

    typeAndSend('Long turn');
    await screen.findByTestId('agent-live-text');

    expect(screen.getByTestId('agent-new-chat')).toBeDisabled();
    expect(screen.getByTestId('agent-conversation-active')).toBeDisabled();

    transport.release();
    await screen.findByText('Done.');
    expect(screen.getByTestId('agent-new-chat')).not.toBeDisabled();
  });
});

describe('AgentPage ask_user', () => {
  it('answers the question through the card and finishes the turn', async () => {
    const transport = new ScriptedTransport([
      toolCallResponse('ask_user', { question: 'Which day?', options: ['Today', 'Tomorrow'] }, 'ask-1'),
      textResponse('Scheduled.'),
    ]);
    renderAgent({ transport });

    typeAndSend('Schedule it');

    const card = await screen.findByTestId('agent-ask');
    expect(within(card).getByText('Which day?')).toBeDefined();
    fireEvent.click(within(card).getByText('Tomorrow'));

    expect(await screen.findByText('Scheduled.')).toBeDefined();
    expect(screen.queryByTestId('agent-ask')).toBeNull();
    // The question and its answer are kept in the transcript.
    expect(screen.getByText('Which day?')).toBeDefined();
    expect(screen.getAllByText(/Tomorrow/).length).toBeGreaterThan(0);
  });
});

describe('AgentPage timetable artifact', () => {
  it('renders a pending card and only writes rules on confirm', async () => {
    const client = makeClient();
    const transport = new ScriptedTransport([
      toolCallResponse(
        'import_timetable',
        { rows: [{ course: 'Math', weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' }] },
        'import-1',
      ),
      textResponse('Preview ready.'),
    ]);
    renderAgent({ client, transport, ai: { semester: SEMESTER } });

    typeAndSend('Import my timetable');

    await screen.findByText('Preview ready.');
    const card = await screen.findByTestId('agent-timetable-card');
    expect(card.getAttribute('data-state')).toBe('pending');
    expect(client.getRules()).toHaveLength(0);

    fireEvent.click(within(card).getByTestId('agent-timetable-confirm'));

    await waitFor(() => expect(client.getRules()).toHaveLength(1));
    expect(client.getRules()[0].name).toBe('Math');
    expect(await screen.findByTestId('agent-timetable-result')).toBeDefined();
    expect(screen.getByTestId('agent-timetable-card').getAttribute('data-state')).toBe('applied');
    expect(screen.getAllByText(/Added 1 weekly rules/).length).toBeGreaterThan(0);
  });

  it('discards a pending card without writing anything', async () => {
    const client = makeClient();
    const transport = new ScriptedTransport([
      toolCallResponse(
        'import_timetable',
        { rows: [{ course: 'Physics', weekday: 2, start: '10:00', end: '11:40', weeks: '1-16' }] },
        'import-2',
      ),
      textResponse('Preview ready.'),
    ]);
    renderAgent({ client, transport, ai: { semester: SEMESTER } });

    typeAndSend('Import my timetable');
    const card = await screen.findByTestId('agent-timetable-card');
    fireEvent.click(within(card).getByTestId('agent-timetable-cancel'));

    await waitFor(() =>
      expect(screen.getByTestId('agent-timetable-card').getAttribute('data-state')).toBe('cancelled'),
    );
    expect(client.getRules()).toHaveLength(0);
    expect(screen.getAllByText(/Discarded/).length).toBeGreaterThan(0);
  });
});

describe('AgentPage failures', () => {
  it('surfaces a rejected API key without losing the user message', async () => {
    const transport: LlmTransport = {
      complete: async () => {
        throw new ProviderError('Incorrect API key provided', 401);
      },
    };
    renderAgent({ transport });

    typeAndSend('Plan my day');

    const error = await screen.findByTestId('agent-error');
    expect(error.textContent).toContain('API key was rejected');
    expect(within(screen.getByTestId('agent-log')).getByText('Plan my day')).toBeDefined();
    expect(screen.getByTestId('agent-input')).not.toBeDisabled();
  });

  it('stops a running turn and keeps a note', async () => {
    const transport: LlmTransport = {
      complete: (request) =>
        new Promise<LlmResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    };
    renderAgent({ transport });

    typeAndSend('Do something long');
    fireEvent.click(await screen.findByTestId('agent-stop'));

    expect(await screen.findByText('Stopped.')).toBeDefined();
    expect(screen.getByTestId('agent-send')).toBeDefined();
    expect(screen.queryByTestId('agent-error')).toBeNull();
  });
});

describe('AgentPage storage tolerance', () => {
  it('starts fresh when the stored state is corrupt', () => {
    localStorage.setItem(conversationKey(SERVER_URL, LOCAL_USER), '{not json');
    renderAgent({ transport: new ScriptedTransport([]) });

    expect(screen.getByTestId('agent-empty')).toBeDefined();
    expect(conversationRows()).toHaveLength(1);
  });

  it('migrates the legacy single-chat transcript', async () => {
    localStorage.setItem(
      'worktree.agent.local',
      JSON.stringify([{ id: 'legacy-1', role: 'user', text: 'Old hello', steps: [], createdAt: 1 }]),
    );
    renderAgent({ transport: new ScriptedTransport([]) });

    const log = screen.getByTestId('agent-log');
    await waitFor(() => expect(within(log).getByText('Old hello')).toBeDefined());
    expect(within(screen.getByTestId('agent-sidebar')).getByText('Old hello')).toBeDefined();
  });
});

describe('config ai migration', () => {
  it('defaults the assistant section when it is absent', () => {
    expect(loadConfig().ai).toEqual({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: '',
      semester: null,
    });
  });

  it('keeps valid values and drops a semester anchored on a non-Monday', () => {
    localStorage.setItem(
      'worktree.config',
      JSON.stringify({
        ai: {
          baseUrl: 'https://example.com/v1',
          model: 'custom-model',
          apiKey: 'sk-local',
          semester: { firstMonday: { year: 2026, month: 10, day: 20 }, totalWeeks: 16 },
        },
      }),
    );
    const config = loadConfig();
    expect(config.ai.baseUrl).toBe('https://example.com/v1');
    expect(config.ai.model).toBe('custom-model');
    expect(config.ai.apiKey).toBe('sk-local');
    expect(config.ai.semester).toBeNull();
  });

  it('keeps a valid semester and falls back for corrupt fields', () => {
    localStorage.setItem(
      'worktree.config',
      JSON.stringify({
        ai: {
          baseUrl: 'not a url',
          model: 42,
          apiKey: 7,
          semester: { firstMonday: { year: 2026, month: 10, day: 19 }, totalWeeks: 16 },
        },
      }),
    );
    const config = loadConfig();
    expect(config.ai.baseUrl).toBe('https://api.deepseek.com');
    expect(config.ai.model).toBe('deepseek-flash');
    expect(config.ai.apiKey).toBe('');
    expect(config.ai.semester).toEqual({ firstMonday: { year: 2026, month: 10, day: 19 }, totalWeeks: 16 });
  });
});
