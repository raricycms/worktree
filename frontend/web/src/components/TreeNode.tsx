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
 * One guide per ancestor level, drawn in the row's indent space. The last
 * guide is the elbow that turns from the ancestor line into this row's
 * content; the guides are absolutely positioned so they add no layout width
 * and line up with the disclosure columns at every depth.
 */
function TreeGuides({ depth }: { depth: number }) {
  return (
    <span className="tree__guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          className={index === depth - 1 ? 'tree__guide tree__guide--elbow' : 'tree__guide'}
        />
      ))}
    </span>
  );
}

export function TreeNode(props: TreeNodeProps) {
  const {
    view,
    depth,
    isLast,
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
        <TreeGuides depth={depth} />
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
