import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { filterTree, hasActiveFilter } from '@worktree/core';
import type { Node } from '@worktree/core';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { flattenTree } from '../tree-utils';
import { highlightView } from '../filter-view';
import { useFilter } from '../filter-context';
import { FilterBar } from './FilterBar';
import { TreeView } from './TreeView';

/**
 * Transient full-tree selector: the user clicks a node to link it to a block.
 * Picks are immediate — clicking a row closes the picker. It is portalled to
 * the body because the trigger lives in a card: a transformed or clipped
 * ancestor would otherwise trap this fixed overlay inside the card.
 */
export function NodePicker(props: {
  tree: Node;
  display: DisplayPrefs;
  /** The currently linked node (highlighted in the tree). */
  currentId: string | null;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { tree, display, currentId, onPick, onClose } = props;
  const { filter, mode, setFilter, setMode } = useFilter();
  // Start fully expanded: the user asked to see the whole tree to pick from.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(flattenTree(tree).map((e) => e.node.id)),
  );

  const view = useMemo(
    () => (mode === 'hide' ? filterTree(tree, filter) : highlightView(tree, filter)),
    [tree, filter, mode],
  );
  const filterActive = hasActiveFilter(filter);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div data-testid="node-picker" className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <h2 className="section-title">{t('calendar.pickTitle')}</h2>
            <p className="tiny muted">{t('calendar.pickHint')}</p>
          </div>
        </div>
        <div className="node-picker__filters">
          <FilterBar filter={filter} mode={mode} onFilterChange={setFilter} onModeChange={setMode} />
        </div>
        <TreeView
          root={view}
          expanded={expanded}
          selectedId={currentId}
          display={display}
          onToggle={toggle}
          onSelect={(id) => {
            onPick(id);
            onClose();
          }}
          filterActive={filterActive}
          highlightMatches={mode === 'highlight'}
        />
        <div className="node-picker__footer">
          <button
            type="button"
            data-testid="node-picker-clear"
            onClick={() => {
              onPick(null);
              onClose();
            }}
            className="btn btn--sm"
          >
            {t('calendar.clearLink')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
