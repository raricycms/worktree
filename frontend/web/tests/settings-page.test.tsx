import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tree } from '@worktree/core';
import { ROOT_ID, isRecord } from '@worktree/core';
import type { HistoryNode, Node, TokensResponse } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { I18nProvider } from '../src/i18n';
import { LOCAL_USER, clearToken, saveToken } from '../src/config';
import type { AppConfig } from '../src/config';
import { ToastProvider } from '../src/components/Toast';
import { SettingsPage } from '../src/pages/SettingsPage';

vi.mock('../src/data-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data-transfer')>();
  return { ...actual, downloadHistoryBackup: vi.fn() };
});

import { buildHistoryBackup, downloadHistoryBackup } from '../src/data-transfer';

const tree: Node = Tree.fromOps([{ kind: 'add', parentId: ROOT_ID, id: 'a', name: 'A', weight: 1 }]).getRoot();

const confirmed: HistoryNode[] = [
  { id: 'h1', op: { kind: 'add', parentId: ROOT_ID, id: 'a', name: 'A', weight: 1 } },
  { id: 'h2', op: { kind: 'add', parentId: ROOT_ID, id: 'b', name: 'B', weight: 2 } },
];

const SECURITY_SERVER = 'http://localhost:1';
const SECURITY_USER = 'alice';

const deviceTokens: TokensResponse['tokens'] = [
  { id: 1, label: 'Laptop', createdAt: '2026-10-01T09:00:00.000Z', lastUsedAt: '2026-10-04T09:00:00.000Z', current: true },
  { id: 2, label: null, createdAt: '2026-10-02T09:00:00.000Z', lastUsedAt: null, current: false },
];

function makeConfig(calendarDays: number): AppConfig {
  return {
    serverUrl: 'http://localhost:1',
    user: LOCAL_USER,
    onboarded: true,
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

interface FakeClientOptions {
  confirmed?: HistoryNode[];
  pendingCount?: number;
  importHistory?: (nodes: HistoryNode[]) => Promise<void>;
}

function makeClient(options: FakeClientOptions = {}): WorktreeClient {
  return {
    getPendingCount: () => options.pendingCount ?? 0,
    getConfirmed: () => options.confirmed ?? [],
    importHistory: options.importHistory ?? vi.fn(async () => undefined),
  } as unknown as WorktreeClient;
}

function renderSettings(
  calendarDays: number,
  updateConfig = vi.fn(),
  overrides: Partial<AppConfig> = {},
  client: WorktreeClient = makeClient(),
  onClearCache = vi.fn(),
) {
  render(
    <I18nProvider lang="en">
      <ToastProvider>
        <SettingsPage
          config={{ ...makeConfig(calendarDays), ...overrides }}
          client={client}
          tree={tree}
          updateConfig={updateConfig}
          onClearCache={onClearCache}
          onLogout={vi.fn()}
          onLoginOther={vi.fn()}
        />
      </ToastProvider>
    </I18nProvider>,
  );
  return { updateConfig, client, onClearCache };
}

function pickBackup(text: string): void {
  const input = screen.getByTestId('settings-import-input');
  fireEvent.change(input, {
    target: { files: [new File([text], 'worktree-local-2026-10-23.json', { type: 'application/json' })] },
  });
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function seedAccountToken(): void {
  saveToken(SECURITY_SERVER, SECURITY_USER, { token: 'tok-web', tokenId: 1, label: 'Laptop' });
}

function renderAccountSettings() {
  return renderSettings(7, vi.fn(), { user: SECURITY_USER, serverUrl: SECURITY_SERVER });
}

function authorizationHeader(call: RecordedRequest | undefined): unknown {
  if (call === undefined) return undefined;
  const headers: unknown = call.init.headers;
  if (!isRecord(headers)) return undefined;
  return headers.Authorization;
}

function methodOf(call: RecordedRequest): string {
  return call.init.method ?? 'GET';
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  clearToken(SECURITY_SERVER, SECURITY_USER);
  vi.mocked(downloadHistoryBackup).mockClear();
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

describe('SettingsPage server presets', () => {
  it('offers the hosted server and marks the current one', () => {
    renderSettings(7, vi.fn(), { serverUrl: 'https://wkt.raricy.com' });
    expect(screen.getByTestId('settings-server-preset-wkt.raricy.com').getAttribute('aria-pressed')).toBe('true');
    // The retired server must no longer be offered.
    expect(screen.queryByTestId('settings-server-preset-worktree.fuyuzheju.cn')).toBeNull();
  });

  it('switches to a preset in one click and confirms with a toast', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.click(screen.getByTestId('settings-server-preset-wkt.raricy.com'));
    expect(updateConfig).toHaveBeenCalledWith({ serverUrl: 'https://wkt.raricy.com' });
    expect(screen.getByTestId('toast-success').textContent).toContain('Server set to wkt.raricy.com.');
  });
});

describe('SettingsPage apply feedback', () => {
  it('confirms a manually applied server URL', () => {
    const { updateConfig } = renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-server-input'), {
      target: { value: 'https://example.com/' },
    });
    fireEvent.click(screen.getByTestId('settings-apply-server'));
    expect(updateConfig).toHaveBeenCalledWith({ serverUrl: 'https://example.com' });
    expect(screen.getByTestId('toast-success').textContent).toContain('Server set to example.com.');
  });

  it('confirms the quick capture path', () => {
    renderSettings(7);
    fireEvent.change(screen.getByTestId('settings-quick-path-input'), { target: { value: '/inbox' } });
    fireEvent.click(screen.getByTestId('settings-apply-quick-path'));
    expect(screen.getByTestId('toast-success').textContent).toContain('Quick capture path saved.');
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

describe('SettingsPage data transfer', () => {
  it('exports the confirmed history as a dated backup', () => {
    renderSettings(7, vi.fn(), {}, makeClient({ confirmed }));
    fireEvent.click(screen.getByTestId('settings-export-backup'));
    expect(downloadHistoryBackup).toHaveBeenCalledTimes(1);
    const [filename, backup] = vi.mocked(downloadHistoryBackup).mock.calls[0];
    expect(filename).toMatch(/^worktree-local-\d{4}-\d{2}-\d{2}\.json$/);
    expect(backup.format).toBe('worktree-history');
    expect(backup.version).toBe(1);
    expect(backup.user).toBe(LOCAL_USER);
    expect(backup.entries).toEqual(confirmed);
    expect(screen.getByTestId('toast-success').textContent).toContain('Backup downloaded.');
  });

  it('imports a backup into an empty workspace after confirmation', async () => {
    const importHistory = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSettings(7, vi.fn(), {}, makeClient({ importHistory }), vi.fn());
    pickBackup(JSON.stringify(buildHistoryBackup(LOCAL_USER, 'http://localhost:1', confirmed, Date.now())));
    await waitFor(() => expect(importHistory).toHaveBeenCalledWith(confirmed));
    expect(confirm).toHaveBeenCalledWith('Import 2 entries into this empty workspace?');
    await waitFor(() =>
      expect(screen.getByTestId('toast-success').textContent).toContain('Imported 2 entries.'),
    );
    // The input is reset so the same file can be selected again.
    expect((screen.getByTestId('settings-import-input') as HTMLInputElement).value).toBe('');
  });

  it('does not import when the confirmation is declined', async () => {
    const importHistory = vi.fn(async () => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSettings(7, vi.fn(), {}, makeClient({ importHistory }), vi.fn());
    pickBackup(JSON.stringify(buildHistoryBackup(LOCAL_USER, 'http://localhost:1', confirmed, Date.now())));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(importHistory).not.toHaveBeenCalled();
  });

  it('refuses to import into a workspace that already has history', async () => {
    const importHistory = vi.fn(async () => undefined);
    renderSettings(7, vi.fn(), {}, makeClient({ confirmed, importHistory }), vi.fn());
    pickBackup(JSON.stringify(buildHistoryBackup(LOCAL_USER, 'http://localhost:1', confirmed, Date.now())));
    await waitFor(() =>
      expect(screen.getByTestId('toast-error').textContent).toContain('Import needs an empty workspace'),
    );
    expect(importHistory).not.toHaveBeenCalled();
  });

  it('refuses to import while pending ops exist', async () => {
    const importHistory = vi.fn(async () => undefined);
    renderSettings(7, vi.fn(), {}, makeClient({ pendingCount: 1, importHistory }), vi.fn());
    pickBackup(JSON.stringify(buildHistoryBackup(LOCAL_USER, 'http://localhost:1', confirmed, Date.now())));
    await waitFor(() =>
      expect(screen.getByTestId('toast-error').textContent).toContain('Import needs an empty workspace'),
    );
    expect(importHistory).not.toHaveBeenCalled();
  });

  it('rejects a file that is not a backup', async () => {
    const importHistory = vi.fn(async () => undefined);
    renderSettings(7, vi.fn(), {}, makeClient({ importHistory }), vi.fn());
    pickBackup('{"hello":"world"}');
    await waitFor(() =>
      expect(screen.getByTestId('toast-error').textContent).toContain('This file is not a Worktree backup.'),
    );
    expect(importHistory).not.toHaveBeenCalled();
  });

  it('rejects a backup whose history does not replay', async () => {
    const importHistory = vi.fn(async () => undefined);
    renderSettings(7, vi.fn(), {}, makeClient({ importHistory }), vi.fn());
    const broken = {
      format: 'worktree-history',
      version: 1,
      exportedAt: Date.now(),
      user: LOCAL_USER,
      server: 'http://localhost:1',
      entries: [{ id: 'h1', op: { kind: 'add', parentId: 'missing', id: 'a', name: 'A', weight: 1 } }],
    };
    pickBackup(JSON.stringify(broken));
    await waitFor(() =>
      expect(screen.getByTestId('toast-error').textContent).toContain('Import failed: unknown node id: missing'),
    );
    expect(importHistory).not.toHaveBeenCalled();
  });
});

describe('SettingsPage clear cache confirmation', () => {
  it('warns that unsynced changes are lost when ops are pending', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onClearCache = vi.fn();
    renderSettings(7, vi.fn(), {}, makeClient({ pendingCount: 2 }), onClearCache);
    fireEvent.click(screen.getByTestId('settings-clear-cache'));
    expect(confirm).toHaveBeenCalledWith(
      'Clear the locally stored history for "local"? 2 unsynced changes will be lost. Export a backup first if you might need them.',
    );
    expect(onClearCache).not.toHaveBeenCalled();
  });

  it('keeps the server-aware wording when nothing is pending', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onClearCache = vi.fn();
    renderSettings(7, vi.fn(), {}, makeClient(), onClearCache);
    fireEvent.click(screen.getByTestId('settings-clear-cache'));
    expect(confirm).toHaveBeenCalledWith(
      'Clear the locally stored history for "local" on http://localhost:1? Server-side data is not affected.',
    );
    expect(onClearCache).toHaveBeenCalled();
    expect(screen.getByTestId('toast-success').textContent).toContain('Local cache cleared.');
  });
});

describe('SettingsPage security without an account', () => {
  it('does not render the security card for the local user', () => {
    renderSettings(7);
    expect(screen.queryByTestId('settings-security')).toBeNull();
    expect(screen.queryByTestId('settings-devices')).toBeNull();
  });
});

describe('SettingsPage security', () => {
  it('lists devices, marking the current one and offering revoke for the rest', async () => {
    seedAccountToken();
    stubFetch((url, init) => {
      if (url === `${SECURITY_SERVER}/api/tokens` && methodOf({ url, init }) === 'GET') {
        return jsonResponse({ tokens: deviceTokens });
      }
      return jsonResponse({ error: `unexpected ${methodOf({ url, init })} ${url}` }, 500);
    });
    renderAccountSettings();
    const list = await screen.findByTestId('settings-devices');

    const current = within(list).getByTestId('settings-device-1');
    expect(current.textContent).toContain('Laptop');
    expect(current.textContent).toContain('This device');
    expect(within(list).queryByTestId('settings-device-revoke-1')).toBeNull();

    const other = within(list).getByTestId('settings-device-2');
    expect(other.textContent).toContain('Unnamed device');
    expect(other.textContent).toContain('never');
    expect(within(other).getByTestId('settings-device-revoke-2').textContent).toBe('Revoke');
  });

  it('revokes a device after confirmation, calls DELETE and reloads the list', async () => {
    seedAccountToken();
    let current = [...deviceTokens];
    const calls = stubFetch((url, init) => {
      if (url === `${SECURITY_SERVER}/api/tokens` && init.method === undefined) {
        return jsonResponse({ tokens: current });
      }
      if (url === `${SECURITY_SERVER}/api/tokens/2` && init.method === 'DELETE') {
        current = current.filter((device) => device.id !== 2);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: `unexpected ${methodOf({ url, init })} ${url}` }, 500);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAccountSettings();
    fireEvent.click(await screen.findByTestId('settings-device-revoke-2'));

    await waitFor(() => expect(screen.queryByTestId('settings-device-2')).toBeNull());
    expect(confirm).toHaveBeenCalledWith('Sign this device out?');
    expect(screen.getByTestId('toast-success').textContent).toContain('Device signed out.');

    const deletion = calls.find((call) => call.init.method === 'DELETE');
    expect(deletion?.url).toBe(`${SECURITY_SERVER}/api/tokens/2`);
    expect(authorizationHeader(deletion)).toBe('Bearer tok-web');
    expect(calls.filter((call) => methodOf(call) === 'GET')).toHaveLength(2);
  });

  it('keeps the device list when the revocation is declined', async () => {
    seedAccountToken();
    const calls = stubFetch(() => jsonResponse({ tokens: deviceTokens }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAccountSettings();
    fireEvent.click(await screen.findByTestId('settings-device-revoke-2'));
    expect(calls.filter((call) => call.init.method === 'DELETE')).toHaveLength(0);
    expect(screen.getByTestId('settings-device-2')).toBeTruthy();
  });

  it('posts the password change with the bearer token and shows the new code', async () => {
    seedAccountToken();
    const calls = stubFetch((url) => {
      if (url === `${SECURITY_SERVER}/api/tokens`) return jsonResponse({ tokens: [] });
      if (url === `${SECURITY_SERVER}/api/password`) return jsonResponse({ recoveryCode: 'NEW-CODE-1234' });
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });
    renderAccountSettings();
    await screen.findByTestId('settings-devices');
    fireEvent.change(screen.getByTestId('settings-current-password'), { target: { value: 'old-pass-123' } });
    fireEvent.change(screen.getByTestId('settings-new-password'), { target: { value: 'new-pass-456' } });
    fireEvent.click(screen.getByTestId('settings-change-password'));

    const codeInput = await screen.findByTestId('settings-recovery-code');
    expect((codeInput as HTMLInputElement).value).toBe('NEW-CODE-1234');
    expect(screen.getByTestId('settings-one-time-code').textContent).toContain('Password changed.');

    const passwordCall = calls.find((call) => call.url === `${SECURITY_SERVER}/api/password`);
    expect(passwordCall?.init.method).toBe('POST');
    expect(JSON.parse(passwordCall?.init.body as string)).toEqual({
      currentPassword: 'old-pass-123',
      newPassword: 'new-pass-456',
    });
    expect(authorizationHeader(passwordCall)).toBe('Bearer tok-web');
  });

  it('shows the mapped error when the current password is rejected', async () => {
    seedAccountToken();
    stubFetch((url) => {
      if (url === `${SECURITY_SERVER}/api/tokens`) return jsonResponse({ tokens: [] });
      if (url === `${SECURITY_SERVER}/api/password`) {
        return jsonResponse({ error: 'invalid current password' }, 401);
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });
    renderAccountSettings();
    await screen.findByTestId('settings-devices');
    fireEvent.change(screen.getByTestId('settings-current-password'), { target: { value: 'wrong-pass-123' } });
    fireEvent.change(screen.getByTestId('settings-new-password'), { target: { value: 'new-pass-456' } });
    fireEvent.click(screen.getByTestId('settings-change-password'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-password-error').textContent).toBe(
        'Could not change the password: invalid current password',
      ),
    );
  });

  it('creates a recovery code from the current password field', async () => {
    seedAccountToken();
    const calls = stubFetch((url) => {
      if (url === `${SECURITY_SERVER}/api/tokens`) return jsonResponse({ tokens: [] });
      if (url === `${SECURITY_SERVER}/api/recovery-code`) return jsonResponse({ recoveryCode: 'ROTATED-CODE' });
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });
    renderAccountSettings();
    await screen.findByTestId('settings-devices');
    fireEvent.change(screen.getByTestId('settings-current-password'), { target: { value: 'old-pass-123' } });
    fireEvent.click(screen.getByTestId('settings-create-recovery'));

    const codeInput = await screen.findByTestId('settings-recovery-code');
    expect((codeInput as HTMLInputElement).value).toBe('ROTATED-CODE');
    expect(screen.getByTestId('settings-one-time-code').textContent).toContain('Replaces any older code');

    const recoveryCall = calls.find((call) => call.url === `${SECURITY_SERVER}/api/recovery-code`);
    expect(recoveryCall?.init.method).toBe('POST');
    expect(JSON.parse(recoveryCall?.init.body as string)).toEqual({ currentPassword: 'old-pass-123' });
    expect(authorizationHeader(recoveryCall)).toBe('Bearer tok-web');
  });

  it('copies the one-time code when the clipboard is available', async () => {
    seedAccountToken();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubFetch((url) => {
      if (url === `${SECURITY_SERVER}/api/tokens`) return jsonResponse({ tokens: [] });
      if (url === `${SECURITY_SERVER}/api/recovery-code`) return jsonResponse({ recoveryCode: 'ROTATED-CODE' });
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });
    renderAccountSettings();
    await screen.findByTestId('settings-devices');
    fireEvent.change(screen.getByTestId('settings-current-password'), { target: { value: 'old-pass-123' } });
    fireEvent.click(screen.getByTestId('settings-create-recovery'));
    await screen.findByTestId('settings-recovery-code');

    fireEvent.click(screen.getByTestId('settings-recovery-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ROTATED-CODE'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-recovery-copy').textContent).toBe('Copied'),
    );
  });
});
