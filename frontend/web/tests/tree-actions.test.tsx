import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ROOT_ID, Tree, filterTree } from '@worktree/core';
import type { Node, TreeOperation } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { I18nProvider } from '../src/i18n';
import { FilterProvider } from '../src/filter-context';
import { TreeView } from '../src/components/TreeView';
import { TodaySection } from '../src/components/TodaySection';
import { TreePage } from '../src/pages/TreePage';
import type { DisplayPrefs } from '../src/config';

const display: DisplayPrefs = { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' };

const openTree: Node = Tree.fromOps([
  { kind: 'add', parentId: ROOT_ID, id: 'aaaa-1', name: 'alpha', weight: 1 },
  { kind: 'add', parentId: 'aaaa-1', id: 'bbbb-1', name: 'beta', weight: 1 },
  { kind: 'add', parentId: ROOT_ID, id: 'cccc-1', name: 'gamma', weight: 2 },
]).getRoot();

const completedTree: Node = Tree.fromOps([
  { kind: 'add', parentId: ROOT_ID, id: 'aaaa-1', name: 'alpha', weight: 1 },
  { kind: 'add', parentId: 'aaaa-1', id: 'bbbb-1', name: 'beta', weight: 1 },
  { kind: 'complete', id: 'bbbb-1' },
  { kind: 'complete', id: 'aaaa-1' },
]).getRoot();

function row(depth: number, id: string): HTMLElement {
  const found = document.querySelector(`[data-node-id="${id}"][data-depth="${depth}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`row not found: ${id} at depth ${depth}`);
  return found;
}

function Harness(props: {
  onSelect?: (id: string) => void;
  onToggleComplete?: (id: string) => void;
  onAddChild?: (parentId: string, name: string) => void;
  sourceTree?: Node;
  readOnly?: boolean;
  expandedIds?: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(props.expandedIds ?? ['aaaa-1']));
  return (
    <I18nProvider lang="en">
      <TreeView
        root={filterTree(props.sourceTree ?? openTree, {})}
        expanded={expanded}
        selectedId={null}
        display={display}
        onToggle={(id) =>
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onSelect={props.onSelect ?? (() => undefined)}
        readOnly={props.readOnly}
        onToggleComplete={props.onToggleComplete}
        onAddChild={props.onAddChild}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tree row completion', () => {
  it('puts a completion checkbox first in every non-root row and keeps the row contract', () => {
    render(<Harness onToggleComplete={() => undefined} />);
    const alphaRow = row(1, 'aaaa-1');
    const checkbox = within(alphaRow).getByRole('checkbox', { name: 'Mark complete' });
    const disclosure = alphaRow.querySelector('.tree__disclosure');
    if (disclosure === null) throw new Error('alpha disclosure not rendered');
    // First control: the checkbox precedes the disclosure in document order.
    expect(checkbox.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checkbox.getAttribute('data-testid')).toBe('node-complete-aaaa-1');

    // The stable tree-row test contract still lives on the row and label button.
    expect(alphaRow.getAttribute('data-node-id')).toBe('aaaa-1');
    expect(alphaRow.getAttribute('data-depth')).toBe('1');
    const label = screen.getByRole('button', { name: /alpha \[aaaa\]/ });
    expect(label.getAttribute('data-status')).toBe('open');
    expect(label.getAttribute('data-selected')).toBe('false');
    expect(label.getAttribute('data-match')).toBe('false');
  });

  it('gives the root row no checkbox', () => {
    render(<Harness onToggleComplete={() => undefined} />);
    expect(row(0, ROOT_ID).querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('shows the completed state on the checkbox of a completed row', () => {
    render(<Harness sourceTree={completedTree} onToggleComplete={() => undefined} />);
    const beta = within(row(2, 'bbbb-1')).getByRole('checkbox', { name: 'Mark incomplete' });
    expect(beta).toBeChecked();
    expect(within(row(1, 'aaaa-1')).getByRole('checkbox', { name: 'Mark incomplete' })).toBeChecked();
  });

  it('toggles completion without selecting the row', () => {
    const onSelect = vi.fn();
    const onToggleComplete = vi.fn();
    render(<Harness onSelect={onSelect} onToggleComplete={onToggleComplete} />);
    fireEvent.click(screen.getByTestId('node-complete-aaaa-1'));
    expect(onToggleComplete).toHaveBeenCalledWith('aaaa-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides completion checkboxes and add controls in a read-only tree', () => {
    render(
      <Harness readOnly onToggleComplete={() => undefined} onAddChild={() => undefined} />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByTestId(/^node-add-/)).toHaveLength(0);
  });
});

describe('inline child add', () => {
  it('adds from the root and keeps the field open, empty and focused', () => {
    const onAddChild = vi.fn();
    render(<Harness onAddChild={onAddChild} />);
    fireEvent.click(screen.getByTestId(`node-add-${ROOT_ID}`));
    const input = screen.getByTestId(`node-add-input-${ROOT_ID}`);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'delta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAddChild).toHaveBeenCalledWith(ROOT_ID, 'delta');

    const keepGoing = screen.getByTestId(`node-add-input-${ROOT_ID}`);
    if (!(keepGoing instanceof HTMLInputElement)) throw new Error('add input is not an input');
    expect(keepGoing.value).toBe('');
    expect(document.activeElement).toBe(keepGoing);

    fireEvent.change(keepGoing, { target: { value: 'epsilon' } });
    fireEvent.keyDown(keepGoing, { key: 'Enter' });
    expect(onAddChild).toHaveBeenCalledTimes(2);
    expect(onAddChild).toHaveBeenLastCalledWith(ROOT_ID, 'epsilon');
  });

  it('adds a child of a tree row, not of the root', () => {
    const onAddChild = vi.fn();
    render(<Harness onAddChild={onAddChild} />);
    fireEvent.click(screen.getByTestId('node-add-aaaa-1'));
    const input = screen.getByTestId('node-add-input-aaaa-1');
    fireEvent.change(input, { target: { value: 'child-of-alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAddChild).toHaveBeenCalledWith('aaaa-1', 'child-of-alpha');
  });

  it('reports a rejected add in place and keeps the field open with its text', () => {
    const onAddChild = vi.fn(() => {
      throw new Error('sibling name already exists');
    });
    render(<Harness onAddChild={onAddChild} />);
    fireEvent.click(screen.getByTestId(`node-add-${ROOT_ID}`));
    const input = screen.getByTestId(`node-add-input-${ROOT_ID}`);
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Could not add: sibling name already exists');
    const kept = screen.getByTestId(`node-add-input-${ROOT_ID}`);
    if (!(kept instanceof HTMLInputElement)) throw new Error('add input is not an input');
    expect(kept.value).toBe('alpha');
  });

  it('closes the field with Escape and with the close button', () => {
    render(<Harness onAddChild={() => undefined} />);
    fireEvent.click(screen.getByTestId(`node-add-${ROOT_ID}`));
    fireEvent.keyDown(screen.getByTestId(`node-add-input-${ROOT_ID}`), { key: 'Escape' });
    expect(screen.queryByTestId(`node-add-input-${ROOT_ID}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`node-add-${ROOT_ID}`));
    fireEvent.click(screen.getByTestId(`node-add-close-${ROOT_ID}`));
    expect(screen.queryByTestId(`node-add-input-${ROOT_ID}`)).toBeNull();
  });

  it('does not submit while an IME composition is active', () => {
    const onAddChild = vi.fn();
    render(<Harness onAddChild={onAddChild} />);
    fireEvent.click(screen.getByTestId(`node-add-${ROOT_ID}`));
    const input = screen.getByTestId(`node-add-input-${ROOT_ID}`);
    fireEvent.change(input, { target: { value: '日本' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAddChild).not.toHaveBeenCalled();
  });
});

describe('TreePage completion cascade', () => {
  const cascadeTree: Node = Tree.fromOps([
    { kind: 'add', parentId: ROOT_ID, id: 'pppp-1', name: 'parent', weight: 1 },
    { kind: 'add', parentId: 'pppp-1', id: 'cccc-1', name: 'child', weight: 1 },
  ]).getRoot();

  function renderPage(sourceTree: Node, client: WorktreeClient) {
    render(
      <I18nProvider lang="en">
        <FilterProvider filter={{}} mode="hide" setFilter={() => undefined} setMode={() => undefined}>
          <TreePage tree={sourceTree} client={client} display={display} updateConfig={() => undefined} />
        </FilterProvider>
      </I18nProvider>,
    );
  }

  function cascadeClient(sourceTree: Node) {
    const setCompleted = vi.fn();
    const addNode = vi.fn();
    const client = { getTree: () => sourceTree, setCompleted, addNode } as unknown as WorktreeClient;
    return { client, setCompleted };
  }

  it('completes descendants first behind one confirm', () => {
    const { client, setCompleted } = cascadeClient(cascadeTree);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage(cascadeTree, client);
    fireEvent.click(screen.getByTestId('node-complete-pppp-1'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('parent');
    expect(confirmSpy.mock.calls[0][0]).toContain('1 uncompleted child node(s)');
    expect(setCompleted.mock.calls).toEqual([
      ['cccc-1', true],
      ['pppp-1', true],
    ]);
  });

  it('completes nothing when the cascade confirm is canceled', () => {
    const { client, setCompleted } = cascadeClient(cascadeTree);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage(cascadeTree, client);
    fireEvent.click(screen.getByTestId('node-complete-pppp-1'));
    expect(setCompleted).not.toHaveBeenCalled();
  });

  it('uncompletes a completed row without a confirm', () => {
    const completed: Node = Tree.fromOps([
      { kind: 'add', parentId: ROOT_ID, id: 'dddd-1', name: 'done', weight: 1 },
      { kind: 'complete', id: 'dddd-1' },
    ]).getRoot();
    const { client, setCompleted } = cascadeClient(completed);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage(completed, client);
    fireEvent.click(screen.getByTestId('node-complete-dddd-1'));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(setCompleted).toHaveBeenCalledWith('dddd-1', false);
  });
});

describe('TreePage inline add reveal', () => {
  /** A client whose addNode really appends, so a re-render shows the new node. */
  function growingClient() {
    let seq = 0;
    const ops: TreeOperation[] = [
      { kind: 'add', parentId: ROOT_ID, id: 'leaf-1', name: 'leaf', weight: 1 },
    ];
    const addNode = vi.fn((parentId: string, name: string): string => {
      seq += 1;
      const id = `fresh-${seq}`;
      ops.push({ kind: 'add', parentId, id, name, weight: 10 + seq });
      return id;
    });
    const client = {
      getTree: () => Tree.fromOps(ops).getRoot(),
      addNode,
      setCompleted: vi.fn(),
    } as unknown as WorktreeClient;
    return { client, addNode, tree: () => Tree.fromOps(ops).getRoot() };
  }

  function pageElement(tree: Node, client: WorktreeClient) {
    return (
      <I18nProvider lang="en">
        <FilterProvider filter={{}} mode="hide" setFilter={() => undefined} setMode={() => undefined}>
          <TreePage tree={tree} client={client} display={display} updateConfig={() => undefined} />
        </FilterProvider>
      </I18nProvider>
    );
  }

  it('expands a collapsed leaf parent so the new child row is visible', () => {
    const { client, addNode, tree } = growingClient();
    const { rerender } = render(pageElement(tree(), client));
    expect(screen.queryByText(/new-task/)).toBeNull();

    fireEvent.click(screen.getByTestId('node-add-leaf-1'));
    const input = screen.getByTestId('node-add-input-leaf-1');
    fireEvent.change(input, { target: { value: 'new-task' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addNode).toHaveBeenCalledWith('leaf-1', 'new-task');

    // The page renders the tree its owner passes down, so the new node arrives
    // with the next render. It must be visible then without another click: a
    // leaf has no disclosure the user could have opened beforehand.
    rerender(pageElement(tree(), client));
    const added = screen.getByRole('button', { name: /new-task/ });
    expect(added.getAttribute('data-status')).toBe('open');
    expect(added.closest('[data-depth="2"]')).not.toBeNull();

    // ... and the field is still open, empty and focused for the next sibling.
    const field = screen.getByTestId('node-add-input-leaf-1');
    if (!(field instanceof HTMLInputElement)) throw new Error('add input is not an input');
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
  });
});

describe('TodaySection', () => {
  const NOW = new Date(2026, 9, 23, 14, 0, 0).getTime();
  const todayAt = (hour: number): number => new Date(2026, 9, 23, hour).getTime();
  const yesterdayAt = (hour: number): number => new Date(2026, 9, 22, hour).getTime();

  function dueTree(ops: TreeOperation[]): Node {
    return Tree.fromOps(ops).getRoot();
  }

  const todayTree = dueTree([
    { kind: 'add', parentId: ROOT_ID, id: 'later', name: 'later', weight: 1, deadline: todayAt(18) },
    { kind: 'add', parentId: ROOT_ID, id: 'overdue', name: 'overdue', weight: 2, deadline: yesterdayAt(10) },
    { kind: 'add', parentId: ROOT_ID, id: 'done', name: 'done', weight: 3, deadline: todayAt(10) },
    { kind: 'complete', id: 'done' },
  ]);

  it('lists due nodes earliest first with relative time and an overdue marker', () => {
    render(
      <I18nProvider lang="en">
        <TodaySection tree={todayTree} onSelect={() => undefined} nowMs={NOW} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('today-count').textContent).toBe('2 open');
    const rows = screen.getAllByTestId(/^today-row-/).map((element) => element.getAttribute('data-testid'));
    expect(rows).toEqual(['today-row-overdue', 'today-row-later']);
    expect(screen.getByTestId('today-time-overdue').textContent).toBe('overdue 1d');
    expect(screen.getByTestId('today-time-later').textContent).toBe('due in 4h');
    expect(screen.getByTestId('today-row-overdue').textContent).toContain('Overdue');
    expect(screen.getByTestId('today-row-later').textContent).not.toContain('Overdue');
  });

  it('selects and completes through the same handlers as the tree', () => {
    const onSelect = vi.fn();
    const onToggleComplete = vi.fn();
    render(
      <I18nProvider lang="en">
        <TodaySection
          tree={todayTree}
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
          nowMs={NOW}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('today-label-later'));
    expect(onSelect).toHaveBeenCalledWith('later');
    fireEvent.click(screen.getByTestId('today-complete-later'));
    expect(onToggleComplete).toHaveBeenCalledWith('later');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('collapses in component state and shows the empty copy', () => {
    const { rerender } = render(
      <I18nProvider lang="en">
        <TodaySection tree={dueTree([])} onSelect={() => undefined} nowMs={NOW} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('today-count').textContent).toBe('0 open');
    expect(screen.getByText('Nothing is due today.')).toBeTruthy();

    const toggle = screen.getByTestId('today-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panelId = toggle.getAttribute('aria-controls');
    if (panelId === null) throw new Error('today toggle has no panel id');
    const panel = document.getElementById(panelId);
    if (panel === null) throw new Error('today panel not found');
    expect(panel.hasAttribute('inert')).toBe(true);

    // The collapsed state survives an unrelated re-render (component state only).
    rerender(
      <I18nProvider lang="en">
        <TodaySection tree={dueTree([])} onSelect={() => undefined} nowMs={NOW} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('today-toggle').getAttribute('aria-expanded')).toBe('false');
  });
});
