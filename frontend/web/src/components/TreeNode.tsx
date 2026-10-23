import { useEffect, useRef, useState } from 'react';
import type { FilteredNode } from '@worktree/core';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { ChevronRightIcon, XIcon } from './icons';
import { NodeLabel } from './NodeLabel';

/** How a node differs from the other side of a conflict. */
export type DiffStyle = 'only' | 'changed';

/** Horizontal distance per tree level, in px. */
export const TREE_INDENT_PX = 18;

/**
 * Width reserved to the left of the indentation for the completion checkbox.
 * It lives outside the indent ladder so the branch guides keep landing on the
 * disclosure column of every level.
 */
export const TREE_GUTTER_PX = 32;

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
  /** Toggles completion; omitted (and hidden) in read-only trees. */
  onToggleComplete?: (id: string) => void;
  /** Adds a child to `parentId`; omitted (and hidden) in read-only trees. */
  onAddChild?: (parentId: string, name: string) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The native checkbox carries the state for assistive tech; the `.check`
 * recipe paints it. The wrapper stops the click so toggling a row never also
 * selects it.
 */
export function CompletionCheckbox(props: {
  id: string;
  completed: boolean;
  testId: string;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const label = props.completed ? t('tree.uncomplete') : t('tree.complete');
  return (
    <label className="check tree__complete" title={label} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={props.completed}
        aria-label={label}
        data-testid={props.testId}
        onChange={props.onChange}
        onClick={(e) => e.stopPropagation()}
      />
    </label>
  );
}

/**
 * The inline child-add field. It stays mounted after a successful add so the
 * user can type the next sibling straight away: Enter submits, Esc or the
 * close button collapses it, and a rejected name (duplicate sibling, invalid
 * characters) reports in place instead of closing the field.
 */
export function InlineAddField(props: {
  parentId: string;
  /** Left offset in px so the field lines up under the row it belongs to. */
  offsetPx: number;
  onAdd: (parentId: string, name: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { parentId, offsetPx, onAdd, onClose } = props;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = (): void => {
    setName('');
    setError(null);
    onClose();
  };

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    try {
      onAdd(parentId, trimmed);
      setName('');
      setError(null);
      inputRef.current?.focus();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div
      className="tree__add-row"
      style={{ paddingLeft: `${offsetPx}px` }}
      data-testid={`node-add-row-${parentId}`}
      onClick={(e) => e.stopPropagation()}
    >
      <form
        className="tree__add-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
              return;
            }
            // Enter while an IME is composing confirms the candidate, not the field.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('tree.addChildPlaceholder')}
          aria-label={t('tree.addChild')}
          aria-invalid={error !== null}
          data-testid={`node-add-input-${parentId}`}
          className="input input--compact tree__add-input"
        />
        <button
          type="button"
          className="btn btn--icon tree__add-close"
          aria-label={t('detail.close')}
          data-testid={`node-add-close-${parentId}`}
          onClick={close}
        >
          <XIcon className="icon icon--sm" />
        </button>
      </form>
      {error !== null && (
        <p className="form__error tree__add-error" role="alert" data-testid={`node-add-error-${parentId}`}>
          {t('tree.addError', { message: error })}
        </p>
      )}
    </div>
  );
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
  /** Leading gutter (completion checkbox) the indent ladder starts after. */
  offsetPx: number;
}) {
  const { depth, openAncestors, dropLine, offsetPx } = props;
  return (
    <span
      className="tree__guides"
      style={offsetPx === 0 ? undefined : { left: `${offsetPx}px` }}
      aria-hidden="true"
    >
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
  const [adding, setAdding] = useState(false);
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
  const onToggleComplete = readOnly === true ? undefined : props.onToggleComplete;
  const onAddChild = readOnly === true ? undefined : props.onAddChild;

  return (
    <>
      <div
        className="tree__row"
        data-node-id={node.id}
        data-depth={depth}
        data-last={isLast === true ? 'true' : 'false'}
        style={onToggleComplete === undefined ? { paddingLeft: `${depth * TREE_INDENT_PX}px` } : undefined}
        onClick={readOnly === true ? undefined : () => onSelect(node.id)}
      >
        <TreeGuides
          depth={depth}
          openAncestors={ancestors}
          dropLine={hasChildren && isOpen}
          offsetPx={onToggleComplete !== undefined ? TREE_GUTTER_PX : 0}
        />
        {onToggleComplete !== undefined && (
          <CompletionCheckbox
            id={node.id}
            completed={node.status}
            testId={`node-complete-${node.id}`}
            onChange={() => onToggleComplete(node.id)}
          />
        )}
        {onToggleComplete !== undefined && (
          <span
            className="tree__indent"
            aria-hidden="true"
            style={{ width: `${depth * TREE_INDENT_PX}px` }}
          />
        )}
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
        {onAddChild !== undefined && (
          <button
            type="button"
            className="tree__add"
            aria-label={t('tree.addChild')}
            aria-expanded={adding}
            data-testid={`node-add-${node.id}`}
            onClick={(e) => {
              e.stopPropagation();
              setAdding(!adding);
            }}
          >
            +
          </button>
        )}
      </div>
      {adding && onAddChild !== undefined && (
        <InlineAddField
          parentId={node.id}
          offsetPx={(onToggleComplete !== undefined ? TREE_GUTTER_PX : 0) + depth * TREE_INDENT_PX + TREE_INDENT_PX}
          onAdd={onAddChild}
          onClose={() => setAdding(false)}
        />
      )}
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
            onToggleComplete={props.onToggleComplete}
            onAddChild={props.onAddChild}
          />
        ))}
    </>
  );
}
