import { useMemo, useState } from 'react';
import { WorktreeState, filterTree } from '@worktree/core';
import type { HistoryNode, HistoryOperation, Node, Operation } from '@worktree/core';
import type { Conflict, WorktreeClient } from '@worktree/client';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { TreeView } from '../components/TreeView';
import type { DiffStyle } from '../components/TreeNode';
import { formatHistoryNode, formatHistoryOp } from '../conflict-utils';
import { formatNode } from '../render';

function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function replay(ops: Operation[]): Node {
  try {
    return WorktreeState.fromOps(ops).tree.getRoot();
  } catch {
    // Should not happen: base is the shared prefix and serverBranch its
    // suffix. Fall back to an empty tree rather than crashing the page.
    return WorktreeState.fromOps([]).tree.getRoot();
  }
}

/** Node-level diff of the two conflict trees, keyed by node id. */
interface TreeDiff {
  serverOnly: Set<string>;
  localOnly: Set<string>;
  changed: Set<string>;
}

function collect(root: Node, byId: Map<string, Node>): void {
  for (const child of root.children) {
    byId.set(child.id, child);
    collect(child, byId);
  }
}

function treeDiff(server: Node, local: Node, display: DisplayPrefs): TreeDiff {
  const serverById = new Map<string, Node>();
  const localById = new Map<string, Node>();
  collect(server, serverById);
  collect(local, localById);
  const serverOnly = new Set<string>();
  const localOnly = new Set<string>();
  const changed = new Set<string>();
  for (const [id, sn] of serverById) {
    const ln = localById.get(id);
    if (!ln) serverOnly.add(id);
    else if (formatNode(sn, display) !== formatNode(ln, display)) changed.add(id);
  }
  for (const id of localById.keys()) {
    if (!serverById.has(id)) localOnly.add(id);
  }
  return { serverOnly, localOnly, changed };
}

function highlightMap(diff: TreeDiff, only: Set<string>): Map<string, DiffStyle> {
  const map = new Map<string, DiffStyle>();
  for (const id of only) map.set(id, 'only');
  for (const id of diff.changed) map.set(id, 'changed');
  return map;
}

/**
 * The user's intended tree: the agreed base plus their pending ops as they
 * apply to the base. Ops that no longer apply are dropped from the preview.
 */
function replayBranch(base: HistoryNode[], pending: HistoryOperation[]): Node {
  try {
    const history = [...base];
    for (const p of pending) {
      if (p.kind === 'add') {
        const probe = WorktreeState.fromOps(history.map((n) => n.op));
        try {
          probe.apply(p.op);
        } catch {
          continue; // does not apply to the base — dropped from the preview
        }
        history.push({ id: p.id, op: p.op });
      } else if (history.at(-1)?.id === p.id) {
        history.pop();
      }
    }
    return WorktreeState.fromOps(history.map((n) => n.op)).tree.getRoot();
  } catch {
    return WorktreeState.fromOps([]).tree.getRoot();
  }
}

export function ConflictPage(props: {
  conflict: Conflict;
  client: WorktreeClient;
  display: DisplayPrefs;
}) {
  const { t } = useI18n();
  const { conflict, client, display } = props;
  const [serverExpanded, setServerExpanded] = useState<Set<string>>(new Set());
  const [localExpanded, setLocalExpanded] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState<null | 'server' | 'local'>(null);
  const [error, setError] = useState<string | null>(null);

  const serverTree = useMemo(
    () =>
      replay(
        (conflict.cursorFound
          ? [...conflict.base, ...conflict.serverBranch]
          : conflict.serverBranch
        ).map((n) => n.op),
      ),
    [conflict],
  );
  const localTree = useMemo(
    () => replayBranch(conflict.base, conflict.localBranch),
    [conflict],
  );

  const diff = useMemo(() => treeDiff(serverTree, localTree, display), [serverTree, localTree, display]);
  const serverHighlight = useMemo(() => highlightMap(diff, diff.serverOnly), [diff]);
  const localHighlight = useMemo(() => highlightMap(diff, diff.localOnly), [diff]);
  const hasDiff = serverHighlight.size > 0 || localHighlight.size > 0;

  const resolve = async (choice: 'server' | 'local'): Promise<void> => {
    setResolving(choice);
    setError(null);
    try {
      // Keeping the local version rewrites the history to the agreed base
      // plus the pending ops — the tree shown in the "your version" pane.
      await client.resolveConflict(choice);
      // On success the kernel clears the conflict and emits; App unmounts us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResolving(null);
    }
  };

  return (
    <div className="standalone">
      <header className="page-head">
        <div className="page-head__inner">
          <div>
            <h1 className="page-title">{t('conflict.title')}</h1>
            <p className="page-meta mono">{t('conflict.base', { base: conflict.baseId ?? '∅' })}</p>
          </div>
        </div>
      </header>

      <div className="page-body">
        <div className="stack stack--lg">
          <p className="page-lead">{t('conflict.explanation')}</p>

          {hasDiff ? (
            <div className="diff-legend">
              <span className="diff-legend__item">
                <span className="diff-swatch diff-swatch--only" aria-hidden="true" />
                {t('conflict.onlyHere')}
              </span>
              <span className="diff-legend__item">
                <span className="diff-swatch diff-swatch--changed" aria-hidden="true" />
                {t('conflict.changedHere')}
              </span>
            </div>
          ) : (
            <p className="page-meta">{t('conflict.identical')}</p>
          )}

          <div className="split">
            <section className="branch">
              <div className="branch__head">
                <h2 className="section-title">{t('conflict.serverVersion')}</h2>
                <span className="muted small">
                  {t('conflict.newOps', { n: conflict.serverBranch.length })}
                </span>
              </div>
              {conflict.serverBranch.length > 0 && (
                <ul className="branch__ops">
                  {conflict.serverBranch.map((n) => (
                    <li key={n.id}>{formatHistoryNode(n)}</li>
                  ))}
                </ul>
              )}
              <div className="branch__tree">
                <TreeView
                  root={filterTree(serverTree, {})}
                  expanded={serverExpanded}
                  selectedId={null}
                  display={display}
                  onToggle={(id) => setServerExpanded((s) => toggleIn(s, id))}
                  onSelect={() => undefined}
                  readOnly
                  highlight={serverHighlight}
                />
              </div>
            </section>

            <section className="branch">
              <div className="branch__head">
                <h2 className="section-title">{t('conflict.yourVersion')}</h2>
                <span className="muted small">
                  {t('conflict.pendingOps', { n: conflict.localBranch.length })}
                </span>
              </div>
              {conflict.localBranch.length > 0 && (
                <ul className="branch__ops">
                  {conflict.localBranch.map((h) => (
                    <li key={h.id}>{formatHistoryOp(h)}</li>
                  ))}
                </ul>
              )}
              <div className="branch__tree">
                <TreeView
                  root={filterTree(localTree, {})}
                  expanded={localExpanded}
                  selectedId={null}
                  display={display}
                  onToggle={(id) => setLocalExpanded((s) => toggleIn(s, id))}
                  onSelect={() => undefined}
                  readOnly
                  highlight={localHighlight}
                />
              </div>
            </section>
          </div>

          <div className="resolutions">
            <button
              type="button"
              disabled={resolving !== null}
              onClick={() => void resolve('server')}
              data-testid="conflict-keep-server"
              className="btn btn--primary w-full sm:w-auto"
            >
              {resolving === 'server' ? t('conflict.resolving') : t('conflict.keepServer')}
            </button>
            <button
              type="button"
              disabled={resolving !== null}
              onClick={() => void resolve('local')}
              data-testid="conflict-keep-local"
              className="btn btn--primary w-full sm:w-auto"
            >
              {resolving === 'local' ? t('conflict.resolving') : t('conflict.keepLocal')}
            </button>
          </div>

          {error !== null && (
            <div className="notice notice--danger">{t('conflict.error', { message: error })}</div>
          )}
        </div>
      </div>
    </div>
  );
}
