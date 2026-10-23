import { Fragment, useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';

/** Inline tokens: `**bold**`, `` `code` `` and http(s)-only links. */
const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
const LINK_TOKEN = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;
const BULLET_LINE = /^-\s+(.*)$/;
const ORDERED_LINE = /^\d+[.)]\s+(.*)$/;

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  const push = (): void => {
    if (current !== null) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') {
      push();
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    if (bullet !== null) {
      if (current === null || current.kind !== 'bullets') {
        push();
        current = { kind: 'bullets', items: [] };
      }
      current.items.push(bullet[1]);
      continue;
    }
    const ordered = ORDERED_LINE.exec(line);
    if (ordered !== null) {
      if (current === null || current.kind !== 'ordered') {
        push();
        current = { kind: 'ordered', items: [] };
      }
      current.items.push(ordered[1]);
      continue;
    }
    if (current === null || current.kind !== 'paragraph') {
      push();
      current = { kind: 'paragraph', lines: [] };
    }
    current.lines.push(line);
  }
  push();
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  INLINE_TOKEN.lastIndex = 0;
  let match = INLINE_TOKEN.exec(text);
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="agent-md__code">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const link = LINK_TOKEN.exec(token);
      if (link === null) {
        nodes.push(token);
      } else {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      }
    }
    last = match.index + token.length;
    match = INLINE_TOKEN.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * The safe markdown subset the assistant is told to use: paragraphs, bold,
 * inline code, `- ` bullets, `1. ` items, http(s) links and line breaks. It
 * builds React nodes directly, so no HTML can ever be injected.
 */
export function MarkdownText({ text, className }: { text: string; className?: string }): ReactElement {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={className === undefined ? 'agent-md' : `agent-md ${className}`}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.kind === 'paragraph') {
          return (
            <p key={key} className="agent-md__p">
              {block.lines.map((line, lineIndex) => (
                <Fragment key={`${key}-line-${lineIndex}`}>
                  {lineIndex > 0 && <br />}
                  {renderInline(line, `${key}-line-${lineIndex}`)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, itemIndex) => (
          <li key={`${key}-item-${itemIndex}`}>{renderInline(item, `${key}-item-${itemIndex}`)}</li>
        ));
        return block.kind === 'bullets' ? (
          <ul key={key} className="agent-md__list">
            {items}
          </ul>
        ) : (
          <ol key={key} className="agent-md__list">
            {items}
          </ol>
        );
      })}
    </div>
  );
}
