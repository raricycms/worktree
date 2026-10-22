import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from '../src/App';

beforeEach(() => {
  localStorage.clear();
});

describe('App language', () => {
  it('switches the whole shell to the language chosen in Settings', () => {
    localStorage.setItem(
      'worktree.config',
      JSON.stringify({
        serverUrl: 'http://localhost:3000',
        user: 'local',
        display: { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' },
        lang: 'en',
      }),
    );
    render(<App />);
    // The page title and the nav item both say "Tree": they are different roles.
    expect(screen.getByRole('heading', { name: 'Tree' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Tree' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('settings-language')).toBeDefined();
    fireEvent.click(screen.getByTestId('settings-language'));
    fireEvent.click(screen.getByTestId('settings-language-option-zh'));

    expect(screen.getByRole('heading', { name: '设置' })).toBeDefined();
    expect(screen.getByRole('button', { name: '节点树' })).toBeDefined();
    expect(screen.getByRole('button', { name: '日历' })).toBeDefined();
    expect(screen.getByRole('heading', { name: '语言' })).toBeDefined();
    expect(document.documentElement.lang).toBe('zh');
    expect(JSON.parse(localStorage.getItem('worktree.config')!).lang).toBe('zh');
  });
});
