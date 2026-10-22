import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tree, filterTree } from '@worktree/core';
import { ROOT_ID } from '@worktree/core';
import type { FilteredNode, NodeFilter } from '@worktree/core';
import { I18nProvider } from '../src/i18n';
import { TreeView } from '../src/components/TreeView';
import type { DiffStyle } from '../src/components/TreeNode';
import type { DisplayPrefs } from '../src/config';

const display: DisplayPrefs = { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' };

const tree = Tree.fromOps([
  { kind: 'add', parentId: ROOT_ID, id: 'aaaa-1', name: 'alpha', weight: 1 },
  { kind: 'add', parentId: 'aaaa-1', id: 'bbbb-1', name: 'beta', weight: 1 },
  { kind: 'complete', id: 'bbbb-1' },
  { kind: 'complete', id: 'aaaa-1' },
  { kind: 'add', parentId: ROOT_ID, id: 'cccc-1', name: 'gamma', weight: 2 },
]).getRoot();

function Harness({
  onSelect,
  selectedId = null,
  filter,
  filterActive,
  highlightMatches,
}: {
  onSelect: (id: string) => void;
  selectedId?: string | null;
  filter?: NodeFilter;
  filterActive?: boolean;
  highlightMatches?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['aaaa-1']));
  const view: FilteredNode = filter !== undefined ? filterTree(tree, filter) : filterTree(tree, {});
  return (
    <I18nProvider lang="en">
      <TreeView
        root={view}
        expanded={expanded}
        selectedId={selectedId}
        display={display}
        onToggle={(id) =>
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onSelect={onSelect}
        filterActive={filterActive}
        highlightMatches={highlightMatches}
      />
    </I18nProvider>
  );
}

function row(depth: number, id: string): Element | null {
  return document.querySelector(`[data-node-id="${id}"][data-depth="${depth}"]`);
}

describe('TreeView', () => {
  it('renders the root and the hierarchy as indented rows with the CLI token order', () => {
    render(<Harness onSelect={() => undefined} />);
    const view = screen.getByTestId('tree-view');
    expect(view.textContent).toContain('workroot');
    expect(screen.getByRole('button', { name: /gamma \[cccc\] w:2/ })).toBeTruthy();
    // The check marker is an icon plus a visually-hidden status word, so the
    // remaining tokens are unchanged: name, [id4], status, w:N.
    expect(screen.getByRole('button', { name: /alpha \[aaaa\].*w:1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /beta \[bbbb\].*w:1/ })).toBeTruthy();
    // No ASCII tree connectors any more.
    expect(view.textContent).not.toMatch(/[├└│]/);
  });

  it('indents rows by depth and marks the depth on the row wrapper', () => {
    render(<Harness onSelect={() => undefined} />);
    const rootRow = row(0, ROOT_ID);
    const alphaRow = row(1, 'aaaa-1');
    const betaRow = row(2, 'bbbb-1');
    expect(rootRow).not.toBeNull();
    expect(alphaRow).not.toBeNull();
    expect(betaRow).not.toBeNull();
    expect(alphaRow?.getAttribute('style')).toContain('padding-left: 18px');
    expect(betaRow?.getAttribute('style')).toContain('padding-left: 36px');
    expect(rootRow?.getAttribute('class')).toContain('tree__root-row');
  });

  it('draws one guide per depth level, with the elbow on the last one', () => {
    render(<Harness onSelect={() => undefined} />);
    const rootRow = row(0, ROOT_ID);
    const alphaRow = row(1, 'aaaa-1');
    const betaRow = row(2, 'bbbb-1');
    // The root is the tree's origin: it has no ancestor to connect to.
    expect(rootRow?.querySelector('.tree__guides')).toBeNull();
    const alphaGuides = alphaRow?.querySelector('.tree__guides');
    const alphaSpans = alphaGuides?.querySelectorAll(':scope > .tree__guide');
    expect(alphaSpans?.length).toBe(1);
    expect(alphaSpans?.[0].classList.contains('tree__guide--elbow')).toBe(true);
    const betaSpans = betaRow?.querySelectorAll('.tree__guides > .tree__guide');
    expect(betaSpans?.length).toBe(2);
    expect(betaSpans?.[0].classList.contains('tree__guide--elbow')).toBe(false);
    expect(betaSpans?.[1].classList.contains('tree__guide--elbow')).toBe(true);
    expect(alphaGuides?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the node id on both the row wrapper and the label button', () => {
    render(<Harness onSelect={() => undefined} />);
    const alphaButton = screen.getByRole('button', { name: /alpha \[aaaa\]/ });
    expect(alphaButton.getAttribute('data-node-id')).toBe('aaaa-1');
    expect(row(1, 'aaaa-1')?.getAttribute('data-node-id')).toBe('aaaa-1');
    expect(alphaButton.parentElement?.getAttribute('data-depth')).toBe('1');
  });

  it('sinks completed siblings below open ones and marks their status', () => {
    render(<Harness onSelect={() => undefined} />);
    const view = screen.getByTestId('tree-view');
    const order = [...view.querySelectorAll('[data-depth]')].map((el) => el.getAttribute('data-node-id'));
    expect(order).toEqual([ROOT_ID, 'cccc-1', 'aaaa-1', 'bbbb-1']);

    const alphaButton = screen.getByRole('button', { name: /alpha \[aaaa\]/ });
    const gammaButton = screen.getByRole('button', { name: /gamma \[cccc\]/ });
    expect(alphaButton.getAttribute('data-status')).toBe('completed');
    expect(gammaButton.getAttribute('data-status')).toBe('open');
    // Colour and glyph are not the only signals: the status is also a word.
    expect(alphaButton.querySelector('.visually-hidden')?.textContent).toBe('Completed');
    expect(alphaButton.querySelector('.node-status')).not.toBeNull();
    expect(gammaButton.querySelector('.visually-hidden')).toBeNull();
    expect(gammaButton.querySelector('.node-status')).toBeNull();
  });

  it('writes data-selected explicitly on the selected node and the root', () => {
    render(<Harness onSelect={() => undefined} selectedId="aaaa-1" />);
    expect(screen.getByRole('button', { name: /alpha \[aaaa\]/ }).getAttribute('data-selected')).toBe('true');
    expect(screen.getByRole('button', { name: /gamma \[cccc\]/ }).getAttribute('data-selected')).toBe('false');
    expect(screen.getByRole('button', { name: 'workroot' }).getAttribute('data-selected')).toBe('false');
  });

  it('marks the root as selected when it is the selected node', () => {
    render(<Harness onSelect={() => undefined} selectedId={ROOT_ID} />);
    expect(screen.getByRole('button', { name: 'workroot' }).getAttribute('data-selected')).toBe('true');
  });

  it('collapses children when the disclosure is clicked', () => {
    render(<Harness onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /beta \[bbbb\]/ })).toBeTruthy();
    const collapse = screen.getByRole('button', { name: 'collapse' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(screen.queryByRole('button', { name: /beta \[bbbb\]/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'expand' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'expand' }));
    expect(screen.getByRole('button', { name: /beta \[bbbb\]/ })).toBeTruthy();
  });

  it('keeps one chevron glyph in both states and marks the state on aria-expanded', () => {
    render(<Harness onSelect={() => undefined} />);
    const open = screen.getByRole('button', { name: 'collapse' });
    const openGlyph = open.querySelector('svg path')?.getAttribute('d');
    expect(openGlyph).not.toBeNull();
    fireEvent.click(open);
    const closed = screen.getByRole('button', { name: 'expand' });
    // Rotation is a CSS concern; the DOM keeps the same glyph.
    expect(closed.querySelector('svg path')?.getAttribute('d')).toBe(openGlyph);
    expect(closed.getAttribute('aria-expanded')).toBe('false');
  });

  it('calls onSelect when a node row is clicked', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /alpha \[aaaa\]/ }));
    expect(onSelect).toHaveBeenCalledWith('aaaa-1');
  });

  it('calls onSelect with ROOT_ID when the root line is clicked', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'workroot' }));
    expect(onSelect).toHaveBeenCalledWith(ROOT_ID);
  });

  it('selects once when the row wrapper itself is clicked', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const alphaRow = row(1, 'aaaa-1');
    const rootRow = row(0, ROOT_ID);
    if (alphaRow === null || rootRow === null) throw new Error('row wrapper not found');
    fireEvent.click(alphaRow);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('aaaa-1');
    fireEvent.click(rootRow);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith(ROOT_ID);
  });

  it('shows only matches plus their ancestor chain when a filter is active', () => {
    render(<Harness onSelect={() => undefined} filter={{ keyword: 'beta' }} filterActive />);
    expect(screen.getByRole('button', { name: /alpha \[aaaa\]/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /beta \[bbbb\]/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /gamma \[cccc\]/ })).toBeNull();
  });

  it('dims context ancestors and marks matching rows', () => {
    render(<Harness onSelect={() => undefined} filter={{ keyword: 'beta' }} filterActive />);
    const alphaButton = screen.getByRole('button', { name: /alpha \[aaaa\]/ });
    const betaButton = screen.getByRole('button', { name: /beta \[bbbb\]/ });
    expect(alphaButton.getAttribute('data-context')).toBe('true');
    expect(alphaButton.getAttribute('data-match')).toBe('false');
    expect(betaButton.getAttribute('data-context')).toBeNull();
    expect(betaButton.getAttribute('data-match')).toBe('true');
  });

  it('does not add the match dot to matched rows in hide mode', () => {
    render(<Harness onSelect={() => undefined} filter={{ keyword: 'beta' }} filterActive />);
    const betaButton = screen.getByRole('button', { name: /beta \[bbbb\]/ });
    expect(betaButton.querySelector('.node-match')).toBeNull();
    expect(betaButton.getAttribute('data-match')).toBe('true');
  });

  it('marks matched rows with a dot only in highlight mode', () => {
    render(
      <Harness onSelect={() => undefined} filter={{ keyword: 'beta' }} filterActive highlightMatches />,
    );
    const betaButton = screen.getByRole('button', { name: /beta \[bbbb\]/ });
    const alphaButton = screen.getByRole('button', { name: /alpha \[aaaa\]/ });
    expect(betaButton.getAttribute('data-match')).toBe('true');
    expect(betaButton.querySelector('.node-match')).not.toBeNull();
    expect(alphaButton.getAttribute('data-match')).toBe('false');
    expect(alphaButton.querySelector('.node-match')).toBeNull();
  });

  it('shows the filtered-empty message when nothing matches', () => {
    render(<Harness onSelect={() => undefined} filter={{ keyword: 'zzz' }} filterActive />);
    expect(screen.getByText('No nodes match the filter.')).toBeTruthy();
  });

  it('renders conflict rows read-only with diff markers and working disclosure', () => {
    render(
      <I18nProvider lang="en">
        <TreeView
          root={filterTree(tree, {})}
          expanded={new Set(['aaaa-1'])}
          selectedId={null}
          display={display}
          onToggle={() => undefined}
          onSelect={() => undefined}
          readOnly
          highlight={new Map<string, DiffStyle>([['aaaa-1', 'changed']])}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole('button', { name: /alpha \[aaaa\]/ })).toBeNull();
    expect(row(1, 'aaaa-1')?.querySelector('[data-diff="changed"]')).not.toBeNull();
    expect(row(2, 'bbbb-1')?.querySelector('[data-diff]')).toBeNull();
    expect(screen.getByRole('button', { name: 'collapse' })).toBeTruthy();
  });
});
