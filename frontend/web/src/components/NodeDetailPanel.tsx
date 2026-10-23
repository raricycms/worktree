import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ROOT_ID } from '@worktree/core';
import type { Node, Reminder } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { useI18n } from '../i18n';
import type { AutoReminderSetting } from '../config';
import { flattenTree, descendants } from '../tree-utils';
import { formatReminder } from '../render';
import { epochToLocalInput, formatLocalDateTime, localInputToEpoch } from '../time';
import { ExpandSelect } from './ExpandSelect';
import { CheckIcon, TrashIcon, XIcon } from './icons';

const REPEAT_PRESETS: { key: string; ms: number | null }[] = [
  { key: 'detail.repeatPresets.none', ms: null },
  { key: 'detail.repeatPresets.hour', ms: 3_600_000 },
  { key: 'detail.repeatPresets.day', ms: 86_400_000 },
  { key: 'detail.repeatPresets.week', ms: 604_800_000 },
];

type DetailTab = 'operation' | 'info' | 'reminders';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseOptionalWeight(raw: string): number | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) throw new Error('weight must be a number');
  return n;
}

/** Post-order (children first) ids of every uncompleted node in the subtree
 *  rooted at `node` (including `node` itself), so completing them in order
 *  is always valid. Callers pass `node.children` to get descendants only. */
function uncompletedSubtree(node: Node): string[] {
  const ids: string[] = [];
  for (const child of node.children) ids.push(...uncompletedSubtree(child));
  if (!node.status) ids.push(node.id);
  return ids;
}

export function NodeDetailPanel(props: {
  node: Node;
  client: WorktreeClient;
  onClose: () => void;
  /** Embedded in a parent surface (e.g. the mobile bottom sheet): drop the card frame. */
  bare?: boolean;
  /** Forwarded to setDeadline; without it no auto-reminder is created. */
  autoReminder?: AutoReminderSetting;
}) {
  const { t } = useI18n();
  const { node, client, onClose, bare, autoReminder } = props;
  const applyDeadline = (deadline: number | null): void => {
    if (autoReminder === undefined) {
      client.setDeadline(node.id, deadline);
      return;
    }
    client.setDeadline(node.id, deadline, {
      autoReminderEnabled: autoReminder.enabled,
      autoReminderPct: autoReminder.pct,
    });
  };
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('operation');

  const [renameValue, setRenameValue] = useState(node.name);
  const [childName, setChildName] = useState('');
  const [childWeight, setChildWeight] = useState('');
  const [moveTarget, setMoveTarget] = useState(ROOT_ID);
  const [moveWeight, setMoveWeight] = useState('');
  const [copyTarget, setCopyTarget] = useState(ROOT_ID);
  const [copyWeight, setCopyWeight] = useState('');
  const [editingRmdId, setEditingRmdId] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState(node.note);
  const [deadlineValue, setDeadlineValue] = useState(
    node.deadline !== undefined ? epochToLocalInput(node.deadline) : '',
  );

  // The panel is reused across selections — reset the field drafts on node change.
  useEffect(() => {
    setRenameValue(node.name);
    setNoteValue(node.note);
    setDeadlineValue(node.deadline !== undefined ? epochToLocalInput(node.deadline) : '');
    setEditingRmdId(null);
  }, [node.id]);

  if (node.id === ROOT_ID) {
    return <RootPanel client={client} onClose={onClose} bare={bare} />;
  }

  const tree = client.getTree();
  const flat = flattenTree(tree);
  const blocked = descendants(tree, node.id);
  const moveOptions = flat.filter((f) => f.node.id !== node.id && !blocked.has(f.node.id));

  const run = (fn: () => void): void => {
    try {
      fn();
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onToggleComplete = (): void => {
    if (node.status) {
      client.setCompleted(node.id, false);
      return;
    }
    const pending = node.children.flatMap(uncompletedSubtree);
    if (pending.length > 0) {
      if (!window.confirm(t('detail.confirmCompleteTree', { name: node.name, count: pending.length }))) return;
      for (const id of pending) client.setCompleted(id, true);
    }
    client.setCompleted(node.id, true);
  };

  const parentLabel = (parentId: string | null, depth: number, name: string): string => {
    if (parentId === null) return '—';
    const prefix = '  '.repeat(Math.max(0, depth - 1));
    return parentId === ROOT_ID ? `${prefix}/` : `${prefix}${name}`;
  };

  const parentSelect = (
    value: string,
    onChange: (v: string) => void,
    options: typeof flat,
  ): ReactElement => (
    // A move/copy target is a long, data-driven tree rendered with indentation,
    // not a short settings vocabulary: it stays a native select on purpose.
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="select w-full sm:w-auto sm:flex-1"
    >
      {options.map((f) => (
        <option key={f.node.id} value={f.node.id}>
          {parentLabel(f.parentId, f.depth, f.node.name)}
        </option>
      ))}
    </select>
  );

  const onSubmitRename = (): void => {
    run(() => client.renameNode(node.id, renameValue.trim()));
  };

  const onSubmitAddChild = (): void => {
    const name = childName.trim();
    if (name === '') return;
    run(() => {
      client.addNode(node.id, name, parseOptionalWeight(childWeight));
      setChildName('');
      setChildWeight('');
    });
  };

  const onSubmitMove = (): void => {
    run(() => client.moveNode(node.id, moveTarget, parseOptionalWeight(moveWeight)));
  };

  const onSubmitCopy = (): void => {
    run(() => {
      client.copyNode(node.id, copyTarget, parseOptionalWeight(copyWeight));
      setCopyWeight('');
    });
  };

  const onSubmitDeadline = (): void => {
    const ms = localInputToEpoch(deadlineValue);
    if (ms === null) {
      setError('invalid deadline');
      return;
    }
    run(() => applyDeadline(ms));
  };

  const onRemove = (): void => {
    // Completed work is already done — removing it is safe and needs no prompt.
    if (!node.status && !window.confirm(t('detail.confirmRemove', { name: node.name }))) return;
    run(() => {
      client.removeNode(node.id);
      onClose();
    });
  };

  const reminders = node.reminders;
  const detailTabs: { id: DetailTab; label: string }[] = [
    { id: 'operation', label: t('detail.tabOperation') },
    { id: 'info', label: t('detail.tabInfo') },
    { id: 'reminders', label: t('detail.tabReminders') },
  ];
  const tabIndex = detailTabs.findIndex((entry) => entry.id === tab);
  if (tabIndex === -1) throw new Error(`unknown detail tab: ${tab}`);

  return (
    <div data-detail className={bare === true ? 'detail' : 'card detail'}>
      <div className="detail__head">
        <h2 className="detail__title">{t('detail.title')}</h2>
        <div className="detail__actions">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('detail.close')}
            className="btn btn--icon"
          >
            <XIcon className="icon" />
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="notice notice--danger" role="alert">
          {t('detail.error', { message: error })}
        </div>
      )}

      <div className="segmented detail__tabs" data-count={detailTabs.length} data-active={tabIndex} role="tablist">
        <span className="segmented__thumb" aria-hidden="true" />
        {detailTabs.map(({ id, label }, index) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={index === tabIndex}
            onClick={() => setTab(id)}
            data-testid={`detail-tab-${id}`}
            className="segmented__item detail__tab"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'operation' && (
        <div className="detail__section">
          <div className="detail__actions">
            <button
              type="button"
              onClick={() => run(onToggleComplete)}
              data-testid="detail-complete"
              className="btn btn--sm btn--primary"
            >
              <CheckIcon className="icon icon--sm" />
              {node.status ? t('detail.uncomplete') : t('detail.complete')}
            </button>
            <button
              type="button"
              onClick={onRemove}
              data-testid="detail-remove"
              className="btn btn--sm btn--danger"
            >
              <TrashIcon className="icon icon--sm" />
              {t('detail.remove')}
            </button>
          </div>

          <div className="form">
            <div className="field">
              <span className="field__label">{t('detail.addChild')}</span>
              <div className="form__row items-center">
                <input
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitAddChild();
                  }}
                  placeholder={t('detail.name')}
                  data-testid="detail-child-name"
                  className="input flex-1 min-w-0"
                />
                <input
                  value={childWeight}
                  onChange={(e) => setChildWeight(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitAddChild();
                  }}
                  placeholder={t('detail.newWeight')}
                  data-testid="detail-child-weight"
                  className="input w-40"
                />
              </div>
              <div className="form__actions">
                <button type="button" onClick={onSubmitAddChild} data-testid="detail-child-apply" className="btn btn--sm">
                  {t('detail.apply')}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">{t('detail.note')}</span>
              <textarea
                value={noteValue}
                onChange={(e) => setNoteValue(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    run(() => client.setNote(node.id, noteValue));
                  }
                }}
                placeholder={t('detail.notePlaceholder')}
                data-testid="detail-note"
                rows={3}
                className="textarea"
              />
              <div className="form__actions">
                <button
                  type="button"
                  onClick={() => run(() => client.setNote(node.id, noteValue))}
                  data-testid="detail-note-save"
                  className="btn btn--sm"
                >
                  {t('detail.saveNote')}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">{t('detail.deadline')}</span>
              <input
                type="datetime-local"
                step="1"
                value={deadlineValue}
                onChange={(e) => setDeadlineValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitDeadline();
                }}
                data-testid="detail-deadline"
                className="input"
              />
              <div className="form__actions">
                <button
                  type="button"
                  onClick={onSubmitDeadline}
                  data-testid="detail-deadline-save"
                  className="btn btn--sm"
                >
                  {t('detail.saveDeadline')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    run(() => {
                      applyDeadline(null);
                      setDeadlineValue('');
                    })
                  }
                  data-testid="detail-deadline-clear"
                  className="btn btn--sm"
                >
                  {t('detail.clearDeadline')}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">{t('detail.rename')}</span>
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitRename();
                }}
                data-testid="detail-rename-input"
                className="input"
              />
              <div className="form__actions">
                <button type="button" onClick={onSubmitRename} data-testid="detail-rename-apply" className="btn btn--sm">
                  {t('detail.apply')}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">{t('detail.moveTo')}</span>
              <div className="form__row items-center">
                {parentSelect(moveTarget, setMoveTarget, moveOptions)}
                <input
                  value={moveWeight}
                  onChange={(e) => setMoveWeight(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitMove();
                  }}
                  placeholder={t('detail.newWeight')}
                  className="input w-40"
                />
              </div>
              <div className="form__actions">
                <button type="button" onClick={onSubmitMove} className="btn btn--sm">
                  {t('detail.apply')}
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field__label">{t('detail.copyTo')}</span>
              <div className="form__row items-center">
                {parentSelect(copyTarget, setCopyTarget, flat)}
                <input
                  value={copyWeight}
                  onChange={(e) => setCopyWeight(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmitCopy();
                  }}
                  placeholder={t('detail.newWeight')}
                  className="input w-40"
                />
              </div>
              <p className="tiny muted">{t('detail.copyNote')}</p>
              <div className="form__actions">
                <button type="button" onClick={onSubmitCopy} className="btn btn--sm">
                  {t('detail.apply')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'info' && (
        <dl className="facts">
          <dt className="fact__key">{t('detail.name')}</dt>
          <dd className="fact__value">{node.name}</dd>
          <dt className="fact__key">{t('detail.id')}</dt>
          <dd className="fact__value mono" data-testid="detail-id">
            {node.id}
          </dd>
          <dt className="fact__key">{t('detail.weight')}</dt>
          <dd className="fact__value mono">{node.weight}</dd>
          <dt className="fact__key">{t('detail.status')}</dt>
          <dd className="fact__value">
            <span className={node.status ? 'pill pill--success' : 'pill'}>
              {node.status ? t('detail.completed') : t('detail.uncompleted')}
            </span>
          </dd>
          <dt className="fact__key">{t('detail.createdAt')}</dt>
          <dd className="fact__value mono" data-testid="detail-created">
            {node.createdAt === 0 ? t('detail.noDeadline') : formatLocalDateTime(node.createdAt)}
          </dd>
          <dt className="fact__key">{t('detail.deadline')}</dt>
          <dd className="fact__value mono" data-testid="detail-deadline-value">
            {node.deadline !== undefined ? formatLocalDateTime(node.deadline) : t('detail.noDeadline')}
          </dd>
        </dl>
      )}

      {tab === 'reminders' && (
        <div className="detail__section">
          {reminders.length === 0 ? (
            <p className="small muted">{t('detail.noReminders')}</p>
          ) : (
            <div className="reminder-box">
              <ul className="reminder-list">
                {reminders.map((r) => (
                  <ReminderRow
                    key={r.id}
                    reminder={r}
                    client={client}
                    editing={editingRmdId === r.id}
                    onStartEdit={() => setEditingRmdId(r.id)}
                    onCancelEdit={() => setEditingRmdId(null)}
                    onError={setError}
                  />
                ))}
              </ul>
            </div>
          )}
          {editingRmdId === null && (
            <ReminderForm
              client={client}
              nodeId={node.id}
              onDone={() => setError(null)}
              onError={setError}
            />
          )}
          {client.isLocal() && <p className="tiny muted">{t('detail.localReminders')}</p>}
        </div>
      )}
    </div>
  );
}

/** The workspace root: only adding top-level nodes makes sense here. */
function RootPanel({
  client,
  onClose,
  bare,
}: {
  client: WorktreeClient;
  onClose: () => void;
  bare?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [weight, setWeight] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    try {
      client.addNode(ROOT_ID, trimmed, parseOptionalWeight(weight));
      setName('');
      setWeight('');
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div data-detail className={bare === true ? 'detail' : 'card detail'}>
      <div className="detail__head">
        <h2 className="detail__title">{t('detail.rootTitle')}</h2>
        <div className="detail__actions">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('detail.close')}
            className="btn btn--icon"
          >
            <XIcon className="icon" />
          </button>
        </div>
      </div>
      <div className="detail__section">
        <div className="form">
          <div className="field">
            <span className="field__label">{t('detail.addChild')}</span>
            <div className="form__row items-center">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
                }}
                placeholder={t('detail.name')}
                data-testid="detail-child-name"
                className="input flex-1 min-w-0"
              />
              <input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
                }}
                placeholder={t('detail.newWeight')}
                data-testid="detail-child-weight"
                className="input w-40"
              />
            </div>
            <div className="form__actions">
              <button type="button" onClick={submit} data-testid="detail-child-apply" className="btn btn--sm">
                {t('detail.apply')}
              </button>
            </div>
          </div>
          {error !== null && (
            <div className="notice notice--danger" role="alert">
              {t('detail.error', { message: error })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReminderRow(props: {
  reminder: Reminder;
  client: WorktreeClient;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useI18n();
  const { reminder, client, editing, onStartEdit, onCancelEdit, onError } = props;

  const run = (fn: () => void): void => {
    try {
      fn();
      onError(null);
    } catch (e) {
      onError(errMsg(e));
    }
  };

  if (editing) {
    return (
      <ReminderForm
        client={client}
        nodeId=""
        reminder={reminder}
        onDone={onCancelEdit}
        onError={onError}
      />
    );
  }

  return (
    <li className="reminder-item">
      <label className="check" title={t('detail.active')}>
        <input
          type="checkbox"
          aria-label={t('detail.active')}
          checked={reminder.active}
          onChange={(e) => run(() => client.editReminder(reminder.id, { active: e.target.checked }))}
        />
      </label>
      <span className={`mono small min-w-0 flex-1 break-all ${reminder.active ? '' : 'muted'}`}>
        {formatReminder(reminder)}
      </span>
      <button type="button" onClick={onStartEdit} className="btn btn--xs">
        {t('detail.edit')}
      </button>
      <button type="button" onClick={() => run(() => client.removeReminder(reminder.id))} className="btn btn--xs btn--danger">
        {t('detail.delete')}
      </button>
    </li>
  );
}

function ReminderForm(props: {
  client: WorktreeClient;
  /** Node for a new reminder; empty when editing an existing one. */
  nodeId: string;
  reminder?: Reminder;
  onDone: () => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useI18n();
  const { client, nodeId, reminder, onDone, onError } = props;
  const isEdit = reminder !== undefined;

  const [name, setName] = useState(reminder?.name ?? '');
  const [deadline, setDeadline] = useState(
    reminder !== undefined ? epochToLocalInput(reminder.deadline) : epochToLocalInput(Date.now()),
  );
  const [repeat, setRepeat] = useState(reminder?.repeat !== undefined ? String(reminder.repeat) : '');
  const [active, setActive] = useState(reminder?.active ?? true);
  const [preset, setPreset] = useState('none');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const deadlineMs = localInputToEpoch(deadline);
    if (deadlineMs === null) {
      setError('invalid deadline');
      return;
    }
    const nameValue = name.trim();
    try {
      if (isEdit) {
        client.editReminder(reminder.id, {
          name: nameValue,
          deadline: deadlineMs,
          repeat: repeat.trim() === '' ? null : Number(repeat),
          active,
        });
      } else {
        client.addReminder(
          nodeId,
          nameValue === '' ? undefined : nameValue,
          deadlineMs,
          repeat.trim() === '' ? undefined : Number(repeat),
        );
      }
      onError(null);
      onDone();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const onPreset = (value: string): void => {
    const p = REPEAT_PRESETS.find((r) => r.key === value);
    setPreset(value);
    setRepeat(p?.ms === null || p === undefined ? '' : String(p.ms));
  };

  const repeatOptions = REPEAT_PRESETS.map((p) => ({ value: p.key, label: t(p.key) }));

  return (
    <div className="form">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
        }}
        placeholder={t('detail.reminderName')}
        data-testid="reminder-name"
        className="input"
      />
      <input
        type="datetime-local"
        step="1"
        value={deadline}
        onChange={(e) => setDeadline(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
        }}
        data-testid="reminder-deadline"
        className="input"
      />
      <div className="form__row items-center">
        <input
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
          placeholder={t('detail.repeatMs')}
          data-testid="reminder-repeat"
          className="input flex-1 min-w-0"
        />
        <ExpandSelect
          value={preset}
          options={repeatOptions}
          onChange={onPreset}
          label={t('rule.freq')}
          testId="detail-repeat-preset"
          className="w-40"
        />
      </div>
      {isEdit && (
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{t('detail.active')}</span>
        </label>
      )}
      {error !== null && <p className="form__error">{error}</p>}
      <div className="form__actions">
        <button type="button" onClick={submit} data-testid="reminder-save" className="btn btn--sm btn--primary">
          {t('detail.save')}
        </button>
        <button type="button" onClick={onDone} className="btn btn--sm">
          {t('detail.cancel')}
        </button>
      </div>
    </div>
  );
}
