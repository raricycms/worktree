import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Tree } from '@worktree/core';
import { ROOT_ID } from '@worktree/core';
import type { Node } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { I18nProvider } from '../src/i18n';
import { LOCAL_USER } from '../src/config';
import type { AppConfig } from '../src/config';
import { SettingsPage } from '../src/pages/SettingsPage';

const tree: Node = Tree.fromOps([{ kind: 'add', parentId: ROOT_ID, id: 'a', name: 'A', weight: 1 }]).getRoot();

function makeConfig(calendarDays: number): AppConfig {
  return {
    serverUrl: 'http://localhost:1',
    user: LOCAL_USER,
    display: { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' },
    filter: {},
    lang: 'en',
    calendarDays,
    autoReminder: { enabled: true, pct: 15 },
    quickAddPath: '/tmp',
    theme: 'system',
    ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', semester: null },
  };
}

function renderSettings(calendarDays: number, updateConfig = vi.fn()) {
  const client = { getPendingCount: () => 0 } as unknown as WorktreeClient;
  render(
    <I18nProvider lang="en">
      <SettingsPage
        config={makeConfig(calendarDays)}
        client={client}
        tree={tree}
        updateConfig={updateConfig}
        onClearCache={vi.fn()}
        onLogout={vi.fn()}
        onLoginOther={vi.fn()}
      />
    </I18nProvider>,
  );
  return { updateConfig };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsPage calendar', () => {
  it('shows the configured day count on the closed expander', () => {
    renderSettings(5);
    const toggle = screen.getByTestId('settings-calendar-days');
    expect(toggle.textContent).toBe('5');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('updates the day count', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.click(screen.getByTestId('settings-calendar-days'));
    fireEvent.click(screen.getByTestId('settings-calendar-days-option-6'));
    expect(updateConfig).toHaveBeenCalledWith({ calendarDays: 6 });
  });
});

describe('SettingsPage quick capture path', () => {
  it('applies a valid path', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-quick-path-input'), { target: { value: '/inbox' } });
    fireEvent.click(screen.getByTestId('settings-apply-quick-path'));
    expect(updateConfig).toHaveBeenCalledWith({ quickAddPath: '/inbox' });
  });

  it('rejects a path without a leading slash and keeps the old one', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-quick-path-input'), { target: { value: 'inbox' } });
    fireEvent.click(screen.getByTestId('settings-apply-quick-path'));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid path/)).toBeTruthy();
  });
});

describe('SettingsPage language', () => {
  it('offers every catalogue, labelled in its own language', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.click(screen.getByTestId('settings-language'));
    const list = within(screen.getByRole('listbox', { name: 'Language' }));
    expect(list.getAllByRole('option').map((option) => [option.textContent, option.getAttribute('data-testid')])).toEqual([
      ['English', 'settings-language-option-en'],
      ['中文', 'settings-language-option-zh'],
    ]);
    fireEvent.click(screen.getByTestId('settings-language-option-zh'));
    expect(updateConfig).toHaveBeenCalledWith({ lang: 'zh' });
  });
});

describe('SettingsPage display', () => {
  it('shows the filter mode as a two-item slider and applies a new one', () => {
    const { updateConfig } = renderSettings(7);
    const slider = screen.getByRole('group', { name: 'Filter display mode' });
    expect(slider.getAttribute('data-count')).toBe('2');
    expect(slider.getAttribute('data-active')).toBe('0');
    expect(screen.getByTestId('settings-filter-mode-hide').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('settings-filter-mode-highlight').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('settings-filter-mode-highlight'));
    expect(updateConfig).toHaveBeenCalledWith({
      display: { showId: true, showWeight: true, showReminders: true, filterMode: 'highlight' },
    });
  });
});

describe('SettingsPage theme', () => {
  it('marks the configured theme as pressed', () => {
    renderSettings(7);
    const slider = screen.getByRole('group', { name: 'Theme' });
    expect(slider.getAttribute('data-count')).toBe('3');
    expect(slider.getAttribute('data-active')).toBe('0');
    expect(screen.getByTestId('settings-theme-system').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('settings-theme-light').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('settings-theme-dark').getAttribute('aria-pressed')).toBe('false');
  });

  it('updates the theme preference', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.click(screen.getByTestId('settings-theme-dark'));
    expect(updateConfig).toHaveBeenCalledWith({ theme: 'dark' });
  });
});

describe('SettingsPage auto reminder', () => {
  it('toggles the auto-reminder', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.click(screen.getByTestId('settings-auto-reminder-enabled'));
    expect(updateConfig).toHaveBeenCalledWith({ autoReminder: { enabled: false, pct: 15 } });
  });

  it('updates the percentage, clamping out-of-range values', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-auto-reminder-pct'), { target: { value: '30' } });
    expect(updateConfig).toHaveBeenCalledWith({ autoReminder: { enabled: true, pct: 30 } });
    fireEvent.change(screen.getByTestId('settings-auto-reminder-pct'), { target: { value: '150' } });
    expect(updateConfig).toHaveBeenCalledWith({ autoReminder: { enabled: true, pct: 99 } });
    fireEvent.change(screen.getByTestId('settings-auto-reminder-pct'), { target: { value: '0' } });
    expect(updateConfig).toHaveBeenCalledWith({ autoReminder: { enabled: true, pct: 1 } });
  });
});

describe('SettingsPage AI assistant', () => {
  it('saves the base URL, model and key', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-ai-base-url'), {
      target: { value: 'https://api.deepseek.com/v1/' },
    });
    fireEvent.change(screen.getByTestId('settings-ai-model'), { target: { value: 'deepseek-chat' } });
    fireEvent.change(screen.getByTestId('settings-ai-key'), { target: { value: 'sk-local' } });
    fireEvent.click(screen.getByTestId('settings-ai-apply'));
    expect(updateConfig).toHaveBeenCalledWith({
      ai: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-local',
        semester: null,
      },
    });
  });

  it('rejects a base URL that is not http(s)', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-ai-base-url'), { target: { value: 'api.deepseek.com' } });
    fireEvent.click(screen.getByTestId('settings-ai-apply'));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-ai-error').textContent).toContain('valid http://');
  });

  it('rejects an empty model name', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-ai-model'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('settings-ai-apply'));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-ai-error').textContent).toContain('Enter a model name');
  });
});

describe('SettingsPage semester', () => {
  it('saves a Monday anchor and the teaching week count', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-semester-first-monday'), {
      target: { value: '2026-10-19' },
    });
    fireEvent.change(screen.getByTestId('settings-semester-weeks'), { target: { value: '16' } });
    fireEvent.click(screen.getByTestId('settings-semester-save'));
    expect(updateConfig).toHaveBeenCalledWith({
      ai: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: '',
        semester: { firstMonday: { year: 2026, month: 10, day: 19 }, totalWeeks: 16 },
      },
    });
  });

  it('rejects a non-Monday anchor', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-semester-first-monday'), {
      target: { value: '2026-10-20' },
    });
    fireEvent.click(screen.getByTestId('settings-semester-save'));
    expect(updateConfig).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-semester-error').textContent).toContain('must be a Monday');
  });
});
