import type { FilteredNode } from '@worktree/core';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { RootLabel } from './NodeLabel';
import { TreeNode } from './TreeNode';
import type { DiffStyle } from './TreeNode';

export interface TreeViewProps {
  root: FilteredNode;
  expanded: Set<string>;
  selectedId: string | null;
  display: DisplayPrefs;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  /** Conflict page: rows are not selectable, expansion still works. */
  readOnly?: boolean;
  /** Whether a filter constrains the view (drives dim/highlight styling and the empty state). */
  filterActive?: boolean;
  /** Highlight-mode only: matched rows get the match dot; hide mode leaves them unstyled. */
  highlightMatches?: boolean;
  /** Conflict page: nodes differing from the other version, by style. */
  highlight?: ReadonlyMap<string, DiffStyle>;
}

export function TreeView(props: TreeViewProps) {
  const { t } = useI18n();
  const { root, expanded, selectedId, display, onToggle, onSelect, readOnly, filterActive, highlightMatches } = props;
  const node = root.node;
  const status = node.status ? 'completed' : 'open';
  const rootSelected = selectedId === node.id;
  // The root is a container: it never matches a filter, so with a filter on it
  // is always context (dimmed) rather than a result.
  const rootMatched = filterActive === true && root.matched;
  const rootContext = filterActive === true && !root.matched;
  const rootDiff = props.highlight?.get(node.id);

  return (
    <div className="tree" data-testid="tree-view">
      <div
        className="tree__row tree__root-row"
        data-node-id={node.id}
        data-depth={0}
        onClick={readOnly === true ? undefined : () => onSelect(node.id)}
      >
        {readOnly === true ? (
          <span
            className="tree__label-button"
            data-node-id={node.id}
            data-status={status}
            data-selected={rootSelected ? 'true' : 'false'}
            data-match={rootMatched ? 'true' : 'false'}
            data-context={rootContext ? 'true' : undefined}
            data-diff={rootDiff}
          >
            <RootLabel node={node} display={display} name={t('tree.rootName')} />
          </span>
        ) : (
          <button
            type="button"
            className="tree__label-button"
            data-node-id={node.id}
            data-status={status}
            data-selected={rootSelected ? 'true' : 'false'}
            data-match={rootMatched ? 'true' : 'false'}
            data-context={rootContext ? 'true' : undefined}
            data-diff={rootDiff}
            onClick={(e) => {
              // The row wrapper selects too; stop here so the click is handled once.
              e.stopPropagation();
              onSelect(node.id);
            }}
          >
            <RootLabel node={node} display={display} name={t('tree.rootName')} />
          </button>
        )}
      </div>
      {root.children.length === 0 && (
        <div className="empty">{filterActive === true ? t('tree.filteredEmpty') : t('tree.empty')}</div>
      )}
      {root.children.map((child, index) => (
        <TreeNode
          key={child.node.id}
          view={child}
          depth={1}
          isLast={index === root.children.length - 1}
          expanded={expanded}
          selectedId={selectedId}
          display={display}
          onToggle={onToggle}
          onSelect={onSelect}
          readOnly={readOnly}
          filterActive={filterActive}
          highlightMatches={highlightMatches}
          highlight={props.highlight}
        />
      ))}
    </div>
  );
}
