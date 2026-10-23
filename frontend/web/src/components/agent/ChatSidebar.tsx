import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useI18n } from '../../i18n';
import type { Conversation, ConversationState } from '../../agent/conversations';
import { Check, Pencil, Plus, Trash, X } from './icons';

const DAY_MS = 24 * 60 * 60 * 1000;

type GroupId = 'today' | 'yesterday' | 'previous7' | 'older';

const GROUPS: GroupId[] = ['today', 'yesterday', 'previous7', 'older'];

const GROUP_KEYS: Record<GroupId, string> = {
  today: 'agent.chat.today',
  yesterday: 'agent.chat.yesterday',
  previous7: 'agent.chat.previous7',
  older: 'agent.chat.older',
};

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Which sidebar bucket a conversation belongs to, by its last update. */
function groupOf(updatedAt: number, now: number): GroupId {
  const today = startOfDay(now);
  if (updatedAt >= today) return 'today';
  if (updatedAt >= today - DAY_MS) return 'yesterday';
  if (updatedAt >= today - 7 * DAY_MS) return 'previous7';
  return 'older';
}

function titleOf(conversation: Conversation, untitled: string): string {
  const trimmed = conversation.title.trim();
  return trimmed === '' ? untitled : trimmed;
}

export interface ChatSidebarProps {
  state: ConversationState;
  now: number;
  busy: boolean;
  model: string;
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
  onOpenSettings: () => void;
}

/**
 * The conversation rail. It is a plain list on desktop and an overlay drawer on
 * phones; renaming happens in place, deleting asks for confirmation because a
 * transcript cannot be recovered once its localStorage entry is gone.
 */
export function ChatSidebar(props: ChatSidebarProps): ReactElement {
  const { t } = useI18n();
  const { state, now, busy, model, open, onClose, onNew, onSelect, onRename, onDelete, onOpenSettings } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId !== null) inputRef.current?.focus();
  }, [editingId]);

  const startRename = (conversation: Conversation): void => {
    if (busy) return;
    setEditingId(conversation.id);
    setDraft(conversation.title);
  };

  const cancelRename = (): void => {
    setEditingId(null);
    setDraft('');
  };

  const saveRename = (): void => {
    if (editingId === null) return;
    onRename(editingId, draft);
    setEditingId(null);
    setDraft('');
  };

  const requestDelete = (conversation: Conversation): void => {
    if (busy) return;
    const title = titleOf(conversation, t('agent.chat.untitled'));
    if (window.confirm(t('agent.chat.deleteConfirm', { title }))) onDelete(conversation.id);
  };

  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const grouped: Record<GroupId, Conversation[]> = { today: [], yesterday: [], previous7: [], older: [] };
  for (const conversation of sorted) grouped[groupOf(conversation.updatedAt, now)].push(conversation);

  const busyTitle = busy ? t('agent.chat.busy') : undefined;

  return (
    <aside
      className={`agent-sidebar${open ? ' is-open' : ''}`}
      data-testid="agent-sidebar"
      aria-label={t('agent.chat.sidebarLabel')}
    >
      <div className="agent-sidebar__head">
        <button
          type="button"
          className="agent-new-chat"
          data-testid="agent-new-chat"
          onClick={onNew}
          disabled={busy}
        >
          <Plus size={16} />
          <span>{t('agent.chat.newChat')}</span>
        </button>
        <button
          type="button"
          className="agent-sidebar__close"
          data-testid="agent-sidebar-close"
          aria-label={t('agent.chat.closeSidebar')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <nav className="agent-sidebar__scroll" aria-label={t('agent.chat.sidebarLabel')}>
        {state.conversations.length === 0 && <p className="agent-sidebar__empty tiny muted">{t('agent.chat.empty')}</p>}
        {GROUPS.map((group) => {
          const conversations = grouped[group];
          if (conversations.length === 0) return null;
          return (
            <div className="agent-sidebar__group" key={group}>
              <p className="agent-sidebar__group-title">{t(GROUP_KEYS[group])}</p>
              <ul className="agent-sidebar__items">
                {conversations.map((conversation) => {
                  const active = conversation.id === state.activeId;
                  if (editingId === conversation.id) {
                    return (
                      <li key={conversation.id} className="agent-sidebar__item">
                        <form
                          className="agent-conversation__edit"
                          onSubmit={(event) => {
                            event.preventDefault();
                            saveRename();
                          }}
                        >
                          <input
                            ref={inputRef}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            aria-label={t('agent.chat.rename')}
                            data-testid="agent-rename-input"
                            className="input input--compact agent-conversation__input"
                          />
                          <button
                            type="submit"
                            className="agent-conversation__action"
                            data-testid="agent-rename-save"
                            aria-label={t('agent.chat.renameSave')}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            className="agent-conversation__action"
                            data-testid="agent-rename-cancel"
                            aria-label={t('agent.chat.rename')}
                            onClick={cancelRename}
                          >
                            <X size={14} />
                          </button>
                        </form>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={conversation.id}
                      className={`agent-sidebar__item${active ? ' is-active' : ''}`}
                    >
                      <div className="agent-conversation">
                        <button
                          type="button"
                          className="agent-conversation__open"
                          data-testid={active ? 'agent-conversation-active' : 'agent-conversation'}
                          aria-current={active ? 'page' : undefined}
                          disabled={busy}
                          title={busyTitle ?? t('agent.chat.messageCount', { n: conversation.messages.length })}
                          onClick={() => onSelect(conversation.id)}
                        >
                          <span
                            className="agent-conversation__title"
                            data-testid="agent-conversation-title"
                            title={t('agent.chat.titleHint')}
                            onDoubleClick={() => startRename(conversation)}
                          >
                            {titleOf(conversation, t('agent.chat.untitled'))}
                          </span>
                        </button>
                        {active && (
                          <span className="agent-conversation__actions">
                            <button
                              type="button"
                              className="agent-conversation__action"
                              data-testid="agent-rename"
                              aria-label={t('agent.chat.rename')}
                              title={t('agent.chat.rename')}
                              disabled={busy}
                              onClick={() => startRename(conversation)}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="agent-conversation__action"
                              data-testid="agent-delete"
                              aria-label={t('agent.chat.delete')}
                              title={t('agent.chat.delete')}
                              disabled={busy}
                              onClick={() => requestDelete(conversation)}
                            >
                              <Trash size={13} />
                            </button>
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="agent-sidebar__footer">
        <span className="agent-sidebar__model mono">{t('agent.model', { model })}</span>
        <button
          type="button"
          className="agent-sidebar__settings"
          data-testid="agent-sidebar-settings"
          onClick={onOpenSettings}
        >
          {t('tabs.settings')}
        </button>
      </div>
    </aside>
  );
}
