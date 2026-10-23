import type { FilteredNode } from '@worktree/core';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { ChevronRightIcon } from './icons';
import { NodeLabel } from './NodeLabel';

/** How a node differs from the other side of a conflict. */
export type DiffStyle = 'only' | 'changed';

/** Horizontal distance per tree level, in px. */
const INDENT_PX = 18;

export interface TreeNodeProps {
  view: FilteredNode;
  /** Indentation level: 1 for a direct child of the root. */
  depth: number;
  /** Whether this row is the last of its siblings; the guide trunk stops there. */
  isLast?: boolean;
  /**
   * One flag per ancestor level, by ancestor depth: true when that ancestor
   * has a following sibling, so its guide column passes through this row.
   */
  openAncestors?: readonly boolean[];
  expanded: Set<string>;
  selectedId: string | null;
  display: DisplayPrefs;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  readOnly?: boolean;
  filterActive?: boolean;
  /** Highlight-mode only: matched rows get the match dot. */
  highlightMatches?: boolean;
  /** Conflict page: nodes differing from the other version, by style. */
  highlight?: ReadonlyMap<string, DiffStyle>;
}

/**
 * One guide column per ancestor level, drawn in the row's indent space, plus
 * the elbow column that turns into this row and (for an expanded row) the drop
 * column under its own chevron. Columns are absolutely positioned so they add
 * no layout width and line up with the disclosure columns at every depth. A
 * column exists at every level so the following columns keep their x; only the
 * ancestors with a following sibling actually paint a line.
 */
function TreeGuides(props: {
  depth: number;
  openAncestors: readonly boolean[];
  /** This row's children are open: its branch continues down the row. */
  dropLine: boolean;
}) {
  const { depth, openAncestors, dropLine } = props;
  return (
    <span className="tree__guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => {
        if (index === depth - 1) return <span key={index} className="tree__guide tree__guide--elbow" />;
        return (
          <span
            key={index}
            className={
              openAncestors[index] === true ? 'tree__guide tree__guide--trunk' : 'tree__guide'
            }
          />
        );
      })}
      {dropLine && <span className="tree__guide tree__guide--drop" />}
    </span>
  );
}

export function TreeNode(props: TreeNodeProps) {
  const {
    view,
    depth,
    isLast,
    openAncestors,
    expanded,
    selectedId,
    display,
    onToggle,
    onSelect,
    readOnly,
    filterActive,
    highlightMatches,
  } = props;
  const { t } = useI18n();
  const node = view.node;
  const hasChildren = view.children.length > 0;
  const isOpen = expanded.has(node.id);
  const ancestors = openAncestors ?? [];
  const isSelected = selectedId === node.id;
  const diff = props.highlight?.get(node.id);
  const matched = filterActive === true && view.matched;
  const context = filterActive === true && !view.matched;
  const showMatchDot = matched && highlightMatches === true;
  const status = node.status ? 'completed' : 'open';

  return (
    <>
      <div
        className="tree__row"
        data-node-id={node.id}
        data-depth={depth}
        data-last={isLast === true ? 'true' : 'false'}
        style={{ paddingLeft: `${depth * INDENT_PX}px` }}
        onClick={readOnly === true ? undefined : () => onSelect(node.id)}
      >
        <TreeGuides depth={depth} openAncestors={ancestors} dropLine={hasChildren && isOpen} />
        {hasChildren ? (
          <button
            type="button"
            className="tree__disclosure"
            aria-label={isOpen ? t('tree.collapse') : t('tree.expand')}
            aria-expanded={isOpen}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            <ChevronRightIcon className="icon icon--sm" />
          </button>
        ) : (
          <span className="tree__disclosure-spacer" aria-hidden="true" />
        )}
        {readOnly === true ? (
          <span
            className="tree__label-button"
            data-node-id={node.id}
            data-status={status}
            data-selected={isSelected ? 'true' : 'false'}
            data-match={matched ? 'true' : 'false'}
            data-context={context ? 'true' : undefined}
            data-diff={diff}
          >
            <NodeLabel node={node} display={display} matched={showMatchDot} />
          </span>
        ) : (
          <button
            type="button"
            className="tree__label-button"
            data-node-id={node.id}
            data-status={status}
            data-selected={isSelected ? 'true' : 'false'}
            data-match={matched ? 'true' : 'false'}
            data-context={context ? 'true' : undefined}
            data-diff={diff}
            onClick={(e) => {
              // The row wrapper selects too; stop here so the click is handled once.
              e.stopPropagation();
              onSelect(node.id);
            }}
          >
            <NodeLabel node={node} display={display} matched={showMatchDot} />
          </button>
        )}
      </div>
      {hasChildren &&
        isOpen &&
        view.children.map((child, index) => (
          <TreeNode
            key={child.node.id}
            view={child}
            depth={depth + 1}
            isLast={index === view.children.length - 1}
            openAncestors={[...ancestors, isLast !== true]}
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
    </>
  );
}
