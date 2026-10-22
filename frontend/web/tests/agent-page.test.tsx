import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorktreeClient } from '@worktree/client';
import type { Node } from '@worktree/core';
import type { LlmRequest, LlmResponse, LlmTransport } from '@worktree/agent';
import { ProviderError } from '@worktree/agent';
import { I18nProvider } from '../src/i18n';
import { LOCAL_USER, loadConfig } from '../src/config';
import type { AiConfig, AppConfig } from '../src/config';
import { MAX_PROMPT_MESSAGES, MAX_STORED_MESSAGES, chatKey, loadChat, saveChat, toModelHistory } from '../src/agent-chat-storage';
import type { StoredChatMessage } from '../src/agent-chat-storage';
import { LocalStorageClientStorage } from '../src/storage';
import { AgentPage } from '../src/pages/AgentPage';
import App from '../src/App';

function makeConfig(ai: Partial<AiConfig> = {}): AppConfig {
  return {
    serverUrl: 'http://localhost:1',
    user: LOCAL_USER,
    display: { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' },
    filter: {},
    lang: 'en',
    calendarDays: 7,
    autoReminder: { enabled: true, pct: 15 },
    quickAddPath: '/tmp',
    theme: 'system',
    ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-test', semester: null, ...ai },
  };
}

function makeClient(): WorktreeClient {
  const client = new WorktreeClient({
    serverUrl: 'http://localhost:1',
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

/** A transport that replays scripted responses and records every request. */
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
  render(
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
  return { client, onOpenSettings, updateConfig };
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
    expect(screen.queryByTestId('agent-input')).toBeNull();
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

describe('AgentPage chat turn', () => {
  it('sends the user message, applies the tool ops and shows the step chips', async () => {
    const client = makeClient();
    const transport = new ScriptedTransport([
      toolCallResponse('create_event', EVENT_ARGS, 'call-1'),
      textResponse('Added the event.'),
    ]);
    renderAgent({ client, transport });

    fireEvent.change(screen.getByTestId('agent-input'), {
      target: { value: 'Add standup tomorrow at 9' },
    });
    fireEvent.click(screen.getByTestId('agent-send'));

    expect(await screen.findByText('Added the event.')).toBeDefined();
    expect(screen.getByText('Add standup tomorrow at 9')).toBeDefined();
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

    // The turn is persisted for the current (server, user).
    const stored = loadChat('http://localhost:1', LOCAL_USER);
    expect(stored.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('surfaces a rejected API key as an actionable notice', async () => {
    const transport: LlmTransport = {
      complete: async () => {
        throw new ProviderError('Incorrect API key provided', 401);
      },
    };
    renderAgent({ transport });

    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: 'Plan my day' } });
    fireEvent.click(screen.getByTestId('agent-send'));

    const error = await screen.findByTestId('agent-error');
    expect(error.textContent).toContain('API key was rejected');
  });

  it('stops a running turn', async () => {
    const transport: LlmTransport = {
      complete: (request) =>
        new Promise<LlmResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    };
    renderAgent({ transport });

    fireEvent.change(screen.getByTestId('agent-input'), { target: { value: 'Do something long' } });
    fireEvent.click(screen.getByTestId('agent-send'));
    fireEvent.click(await screen.findByTestId('agent-stop'));

    const notice = await screen.findByTestId('agent-notice');
    expect(notice.textContent).toContain('Stopped');
    expect(screen.getByTestId('agent-send')).toBeDefined();
  });
});

describe('agent chat storage', () => {
  function message(index: number): StoredChatMessage {
    return {
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message ${index}`,
      steps: [],
      createdAt: index,
    };
  }

  it('caps the stored transcript at 60 messages', () => {
    const messages = Array.from({ length: 70 }, (_value, index) => message(index));
    saveChat('http://localhost:1', LOCAL_USER, messages);
    const loaded = loadChat('http://localhost:1', LOCAL_USER);
    expect(loaded).toHaveLength(MAX_STORED_MESSAGES);
    expect(loaded[0].id).toBe('m10');
  });

  it('sends only the last 20 messages to the model', () => {
    const messages = Array.from({ length: 30 }, (_value, index) => message(index));
    expect(toModelHistory(messages)).toHaveLength(MAX_PROMPT_MESSAGES);
    expect(toModelHistory(messages)[0].text).toBe('message 10');
  });

  it('keeps the transcript per (server, user)', () => {
    saveChat('http://localhost:1', LOCAL_USER, [message(0)]);
    expect(chatKey('http://localhost:1', LOCAL_USER)).toBe('worktree.agent.local');
    expect(loadChat('http://localhost:2', 'someone')).toHaveLength(0);
  });

  it('ignores a corrupt transcript', () => {
    localStorage.setItem(chatKey('http://localhost:1', LOCAL_USER), '{not json');
    expect(loadChat('http://localhost:1', LOCAL_USER)).toEqual([]);
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
