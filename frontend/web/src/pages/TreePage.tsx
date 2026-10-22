import { useEffect, useMemo, useRef, useState } from 'react';
import { filterTree, hasActiveFilter } from '@worktree/core';
import type { Node } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import type { AppConfig, AutoReminderSetting, DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ancestorIds, findNode } from '../tree-utils';
import { TreeView } from '../components/TreeView';
import { FilterBar } from '../components/FilterBar';
import { NodeDetailPanel } from '../components/NodeDetailPanel';
import { highlightView } from '../filter-view';
import { useFilter } from '../filter-context';

export function TreePage(props: {
  tree: Node;
  client: WorktreeClient;
  display: DisplayPrefs;
  updateConfig: (patch: Partial<AppConfig>) => void;
  /** Deep link: select this node when the page first mounts. */
  initialNodeId?: string;
  /** Deep link while mounted (e.g. from a service-worker message); nonce forces re-focus. */
  focusNode?: { id: string; nonce: number } | null;
  /** Forwarded to the detail panel for auto-reminder creation. */
  autoReminder?: AutoReminderSetting;
}) {
  const { t } = useI18n();
  const { tree, client, display, initialNodeId, focusNode, autoReminder } = props;
  // Below 992px the side column is hidden by CSS, so the detail has to become
  // a sheet at the same breakpoint or 768–991px would show no detail at all.
  const compact = useMediaQuery('(max-width: 991px)');
  const { filter, mode, setFilter, setMode } = useFilter();
  const [expanded, setExpanded] = useState<Set<string>>(
    () => (initialNodeId === undefined ? new Set() : new Set(ancestorIds(tree, initialNodeId))),
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeId ?? null);

  const filterActive = hasActiveFilter(filter);
  const view = useMemo(
    () => (mode === 'hide' ? filterTree(tree, filter) : highlightView(tree, filter)),
    [tree, filter, mode],
  );

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const select = (id: string): void => {
    setSelectedId(id);
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  useEffect(() => {
    if (selectedId !== null && findNode(tree, selectedId) === undefined) setSelectedId(null);
  }, [tree, selectedId]);

  useEffect(() => {
    if (focusNode === null || focusNode === undefined) return;
    if (findNode(tree, focusNode.id) === undefined) return;
    setSelectedId(focusNode.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ancestorIds(tree, focusNode.id)) next.add(id);
      next.add(focusNode.id);
      return next;
    });
  }, [focusNode, tree]);

  // Clicking blank space (anything that is not a node row or the detail
  // panel) clears the selection.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const onBlankClick = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-node-id]') !== null) return;
      if (target.closest('[data-detail]') !== null) return;
      setSelectedId(null);
    };
    el.addEventListener('click', onBlankClick);
    return () => el.removeEventListener('click', onBlankClick);
  }, []);

  const selected = selectedId !== null ? findNode(tree, selectedId) : undefined;

  const close = (): void => setSelectedId(null);

  return (
    <div ref={rootRef} className="page-wrap">
      <header className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('tabs.tree')}</h1>
        </div>
      </header>
      <div className="page-body">
        <div className="workbench">
          <div className="workbench__main">
            <div className="tree-panel">
              <FilterBar filter={filter} mode={mode} onFilterChange={setFilter} onModeChange={setMode} />
              <div className="card tree-panel__surface">
                <TreeView
                  root={view}
                  expanded={expanded}
                  selectedId={selectedId}
                  display={display}
                  onToggle={toggle}
                  onSelect={select}
                  filterActive={filterActive}
                  highlightMatches={mode === 'highlight'}
                />
              </div>
            </div>
          </div>
          {!compact && (
            <aside className="workbench__side" data-testid="tree-side">
              {selected !== undefined ? (
                <div className="card">
                  <NodeDetailPanel
                    bare
                    node={selected}
                    client={client}
                    onClose={close}
                    autoReminder={autoReminder}
                  />
                </div>
              ) : (
                <div className="card card--quiet">
                  <p className="small muted">{t('tree.selectHint')}</p>
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
      {compact && selected !== undefined && (
        <div className="sheet" data-testid="tree-sheet">
          <div className="sheet__handle" aria-hidden="true" />
          <NodeDetailPanel bare node={selected} client={client} onClose={close} autoReminder={autoReminder} />
        </div>
      )}
    </div>
  );
}
