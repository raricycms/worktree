import { useState } from 'react';
import type { Block, Node } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { findNode } from '../tree-utils';
import { epochToLocalInput, localInputToEpoch } from '../time';
import { HOUR_MS } from '../calendar-utils';
import { NodePicker } from './NodePicker';
import { CheckIcon, LinkIcon, TrashIcon, XIcon } from './icons';

/**
 * Edit (or create) a calendar block. `block === null` means "new block".
 * The node link is chosen through the tree picker, never typed by hand.
 */
export function BlockDetailPanel(props: {
  block: Block | null;
  client: WorktreeClient;
  tree: Node;
  display: DisplayPrefs;
  /** Defaults the new block's start to the current hour. */
  nowMs?: number;
  /** The caller provides its own chrome (modal, bottom sheet). */
  bare?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { block, client, tree, display, nowMs = Date.now(), bare = false, onClose } = props;
  const [name, setName] = useState(block?.name ?? '');
  const [startInput, setStartInput] = useState(
    block !== null ? epochToLocalInput(block.start) : epochToLocalInput(Math.floor(nowMs / HOUR_MS) * HOUR_MS),
  );
  const [endInput, setEndInput] = useState(
    block !== null ? epochToLocalInput(block.end) : epochToLocalInput(Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS),
  );
  const [note, setNote] = useState(block?.note ?? '');
  const [nodeId, setNodeId] = useState<string | null>(block?.nodeId ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = nodeId !== null ? findNode(tree, nodeId) : undefined;

  const save = (): void => {
    const start = localInputToEpoch(startInput);
    const end = localInputToEpoch(endInput);
    if (name === '') {
      setError(t('calendar.nameRequired'));
      return;
    }
    if (start === null || end === null) {
      setError(t('calendar.timeRequired'));
      return;
    }
    if (start >= end) {
      setError(t('calendar.timeOrder'));
      return;
    }
    try {
      if (block === null) {
        client.addBlock({ name, start, end, note, nodeId: nodeId ?? undefined });
      } else {
        client.editBlock(block.id, { name, start, end, note, nodeId });
      }
      onClose();
    } catch (e) {
      setError(t('calendar.error', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <div className="detail" data-testid="block-detail">
      <div className="detail__head">
        <h2 className="detail__title">{block === null ? t('calendar.newTitle') : t('calendar.editTitle')}</h2>
        <button
          type="button"
          data-testid="block-cancel"
          onClick={onClose}
          aria-label={t('calendar.close')}
          className="btn btn--icon"
        >
          <XIcon className="icon" />
        </button>
      </div>

      {block !== null && (
        <div className="detail__actions">
          <button
            type="button"
            data-testid="block-complete"
            onClick={() => client.setBlockCompleted(block.id, !block.status)}
            className={block.status ? 'btn btn--sm' : 'btn btn--sm btn--primary'}
          >
            <CheckIcon className="icon icon--sm" />
            {block.status ? t('detail.uncomplete') : t('detail.complete')}
          </button>
          <button
            type="button"
            data-testid="block-delete"
            onClick={() => {
              if (window.confirm(t('calendar.deleteConfirm', { name: block.name }))) {
                client.removeBlock(block.id);
                onClose();
              }
            }}
            className="btn btn--sm btn--danger"
          >
            <TrashIcon className="icon icon--sm" />
            {t('calendar.delete')}
          </button>
        </div>
      )}

      <div className="form">
        <label className="field">
          <span className="field__label">{t('calendar.name')}</span>
          <input data-testid="block-name" value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </label>

        <div className="form__row">
          <label className="field">
            <span className="field__label">{t('calendar.start')}</span>
            <input
              data-testid="block-start"
              type="datetime-local"
              step={1}
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              className="input"
            />
          </label>
          <label className="field">
            <span className="field__label">{t('calendar.end')}</span>
            <input
              data-testid="block-end"
              type="datetime-local"
              step={1}
              value={endInput}
              onChange={(e) => setEndInput(e.target.value)}
              className="input"
            />
          </label>
        </div>

        <label className="field">
          <span className="field__label">{t('calendar.note')}</span>
          <textarea
            data-testid="block-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="textarea"
            rows={2}
          />
        </label>

        <div className="field">
          <span className="field__label">{t('calendar.linkedNode')}</span>
          <div className="cluster">
            <button
              type="button"
              data-testid="block-link"
              onClick={() => setPickerOpen(true)}
              className="btn btn--sm"
            >
              <LinkIcon className="icon icon--sm" />
              {linked?.name ?? t('calendar.noLink')}
            </button>
            {nodeId !== null && (
              <button
                type="button"
                data-testid="block-link-clear"
                onClick={() => setNodeId(null)}
                className="btn btn--link btn--xs"
              >
                {t('calendar.clearLink')}
              </button>
            )}
          </div>
        </div>

        {error !== null && <p className="form__error">{error}</p>}

        <div className="form__actions">
          <button type="button" data-testid="block-save" onClick={save} className="btn btn--primary">
            {t('calendar.save')}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <NodePicker
          tree={tree}
          display={display}
          currentId={nodeId}
          onPick={(id) => setNodeId(id)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
