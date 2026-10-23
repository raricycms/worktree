import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { newId } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import {
  buildContextSnapshot,
  buildSystemPrompt,
  createChatTransport,
  createTools,
  rowsToRules,
  runAgentTurn,
} from '@worktree/agent';
import type {
  AgentEvent,
  AgentImage,
  AgentStep,
  AgentTurnResult,
  AskUserRequest,
  LlmTransport,
  Semester,
  TimetableRow,
} from '@worktree/agent';
import { useI18n } from '../i18n';
import type { AppConfig } from '../config';
import type { ChatArtifact, ChatAttachment, ChatMessage, Conversation, ConversationState } from '../agent/conversations';
import {
  activeConversation,
  appendMessages,
  autoTitle,
  deleteConversation,
  loadConversations,
  modelHistory,
  newConversation,
  patchMessage,
  renameConversation,
  saveConversations,
  selectConversation,
} from '../agent/conversations';
import { MAX_ATTACHMENTS, MAX_IMAGE_MB, imageFileProblem, prepareAttachment } from '../agent/attachments';
import { agentErrorText, deviceTzOffsetMs, isAbortError } from '../agent/runtime';
import { AskCard } from '../components/agent/AskCard';
import { ChatSidebar } from '../components/agent/ChatSidebar';
import { Composer } from '../components/agent/Composer';
import { EmptyState } from '../components/agent/EmptyState';
import { MessageBubble } from '../components/agent/MessageBubble';
import { Menu } from '../components/agent/icons';

/** The scroll position counts as "at the bottom" within this many pixels. */
const STICK_THRESHOLD = 48;

/** Mutable accumulation for a streaming turn; published to React per frame. */
interface LiveTurn {
  text: string;
  reasoning: string;
  steps: AgentStep[];
  runningTool: string | null;
  startedAt: number;
}

interface PendingAsk {
  request: AskUserRequest;
  resolve: (answer: string) => void;
  reject: (reason: unknown) => void;
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/**
 * The assistant page: a local conversation rail, a streaming thread and a
 * composer with image attachments. A turn snapshots the planning state, lets
 * the model call tools, then applies the returned ops through `applyMany` once;
 * timetable previews are committed as cards and only written on confirmation.
 */
export function AgentPage(props: {
  client: WorktreeClient;
  config: AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => void;
  onOpenSettings: () => void;
  /** A fake transport for tests; production builds one from `config.ai`. */
  transport?: LlmTransport;
}): ReactElement {
  const { t, lang } = useI18n();
  const { client, config, updateConfig, onOpenSettings, transport: injectedTransport } = props;

  const hasKey = config.ai.apiKey.trim() !== '';
  const [conversations, setConversations] = useState<ConversationState>(() =>
    loadConversations(config.serverUrl, config.user),
  );
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [pendingAsk, setPendingAsk] = useState<AskUserRequest | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const stateRef = useRef<ConversationState>(conversations);
  const abortRef = useRef<AbortController | null>(null);
  const liveRef = useRef<LiveTurn | null>(null);
  const rafRef = useRef<number | null>(null);
  const askRef = useRef<PendingAsk | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const conversation: Conversation = activeConversation(conversations);
  const messages = conversation.messages;

  const transport = useMemo((): LlmTransport | null => {
    if (injectedTransport !== undefined) return injectedTransport;
    if (!hasKey) return null;
    return createChatTransport({
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      apiKey: config.ai.apiKey,
    });
  }, [injectedTransport, hasKey, config.ai.baseUrl, config.ai.model, config.ai.apiKey]);

  /** Persists a pure conversation-state transition (and mirrors it to the ref). */
  const commit = useCallback(
    (next: ConversationState): void => {
      stateRef.current = next;
      setConversations(next);
      saveConversations(config.serverUrl, config.user, next);
    },
    [config.serverUrl, config.user],
  );

  useEffect(() => {
    const next = loadConversations(config.serverUrl, config.user);
    stateRef.current = next;
    setConversations(next);
    setLive(null);
    liveRef.current = null;
    setPendingAsk(null);
    askRef.current = null;
    setError(null);
    setNotice(null);
    setInput('');
    setAttachments([]);
  }, [config.serverUrl, config.user]);

  useEffect(() => {
    setTitleEditing(false);
  }, [conversation.id]);

  // A turn-level status line is an acknowledgement, not a permanent banner.
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      abortRef.current?.abort();
      const pending = askRef.current;
      askRef.current = null;
      pending?.reject(abortError());
    },
    [],
  );

  const publishLive = useCallback((): void => {
    const current = liveRef.current;
    if (current === null) {
      setLive(null);
      return;
    }
    setLive({
      text: current.text,
      reasoning: current.reasoning,
      steps: [...current.steps],
      runningTool: current.runningTool,
      startedAt: current.startedAt,
    });
  }, []);

  /** React state updates from streaming are batched to one per animation frame. */
  const scheduleLive = useCallback((): void => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      publishLive();
    });
  }, [publishLive]);

  const flushLive = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    publishLive();
  }, [publishLive]);

  const handleEvent = useCallback(
    (event: AgentEvent): void => {
      const current = liveRef.current;
      if (current === null) return;
      if (event.type === 'text') {
        current.text += event.delta;
      } else if (event.type === 'reasoning') {
        current.reasoning += event.delta;
      } else if (event.type === 'tool_start') {
        current.runningTool = event.name;
        current.steps.push({ tool: event.name, args: event.args, summary: t('agent.steps.working'), ok: true });
      } else {
        current.runningTool = null;
        const last = current.steps[current.steps.length - 1];
        if (last !== undefined && last.tool === event.name) {
          current.steps[current.steps.length - 1] = { ...last, ok: event.ok, summary: event.summary };
        }
      }
      scheduleLive();
    },
    [scheduleLive, t],
  );

  const onAskUser = useCallback(
    (request: AskUserRequest): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        askRef.current = { request, resolve, reject };
        setPendingAsk(request);
      }),
    [],
  );

  const answerAsk = useCallback((answer: string): void => {
    const pending = askRef.current;
    if (pending === null) return;
    askRef.current = null;
    setPendingAsk(null);
    pending.resolve(answer);
  }, []);

  const stopTurn = useCallback((): void => {
    const pending = askRef.current;
    if (pending !== null) {
      askRef.current = null;
      setPendingAsk(null);
      pending.reject(abortError());
    }
    abortRef.current?.abort();
  }, []);

  const appendNote = useCallback(
    (conversationId: string, text: string): void => {
      const note: ChatMessage = {
        id: newId(),
        role: 'note',
        text,
        createdAt: Date.now(),
        steps: [],
        images: [],
        asks: [],
      };
      commit(appendMessages(stateRef.current, conversationId, note));
    },
    [commit],
  );

  const commitTurn = useCallback(
    (conversationId: string, result: AgentTurnResult): void => {
      const committed: ChatMessage[] = [];
      const text = result.text.trim();
      const shownText =
        text === '' && result.artifacts.length === 0 ? t('agent.emptyReply', { n: result.ops.length }) : result.text;
      if (shownText !== '' || result.steps.length > 0 || result.asks.length > 0) {
        committed.push({
          id: newId(),
          role: 'assistant',
          text: shownText,
          createdAt: Date.now(),
          steps: result.steps,
          images: [],
          asks: result.asks,
        });
      }
      for (const artifact of result.artifacts) {
        committed.push({
          id: newId(),
          role: 'assistant',
          text: '',
          createdAt: Date.now(),
          steps: [],
          images: [],
          asks: [],
          artifact: {
            kind: 'timetable',
            rows: artifact.rows,
            warnings: artifact.warnings,
            state: 'pending',
          },
        });
      }
      if (committed.length > 0) commit(appendMessages(stateRef.current, conversationId, committed));
      if (result.ops.length > 0) setNotice(t('agent.applied', { n: result.ops.length }));
    },
    [commit, t],
  );

  const commitAborted = useCallback(
    (conversationId: string): void => {
      const current = liveRef.current;
      const committed: ChatMessage[] = [];
      const partial = current === null ? '' : current.text.trim();
      if (partial !== '' && current !== null) {
        committed.push({
          id: newId(),
          role: 'assistant',
          text: partial,
          createdAt: Date.now(),
          steps: current.steps,
          images: [],
          asks: [],
        });
      }
      committed.push({
        id: newId(),
        role: 'note',
        text: t('agent.note.stopped'),
        createdAt: Date.now(),
        steps: [],
        images: [],
        asks: [],
      });
      commit(appendMessages(stateRef.current, conversationId, committed));
    },
    [commit, t],
  );

  const send = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (busy || !hasKey || transport === null) return;
    const outgoing = attachments;
    if (text === '' && outgoing.length === 0) return;

    const target = activeConversation(stateRef.current);
    const userMessage: ChatMessage = {
      id: newId(),
      role: 'user',
      text,
      createdAt: Date.now(),
      steps: [],
      images: outgoing,
      asks: [],
    };
    const history = modelHistory(target.messages);
    let nextState = appendMessages(stateRef.current, target.id, userMessage);
    if (target.title.trim() === '' && text !== '') {
      nextState = renameConversation(nextState, target.id, autoTitle(text));
    }
    commit(nextState);
    setInput('');
    setAttachments([]);
    setAttachError(null);
    setError(null);
    setNotice(null);
    setBusy(true);

    const initialLive: LiveTurn = { text: '', reasoning: '', steps: [], runningTool: null, startedAt: Date.now() };
    liveRef.current = initialLive;
    setLive(initialLive);
    stickRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const turnNow = Date.now();
      const tzOffset = deviceTzOffsetMs();
      const semester: Semester | null = config.ai.semester;
      const state = client.planningState();
      const snapshot = buildContextSnapshot({ state, now: turnNow, tzOffset, semester });
      const systemPrompt = buildSystemPrompt({ now: turnNow, tzOffset, lang, semester, snapshot });
      const images: AgentImage[] = outgoing.map((attachment) => ({
        id: attachment.id,
        dataUrl: attachment.dataUrl,
        name: attachment.name,
      }));
      const result = await runAgentTurn({
        transport,
        systemPrompt,
        history,
        userText: text,
        images,
        context: { state, now: turnNow, tzOffset, semester, newId, askUser: onAskUser },
        tools: createTools(),
        signal: controller.signal,
        onEvent: handleEvent,
        onAskUser,
      });
      flushLive();
      if (result.ops.length > 0) client.applyMany(result.ops);
      commitTurn(target.id, result);
    } catch (caught) {
      flushLive();
      if (isAbortError(caught)) {
        commitAborted(target.id);
      } else {
        setError(agentErrorText(caught, t));
      }
    } finally {
      abortRef.current = null;
      askRef.current = null;
      setPendingAsk(null);
      liveRef.current = null;
      setLive(null);
      setBusy(false);
      setNow(Date.now());
    }
  };

  const stop = (): void => {
    stopTurn();
  };

  const startNewChat = (): void => {
    if (busy) return;
    commit(newConversation(stateRef.current));
    stickRef.current = true;
    setSidebarOpen(false);
    setError(null);
    setNotice(null);
    setInput('');
    setAttachments([]);
    setAttachError(null);
  };

  const selectChat = (conversationId: string): void => {
    if (busy) return;
    commit(selectConversation(stateRef.current, conversationId));
    stickRef.current = true;
    setSidebarOpen(false);
    setError(null);
    setNotice(null);
  };

  const renameChat = (conversationId: string, title: string): void => {
    if (busy) return;
    commit(renameConversation(stateRef.current, conversationId, title));
  };

  const deleteChat = (conversationId: string): void => {
    if (busy) return;
    commit(deleteConversation(stateRef.current, conversationId));
  };

  const onSemesterChange = (semester: Semester | null): void => {
    updateConfig({ ai: { ...config.ai, semester } });
  };

  const addFiles = async (files: File[]): Promise<void> => {
    if (busy || !hasKey) return;
    setAttachError(null);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(t('agent.attach.limit', { n: MAX_ATTACHMENTS }));
      return;
    }
    if (files.length > room) setAttachError(t('agent.attach.limit', { n: MAX_ATTACHMENTS }));
    setAttaching(true);
    try {
      const prepared: ChatAttachment[] = [];
      for (const file of files.slice(0, room)) {
        const problem = imageFileProblem(file);
        if (problem === 'type') {
          setAttachError(t('agent.attach.invalidType'));
          continue;
        }
        if (problem === 'size') {
          setAttachError(t('agent.attach.tooLarge', { mb: MAX_IMAGE_MB }));
          continue;
        }
        try {
          prepared.push(await prepareAttachment(file));
        } catch (caught) {
          setAttachError(
            t('agent.attach.failed', { message: caught instanceof Error ? caught.message : String(caught) }),
          );
        }
      }
      if (prepared.length > 0) {
        setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS));
      }
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = (id: string): void => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const confirmTimetable = async (messageId: string, rows: TimetableRow[]): Promise<void> => {
    const semester = config.ai.semester;
    if (semester === null) throw new Error(t('agent.timetable.needSemester'));
    const plan = rowsToRules(rows, {
      semester,
      tzOffset: deviceTzOffsetMs(),
      newId,
      existingRules: client.getRules(),
    });
    client.applyMany(plan.ops);
    const ruleIds: string[] = [];
    for (const op of plan.ops) {
      if (op.kind === 'add_block_rule') ruleIds.push(op.id);
    }
    const current = stateRef.current;
    const source = activeConversation(current);
    const message = source.messages.find((entry) => entry.id === messageId);
    if (message === undefined || message.artifact === undefined) {
      throw new Error(`unknown timetable message: ${messageId}`);
    }
    const note = t('agent.timetable.applied', { n: ruleIds.length, skipped: plan.duplicates.length });
    const artifact: ChatArtifact = { ...message.artifact, state: 'applied', ruleIds, note };
    commit(patchMessage(current, source.id, messageId, { artifact }));
  };

  const cancelTimetable = (messageId: string): void => {
    const current = stateRef.current;
    const source = activeConversation(current);
    const message = source.messages.find((entry) => entry.id === messageId);
    if (message === undefined || message.artifact === undefined) {
      throw new Error(`unknown timetable message: ${messageId}`);
    }
    const note = t('agent.timetable.cancelled');
    const artifact: ChatArtifact = { ...message.artifact, state: 'cancelled', note };
    commit(patchMessage(current, source.id, messageId, { artifact }));
  };

  const beginTitleEdit = (): void => {
    if (busy) return;
    setTitleDraft(conversation.title);
    setTitleEditing(true);
  };

  const saveTitle = (): void => {
    if (!titleEditing) return;
    setTitleEditing(false);
    renameChat(conversation.id, titleDraft);
  };

  const onScroll = (): void => {
    const element = logRef.current;
    if (element === null) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD;
  };

  const liveText = live === null ? '' : live.text;

  // Keep the thread pinned to the bottom while the user has not scrolled away.
  useEffect(() => {
    const element = logRef.current;
    if (element === null || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, liveText.length, pendingAsk]);

  const liveMessage: ChatMessage | null =
    live === null
      ? null
      : {
          id: 'agent-live',
          role: 'assistant',
          text: live.text,
          createdAt: live.startedAt,
          steps: live.steps,
          images: [],
          asks: [],
        };

  const showThinking = live !== null && pendingAsk === null && (live.text === '' || live.runningTool !== null);
  const emptyThread = messages.length === 0 && live === null;

  return (
    <div className={`agent-page${sidebarOpen ? ' agent-page--drawer-open' : ''}`}>
      {sidebarOpen && (
        <button
          type="button"
          className="agent-scrim"
          data-testid="agent-sidebar-scrim"
          aria-label={t('agent.chat.closeSidebar')}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <ChatSidebar
        state={conversations}
        now={now}
        busy={busy}
        model={config.ai.model}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={startNewChat}
        onSelect={selectChat}
        onRename={renameChat}
        onDelete={deleteChat}
        onOpenSettings={onOpenSettings}
      />

      <section className="agent-main">
        <header className="agent-main__head">
          <button
            type="button"
            className="agent-menu-btn"
            data-testid="agent-sidebar-toggle"
            aria-label={sidebarOpen ? t('agent.chat.closeSidebar') : t('agent.chat.openSidebar')}
            title={t('agent.chat.menu')}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <Menu size={18} />
          </button>
          {titleEditing ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  saveTitle();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setTitleEditing(false);
                }
              }}
              aria-label={t('agent.chat.rename')}
              data-testid="agent-thread-title-input"
              className="input input--compact agent-main__title-input"
            />
          ) : (
            <h1
              className="agent-main__title"
              data-testid="agent-thread-title"
              title={t('agent.chat.titleHint')}
              onDoubleClick={beginTitleEdit}
            >
              {conversation.title.trim() === '' ? t('agent.chat.untitled') : conversation.title}
            </h1>
          )}
          <span className="agent-main__model mono">{t('agent.model', { model: config.ai.model })}</span>
        </header>

        <div
          className={`agent-log${!hasKey ? ' agent-log--gate' : ''}`}
          role="log"
          aria-live="polite"
          aria-label={t('agent.chatTitle')}
          data-testid="agent-log"
          ref={logRef}
          onScroll={onScroll}
        >
          {!hasKey ? (
            <section className="agent-gate" data-testid="agent-needs-key">
              <h2 className="agent-gate__title">{t('agent.needsKey.title')}</h2>
              <p className="agent-gate__body">{t('agent.needsKey.body')}</p>
              <p className="agent-gate__privacy tiny muted">{t('agent.needsKey.privacy')}</p>
              <button
                type="button"
                onClick={onOpenSettings}
                data-testid="agent-open-settings"
                className="btn btn--primary"
              >
                {t('agent.needsKey.action')}
              </button>
            </section>
          ) : (
            <>
              {emptyThread && (
                <EmptyState
                  onSuggestion={(prompt) => {
                    void send(prompt);
                  }}
                />
              )}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  semester={config.ai.semester}
                  onSemesterChange={onSemesterChange}
                  client={client}
                  disabled={busy}
                  onConfirmTimetable={confirmTimetable}
                  onCancelTimetable={cancelTimetable}
                />
              ))}
              {liveMessage !== null && (
                <div className="agent-live" data-testid="agent-live">
                  <MessageBubble
                    message={liveMessage}
                    live
                    runningTool={live?.runningTool ?? null}
                    semester={config.ai.semester}
                    onSemesterChange={onSemesterChange}
                    client={client}
                  />
                  {pendingAsk !== null && <AskCard request={pendingAsk} onAnswer={answerAsk} />}
                  {showThinking && (
                    <p className="agent-thinking" data-testid="agent-thinking">
                      <span className="agent-dots" aria-hidden="true">
                        <span className="agent-dot" />
                        <span className="agent-dot" />
                        <span className="agent-dot" />
                      </span>
                      <span className="agent-thinking__label">
                        {live?.runningTool === null || live?.runningTool === undefined
                          ? t('agent.live.thinking')
                          : t('agent.steps.working')}
                      </span>
                    </p>
                  )}
                  {live !== null && live.reasoning !== '' && (
                    <details className="agent-reasoning">
                      <summary className="agent-reasoning__summary">
                        {t('agent.reasoning.title')} ·{' '}
                        {t('agent.live.reasoning', {
                          seconds: Math.max(0, Math.round((Date.now() - live.startedAt) / 1000)),
                        })}
                      </summary>
                      <p className="agent-reasoning__text">{live.reasoning}</p>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {error !== null && (
          <p className="notice notice--danger agent-main__notice" role="alert" data-testid="agent-error">
            {error}
          </p>
        )}
        {notice !== null && (
          <p className="notice agent-main__notice" role="status" data-testid="agent-notice">
            {notice}
          </p>
        )}

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => {
            void send(input);
          }}
          onStop={stop}
          busy={busy}
          disabled={!hasKey}
          attachments={attachments}
          attachError={attachError}
          attaching={attaching}
          onFiles={(files) => {
            void addFiles(files);
          }}
          onRemoveAttachment={removeAttachment}
        />
      </section>
    </div>
  );
}
