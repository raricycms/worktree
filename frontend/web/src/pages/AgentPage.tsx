import { useEffect, useMemo, useRef, useState } from 'react';
import { newId } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import {
  buildContextSnapshot,
  buildSystemPrompt,
  createChatTransport,
  createTools,
  runAgentTurn,
} from '@worktree/agent';
import type { LlmTransport, Semester } from '@worktree/agent';
import { useI18n } from '../i18n';
import type { AppConfig } from '../config';
import type { StoredChatMessage } from '../agent-chat-storage';
import { clearChat, loadChat, saveChat, toModelHistory } from '../agent-chat-storage';
import { ChatMessage } from '../components/ChatMessage';
import { TimetableImport, agentErrorText, deviceTzOffsetMs, isAbortError } from '../components/TimetableImport';

/**
 * The assistant page: a conversation over the configured chat endpoint. Every
 * turn snapshots the planning state, lets the model call tools, and applies the
 * returned ops through `applyMany`, so the ordinary history/undo path is kept.
 * The transcript is device-local and survives tab switches.
 */
export function AgentPage(props: {
  client: WorktreeClient;
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => void;
  onOpenSettings: () => void;
  /** A fake transport for tests; production builds one from `config.ai`. */
  transport?: LlmTransport;
}) {
  const { t, lang } = useI18n();
  const { client, config, updateConfig, onOpenSettings, transport: injectedTransport } = props;

  const hasKey = config.ai.apiKey.trim() !== '';
  const [messages, setMessages] = useState<StoredChatMessage[]>(() => loadChat(config.serverUrl, config.user));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMessages(loadChat(config.serverUrl, config.user));
  }, [config.serverUrl, config.user]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const transport = useMemo((): LlmTransport | null => {
    if (injectedTransport !== undefined) return injectedTransport;
    if (!hasKey) return null;
    return createChatTransport({
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      apiKey: config.ai.apiKey,
    });
  }, [injectedTransport, hasKey, config.ai.baseUrl, config.ai.model, config.ai.apiKey]);

  const commit = (next: StoredChatMessage[]): void => {
    setMessages(next);
    saveChat(config.serverUrl, config.user, next);
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const sendTurn = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (busy || trimmed === '' || transport === null) return;

    const userMessage: StoredChatMessage = {
      id: newId(),
      role: 'user',
      text: trimmed,
      steps: [],
      createdAt: Date.now(),
    };
    const history = toModelHistory(messages);
    commit([...messages, userMessage]);
    setInput('');
    setError(null);
    setNotice(null);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const now = Date.now();
      const tzOffset = deviceTzOffsetMs();
      const semester: Semester | null = config.ai.semester;
      const state = client.planningState();
      const snapshot = buildContextSnapshot({ state, now, tzOffset, semester });
      const systemPrompt = buildSystemPrompt({ now, tzOffset, lang, semester, snapshot });
      const result = await runAgentTurn({
        transport,
        systemPrompt,
        history,
        userText: trimmed,
        context: { state, now, tzOffset, semester, newId },
        tools: createTools(),
        signal: controller.signal,
      });
      if (result.ops.length > 0) client.applyMany(result.ops);
      const reply = result.text.trim();
      commit([
        ...messages,
        userMessage,
        {
          id: newId(),
          role: 'assistant',
          text: reply === '' ? t('agent.emptyReply', { n: result.ops.length }) : reply,
          steps: result.steps,
          createdAt: Date.now(),
        },
      ]);
      if (result.ops.length > 0) setNotice(t('agent.applied', { n: result.ops.length }));
    } catch (e) {
      if (isAbortError(e)) {
        setNotice(t('agent.stopped'));
      } else {
        setError(agentErrorText(e, t));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const clearConversation = (): void => {
    if (!window.confirm(t('agent.clearConfirm'))) return;
    clearChat(config.serverUrl, config.user);
    setMessages([]);
    setError(null);
    setNotice(null);
  };

  const onSemesterChange = (semester: Semester | null): void => {
    updateConfig({ ai: { ...config.ai, semester } });
  };

  const quickPrompts = [
    { id: 'today', label: t('agent.quick.today'), prompt: t('agent.quick.todayPrompt') },
    { id: 'afternoon', label: t('agent.quick.afternoon'), prompt: t('agent.quick.afternoonPrompt') },
  ];

  return (
    <div className="page-wrap agent-page">
      <header className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('agent.title')}</h1>
        </div>
      </header>
      <div className="page-body page-body--narrow">
        {!hasKey ? (
          <section className="card agent-gate" data-testid="agent-needs-key">
            <div className="section-head">
              <h2 className="section-title">{t('agent.needsKey.title')}</h2>
            </div>
            <p className="setting__hint">{t('agent.needsKey.body')}</p>
            <p className="tiny muted">{t('agent.needsKey.privacy')}</p>
            <div className="settings__actions">
              <button
                type="button"
                onClick={onOpenSettings}
                data-testid="agent-open-settings"
                className="btn btn--primary btn--sm"
              >
                {t('agent.needsKey.action')}
              </button>
            </div>
          </section>
        ) : (
          <div className="stack stack--lg">
            <section className="card agent-chat" data-testid="agent-chat">
              <div className="section-head">
                <h2 className="section-title">{t('agent.chatTitle')}</h2>
                <span className="page-meta mono">{t('agent.model', { model: config.ai.model })}</span>
              </div>

              <div className="agent-log" role="log" aria-live="polite" aria-label={t('agent.logLabel')} data-testid="agent-log">
                {messages.length === 0 ? (
                  <p className="empty">{t('agent.empty')}</p>
                ) : (
                  messages.map((message) => <ChatMessage key={message.id} message={message} />)
                )}
                {busy && (
                  <p className="tiny muted agent-thinking" data-testid="agent-thinking">
                    {t('agent.thinking')}
                  </p>
                )}
              </div>

              {error !== null && (
                <p className="notice notice--danger" role="alert" data-testid="agent-error">
                  {error}
                </p>
              )}
              {notice !== null && (
                <p className="notice" role="status" data-testid="agent-notice">
                  {notice}
                </p>
              )}

              <div className="cluster agent-quick">
                {quickPrompts.map((quick) => (
                  <button
                    key={quick.id}
                    type="button"
                    onClick={() => void sendTurn(quick.prompt)}
                    disabled={busy}
                    data-testid={`agent-quick-${quick.id}`}
                    className="btn btn--sm"
                  >
                    {quick.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setImportOpen((open) => !open)}
                  aria-expanded={importOpen}
                  aria-controls="agent-timetable-import"
                  data-testid="agent-quick-import"
                  className="btn btn--sm"
                >
                  {t('agent.quick.import')}
                </button>
              </div>

              <form
                className="agent-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendTurn(input);
                }}
              >
                <textarea
                  rows={2}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendTurn(input);
                    }
                  }}
                  placeholder={t('agent.placeholder')}
                  aria-label={t('agent.placeholder')}
                  disabled={busy}
                  data-testid="agent-input"
                  className="textarea agent-composer__input"
                />
                <div className="agent-composer__actions">
                  {busy ? (
                    <button type="button" onClick={stop} data-testid="agent-stop" className="btn btn--danger btn--sm">
                      {t('agent.stop')}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={input.trim() === ''}
                      data-testid="agent-send"
                      className="btn btn--primary btn--sm"
                    >
                      {t('agent.send')}
                    </button>
                  )}
                  <button type="button" onClick={clearConversation} data-testid="agent-clear" className="btn btn--sm">
                    {t('agent.clear')}
                  </button>
                </div>
              </form>
            </section>

            {importOpen && transport !== null && (
              <div id="agent-timetable-import">
                <TimetableImport
                  client={client}
                  semester={config.ai.semester}
                  onSemesterChange={onSemesterChange}
                  transport={transport}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
