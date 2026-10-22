import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { ROOT_ID } from '@worktree/core';
import type { Node } from '@worktree/core';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { nodeRowParts, shortId } from '../render';
import type { NodeRowPart } from '../render';
import { formatLocalDateTime } from '../time';
import { CheckIcon, ClockIcon, PencilIcon } from './icons';

/** One node row, same token order as the CLI format, but markers as SVG icons. */
export function NodeLabel({
  node,
  display,
  matched,
}: {
  node: Node;
  display: DisplayPrefs;
  /** Highlight-mode match: the dot is the non-colour match signal. */
  matched?: boolean;
}): ReactNode {
  const { t } = useI18n();
  return (
    <>
      {matched === true && <span className="node-match" aria-hidden="true" />}
      {nodeRowParts(node, display).map((part, i) => (
        <Fragment key={i}>
          {renderPart(part, t('stats.completed'))}
          {' '}
        </Fragment>
      ))}
    </>
  );
}

function renderPart(part: NodeRowPart, completedLabel: string): ReactNode {
  switch (part.type) {
    case 'name':
      return <span className="node-name">{part.text}</span>;
    case 'id':
      return (
        <span className="node-id">
          [{shortId(part.id)}]
        </span>
      );
    case 'status':
      // The check icon carries the visual "done" state; the hidden word keeps
      // the same information available without colour or glyph recognition.
      return (
        <>
          <CheckIcon className="node-status" />
          <span className="visually-hidden">{completedLabel}</span>
        </>
      );
    case 'weight':
      return <span className="node-meta node-meta--mono">w:{part.weight}</span>;
    case 'deadline':
      return (
        <span className="node-meta node-meta--mono">
          <ClockIcon className="icon icon--sm" />
          {formatLocalDateTime(part.ms)}
        </span>
      );
    case 'note':
      return (
        <span className="node-meta">
          <PencilIcon className="icon icon--sm" />
          <span className="node-note">{part.text}</span>
        </span>
      );
    case 'reminders':
      return (
        <span className="node-meta node-meta--mono">
          R({part.count}):{part.text}
        </span>
      );
  }
}

/** The tree headline: `name` for the worktree root, the node row itself otherwise. */
export function RootLabel({
  node,
  display,
  name,
}: {
  node: Node;
  display: DisplayPrefs;
  name: string;
}): ReactNode {
  return node.id === ROOT_ID ? <>{name}</> : <NodeLabel node={node} display={display} />;
}
