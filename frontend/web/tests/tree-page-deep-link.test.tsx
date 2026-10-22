import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Tree } from '@worktree/core';
import { ROOT_ID } from '@worktree/core';
import type { Node } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { I18nProvider } from '../src/i18n';
import { FilterProvider } from '../src/filter-context';
import { TreePage } from '../src/pages/TreePage';

const DEFAULT_DISPLAY = { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' as const };

const COMPACT_QUERY = '(max-width: 991px)';

/** jsdom has no matchMedia: supply the minimal surface useMediaQuery reads. */
function stubCompactViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === COMPACT_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function makeTree(): Node {
  return Tree.fromOps([
    { kind: 'add', parentId: ROOT_ID, id: 'a', name: 'a', weight: 1 },
    { kind: 'add', parentId: 'a', id: 'a-b', name: 'a-b', weight: 1 },
    { kind: 'add', parentId: ROOT_ID, id: 'c', name: 'c', weight: 2 },
  ]).getRoot();
}

function makeClient(): WorktreeClient {
  return { getTree: () => Tree.fromOps([]).getRoot() } as unknown as WorktreeClient;
}

function renderPage(props: {
  initialNodeId?: string;
  focusNode?: { id: string; nonce: number } | null;
}) {
  const client = makeClient();
  return render(
    <I18nProvider lang="en">
      <FilterProvider filter={{}} mode="hide" setFilter={() => undefined} setMode={() => undefined}>
        <TreePage
          tree={makeTree()}
          client={client}
          display={DEFAULT_DISPLAY}
          updateConfig={vi.fn()}
          initialNodeId={props.initialNodeId}
          focusNode={props.focusNode}
        />
      </FilterProvider>
    </I18nProvider>,
  );
}

function treePageElement(props: { focusNode?: { id: string; nonce: number } | null }) {
  return (
    <I18nProvider lang="en">
      <FilterProvider filter={{}} mode="hide" setFilter={() => undefined} setMode={() => undefined}>
        <TreePage
          tree={makeTree()}
          client={makeClient()}
          display={DEFAULT_DISPLAY}
          updateConfig={vi.fn()}
          focusNode={props.focusNode ?? null}
        />
      </FilterProvider>
    </I18nProvider>
  );
}

describe('TreePage deep link', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the page frame with the tree title and the workbench side column', () => {
    renderPage({});
    expect(screen.getByRole('heading', { name: 'Tree' })).toBeTruthy();
    expect(screen.getByTestId('tree-side')).toBeTruthy();
    expect(screen.getByText('Select a node to see its details.')).toBeTruthy();
  });

  it('places the filter panel in the page flow, above the tree card', () => {
    renderPage({});
    const filters = screen.getByTestId('filter-bar');
    const treeView = screen.getByTestId('tree-view');
    expect(filters.closest('.tree-panel')?.contains(treeView)).toBe(true);
    expect(filters.contains(treeView)).toBe(false);
    expect(filters.parentElement?.nextElementSibling).toBeNull();
    expect(filters.nextElementSibling?.contains(treeView)).toBe(true);
    const panel = screen.getByTestId('filter-panel');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
  });

  it('selects the node given by initialNodeId and expands its ancestors', () => {
    renderPage({ initialNodeId: 'a-b' });
    // The detail panel shows the deep-linked node's name.
    expect(screen.getByDisplayValue('a-b')).toBeTruthy();
    // Ancestors are expanded so the node row is visible in the tree.
    expect(screen.getByRole('button', { name: /a \[a\]/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /a-b \[a-b\]/ })).toBeTruthy();
    const selected = screen.getByRole('button', { name: /a-b \[a-b\]/ });
    expect(selected.getAttribute('data-selected')).toBe('true');
  });

  it('selects the root when initialNodeId is the root', () => {
    renderPage({ initialNodeId: ROOT_ID });
    expect(screen.getByText('Workspace root')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'workroot' }).getAttribute('data-selected')).toBe('true');
  });

  it('does not select anything when the node is unknown', () => {
    renderPage({ initialNodeId: 'missing' });
    expect(screen.getByText('Select a node to see its details.')).toBeTruthy();
  });

  it('clears the selection when blank page space is clicked', () => {
    renderPage({ initialNodeId: 'a' });
    expect(screen.getByDisplayValue('a')).toBeTruthy();
    fireEvent.click(screen.getByRole('heading', { name: 'Tree' }));
    expect(screen.queryByDisplayValue('a')).toBeNull();
    expect(screen.getByText('Select a node to see its details.')).toBeTruthy();
  });

  it('shows the selected detail in a bottom sheet below 992px', () => {
    stubCompactViewport();
    renderPage({ initialNodeId: 'a' });
    expect(screen.queryByTestId('tree-side')).toBeNull();
    const sheet = screen.getByTestId('tree-sheet');
    expect(within(sheet).getByDisplayValue('a')).toBeTruthy();
  });

  it('re-focuses on focusNode changes with a fresh nonce', () => {
    const { rerender } = renderPage({});
    expect(screen.getByText('Select a node to see its details.')).toBeTruthy();

    rerender(treePageElement({ focusNode: { id: 'c', nonce: 1 } }));
    expect(screen.getByDisplayValue('c')).toBeTruthy();

    // A second focus on another node (fresh nonce) moves the selection.
    rerender(treePageElement({ focusNode: { id: 'a', nonce: 2 } }));
    expect(screen.getByDisplayValue('a')).toBeTruthy();
  });

  it('ignores a focusNode whose node does not exist', () => {
    const { rerender } = renderPage({ initialNodeId: 'a' });
    rerender(treePageElement({ focusNode: { id: 'nope', nonce: 3 } }));
    expect(screen.getByDisplayValue('a')).toBeTruthy();
  });
});
