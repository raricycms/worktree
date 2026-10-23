import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ROOT_ID } from '@worktree/core';
import App from '../src/App';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

const localConfig = () => ({
  serverUrl: 'http://localhost:3000',
  user: 'local',
  display: { showId: false, showWeight: false, showReminders: true, filterMode: 'hide' },
  lang: 'en',
  onboarded: true,
});

describe('first-run identity choice', () => {
  it('shows the identity choice instead of an empty offline tree on a fresh browser', () => {
    render(<App />);
    expect(screen.getByTestId('first-run-account')).toBeDefined();
    expect(screen.getByTestId('first-run-login')).toBeDefined();
    expect(screen.getByTestId('first-run-offline')).toBeDefined();
    expect(screen.queryByTestId('tree-view')).toBeNull();
  });

  it('continuing offline dismisses the choice and opens the tree', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('first-run-offline'));
    expect(screen.queryByTestId('first-run-account')).toBeNull();
    expect(screen.getByTestId('tree-view')).toBeDefined();
    expect(JSON.parse(localStorage.getItem('worktree.config')!).onboarded).toBe(true);
  });

  it('the account button opens registration with an empty username', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('first-run-account'));
    expect(screen.getByTestId('auth-submit')).toBeDefined();
    expect(screen.getByTestId('auth-mode-register').getAttribute('aria-pressed')).toBe('true');
    // "local" is reserved and must never be prefilled as a server account
    expect(screen.getByTestId('auth-username').getAttribute('value')).toBe('');
  });

  it('the login button opens login mode', () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('first-run-login'));
    expect(screen.getByTestId('auth-mode-login').getAttribute('aria-pressed')).toBe('true');
  });

  it('a local workspace with data keeps an entry point to accounts and backups', () => {
    localStorage.setItem('worktree.config', JSON.stringify(localConfig()));
    localStorage.setItem(
      'worktree.state.local',
      JSON.stringify({
        confirmed: [
          { id: 'entry-1', op: { kind: 'add', parentId: ROOT_ID, id: 'n1', name: 'Task', weight: 1 } },
        ],
        pending: [],
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('save-work'));
    // Settings is where the account and data (export/import) cards live.
    expect(screen.getByTestId('settings-clear-cache')).toBeDefined();
  });
});
