import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { NodeFilter } from '@worktree/core';
import { I18nProvider } from '../src/i18n';
import { FilterBar } from '../src/components/FilterBar';
import type { FilterDisplayMode } from '../src/config';

function Harness({
  onFilterChange,
  onModeChange,
}: {
  onFilterChange?: (f: NodeFilter) => void;
  onModeChange?: (m: string) => void;
}) {
  const [filter, setFilter] = useState<NodeFilter>({});
  const [mode, setMode] = useState<FilterDisplayMode>('hide');
  return (
    <I18nProvider lang="en">
      <FilterBar
        filter={filter}
        mode={mode}
        onFilterChange={(f) => {
          setFilter(f);
          onFilterChange?.(f);
        }}
        onModeChange={(m) => {
          setMode(m);
          onModeChange?.(m);
        }}
      />
    </I18nProvider>
  );
}

const openPanel = (): void => {
  fireEvent.click(screen.getByTestId('filter-toggle'));
};

describe('FilterBar', () => {
  it('keeps the panel mounted and toggles it in the page flow', () => {
    render(<Harness />);
    const toggle = screen.getByTestId('filter-toggle');
    const panel = screen.getByTestId('filter-panel');
    // The panel stays in the DOM so it can animate; closed means hidden and inert.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.classList.contains('is-open')).toBe(false);
    expect(screen.getByTestId('filter-keyword')).toBeTruthy();
    openPanel();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.classList.contains('is-open')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.classList.contains('is-open')).toBe(false);
  });

  it('labels every control for assistive technology', () => {
    render(<Harness />);
    openPanel();
    expect(screen.getByLabelText('Keyword')).toBe(screen.getByTestId('filter-keyword'));
    expect(screen.getByLabelText('Status')).toBe(screen.getByTestId('filter-status'));
    expect(screen.getByLabelText('Overdue')).toBe(screen.getByTestId('filter-overdue'));
    expect(screen.getByLabelText('Deadline before')).toBe(screen.getByTestId('filter-deadline-before'));
    expect(screen.getByLabelText('Created after')).toBe(screen.getByTestId('filter-created-after'));
    expect(screen.getByLabelText('Created before')).toBe(screen.getByTestId('filter-created-before'));
    expect(screen.getByLabelText('Display mode')).toBe(screen.getByTestId('filter-mode'));
    // The sliders are groups with one pressed item per choice.
    expect(screen.getByTestId('filter-status').getAttribute('role')).toBe('group');
    expect(screen.getByTestId('filter-status').querySelectorAll('.segmented__item').length).toBe(3);
    expect(screen.getByTestId('filter-mode').querySelectorAll('.segmented__item').length).toBe(2);
  });

  it('emits the keyword on input and undefined when cleared', () => {
    const onFilterChange = vi.fn();
    render(<Harness onFilterChange={onFilterChange} />);
    openPanel();
    fireEvent.change(screen.getByTestId('filter-keyword'), { target: { value: 'milk' } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ keyword: 'milk' });
    fireEvent.change(screen.getByTestId('filter-keyword'), { target: { value: '' } });
    expect(onFilterChange).toHaveBeenLastCalledWith({ keyword: undefined });
  });

  it('emits the overdue flag from the checkbox', () => {
    const onFilterChange = vi.fn();
    render(<Harness onFilterChange={onFilterChange} />);
    openPanel();
    fireEvent.click(screen.getByTestId('filter-overdue'));
    expect(onFilterChange).toHaveBeenLastCalledWith({ overdue: true });
  });

  it('emits the completion status from the slider and marks the pressed choice', () => {
    const onFilterChange = vi.fn();
    render(<Harness onFilterChange={onFilterChange} />);
    openPanel();
    fireEvent.click(screen.getByTestId('filter-status-2'));
    expect(onFilterChange).toHaveBeenLastCalledWith({ status: true });
    expect(screen.getByTestId('filter-status-2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('filter-status-0').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('filter-status-1'));
    expect(onFilterChange).toHaveBeenLastCalledWith({ status: false });
    fireEvent.click(screen.getByTestId('filter-status-0'));
    expect(onFilterChange).toHaveBeenLastCalledWith({ status: undefined });
  });

  it('emits datetime bounds converted to epoch ms', () => {
    const onFilterChange = vi.fn();
    render(<Harness onFilterChange={onFilterChange} />);
    openPanel();
    fireEvent.change(screen.getByTestId('filter-deadline-before'), {
      target: { value: '2026-09-01T10:00' },
    });
    expect(onFilterChange).toHaveBeenLastCalledWith({
      deadlineBefore: new Date('2026-09-01T10:00').getTime(),
    });
  });

  it('emits the display mode from the slider', () => {
    const onModeChange = vi.fn();
    render(<Harness onModeChange={onModeChange} />);
    openPanel();
    expect(screen.getByTestId('filter-mode-0').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('filter-mode-1'));
    expect(onModeChange).toHaveBeenCalledWith('highlight');
    expect(screen.getByTestId('filter-mode-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('filter-mode-0'));
    expect(onModeChange).toHaveBeenLastCalledWith('hide');
  });

  it('signals an active filter with a count, not colour alone', () => {
    render(<Harness />);
    expect(screen.getByTestId('filter-toggle').getAttribute('data-active')).toBe('false');
    openPanel();
    fireEvent.change(screen.getByTestId('filter-keyword'), { target: { value: 'milk' } });
    const toggle = screen.getByTestId('filter-toggle');
    expect(toggle.getAttribute('data-active')).toBe('true');
    expect(toggle.textContent).toContain('1');
  });

  it('clears the filter and closes the active state', () => {
    const onFilterChange = vi.fn();
    render(<Harness onFilterChange={onFilterChange} />);
    openPanel();
    fireEvent.change(screen.getByTestId('filter-keyword'), { target: { value: 'milk' } });
    fireEvent.click(screen.getByTestId('filter-clear'));
    expect(onFilterChange).toHaveBeenLastCalledWith({});
    expect(screen.getByTestId('filter-toggle').getAttribute('data-active')).toBe('false');
    expect(screen.queryByTestId('filter-clear')).toBeNull();
  });
});
