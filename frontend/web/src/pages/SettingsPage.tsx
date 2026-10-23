import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { WorktreeState, normalizeCapturePath } from '@worktree/core';
import type { Node, TokensResponse } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { verifyProvider } from '@worktree/agent';
import { ExpandSelect } from '../components/ExpandSelect';
import { SemesterFields } from '../components/agent/SemesterFields';
import { CheckIcon } from '../components/icons';
import { useToast } from '../components/Toast';
import { LOCAL_USER, SERVER_PRESETS, listLoggedInUsers, loadToken } from '../config';
import type { AppConfig, FilterDisplayMode } from '../config';
import { AuthError, authRequest, listTokensRequest, revokeTokenRequest } from '../auth';
import {
  buildHistoryBackup,
  downloadHistoryBackup,
  historyBackupFilename,
  parseHistoryBackup,
  readFileText,
} from '../data-transfer';
import type { HistoryBackup } from '../data-transfer';
import { LANGS, useI18n } from '../i18n';
import { disablePush, enablePush, getPushStatus } from '../push';
import type { PushStatus } from '../push';
import type { ThemePref } from '../theme';
import { flattenTree } from '../tree-utils';

function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The host a server URL points at, for compact labels and confirmations. */
function serverHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/** One device token from `GET /api/tokens`. */
type DeviceToken = TokensResponse['tokens'][number];

/** The message a failed request carries; a thrown value that is not an Error keeps its text form. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An ISO timestamp for display; an unparseable value is shown as-is instead of "Invalid Date". */
function formatDeviceTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function SettingsPage(props: {
  config: AppConfig;
  client: WorktreeClient;
  tree: Node;
  updateConfig: (patch: Partial<AppConfig>) => void;
  onClearCache: () => void;
  onLogout: () => void;
  onLoginOther: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { config, client, tree, updateConfig, onClearCache, onLogout, onLoginOther } = props;

  const [serverDraft, setServerDraft] = useState(config.serverUrl);
  const [serverError, setServerError] = useState<string | null>(null);
  const currentServer = config.serverUrl.trim().replace(/\/+$/, '');

  const applyServerUrl = (raw: string): void => {
    const value = raw.trim().replace(/\/+$/, '');
    if (!validServerUrl(value)) {
      setServerError(t('settings.invalidServer'));
      return;
    }
    setServerError(null);
    setServerDraft(value);
    updateConfig({ serverUrl: value });
    toast.success(t('settings.serverApplied', { host: serverHost(value) }));
  };

  const applyServer = (): void => applyServerUrl(serverDraft);

  const [quickDraft, setQuickDraft] = useState(config.quickAddPath);
  const [quickError, setQuickError] = useState<string | null>(null);

  const applyQuickPath = (): void => {
    const value = quickDraft.trim();
    try {
      normalizeCapturePath(value);
    } catch {
      setQuickError(t('settings.invalidQuickPath'));
      return;
    }
    setQuickError(null);
    setQuickDraft(value);
    updateConfig({ quickAddPath: value });
    toast.success(t('settings.quickPathApplied'));
  };

  const clearCache = (): void => {
    const pending = client.getPendingCount();
    const message =
      pending > 0
        ? t('settings.clearConfirmUnsynced', { user: config.user, n: pending })
        : t('settings.clearConfirm', { user: config.user, server: config.serverUrl });
    if (!window.confirm(message)) {
      return;
    }
    onClearCache();
    toast.success(t('settings.cleared'));
  };

  const [aiBaseDraft, setAiBaseDraft] = useState(config.ai.baseUrl);
  const [aiModelDraft, setAiModelDraft] = useState(config.ai.model);
  const [aiKeyDraft, setAiKeyDraft] = useState(config.ai.apiKey);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiTesting, setAiTesting] = useState(false);

  const applyAi = (): void => {
    const baseUrl = aiBaseDraft.trim().replace(/\/+$/, '');
    if (!validServerUrl(baseUrl)) {
      setAiError(t('settings.ai.invalidUrl'));
      return;
    }
    const model = aiModelDraft.trim();
    if (model === '') {
      setAiError(t('settings.ai.invalidModel'));
      return;
    }
    setAiError(null);
    setAiStatus(null);
    setAiBaseDraft(baseUrl);
    setAiModelDraft(model);
    updateConfig({ ai: { ...config.ai, baseUrl, model, apiKey: aiKeyDraft } });
    toast.success(t('settings.ai.saved'));
  };

  const testAi = async (): Promise<void> => {
    const baseUrl = aiBaseDraft.trim().replace(/\/+$/, '');
    if (!validServerUrl(baseUrl)) {
      setAiError(t('settings.ai.invalidUrl'));
      return;
    }
    if (aiModelDraft.trim() === '') {
      setAiError(t('settings.ai.invalidModel'));
      return;
    }
    if (aiKeyDraft.trim() === '') {
      setAiError(t('settings.ai.invalidKey'));
      return;
    }
    setAiTesting(true);
    setAiError(null);
    setAiStatus(null);
    try {
      const result = await verifyProvider({ baseUrl, model: aiModelDraft.trim(), apiKey: aiKeyDraft });
      setAiStatus(t('settings.ai.connected', { model: result.model }));
    } catch (e) {
      setAiError(t('settings.ai.testFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAiTesting(false);
    }
  };

  const storedToken = config.user === LOCAL_USER ? null : loadToken(config.serverUrl, config.user);

  const [devices, setDevices] = useState<DeviceToken[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const loadDevices = useCallback(async (): Promise<void> => {
    const stored = loadToken(config.serverUrl, config.user);
    if (stored === null) {
      setDevices(null);
      setDevicesError(null);
      return;
    }
    try {
      const result = await listTokensRequest(config.serverUrl, stored.token);
      setDevices(result.tokens);
      setDevicesError(null);
    } catch (e) {
      setDevicesError(failureMessage(e));
    }
  }, [config.serverUrl, config.user]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const revokeDevice = async (id: number): Promise<void> => {
    const stored = loadToken(config.serverUrl, config.user);
    if (stored === null) return;
    if (!window.confirm(t('settings.deviceRevokeConfirm'))) return;
    setRevokingId(id);
    try {
      await revokeTokenRequest(config.serverUrl, stored.token, id);
      toast.success(t('settings.deviceRevoked'));
      await loadDevices();
    } catch (e) {
      setDevicesError(failureMessage(e));
    } finally {
      setRevokingId(null);
    }
  };

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  /** The recovery code the server just issued; it can never be fetched again. */
  const [oneTimeCode, setOneTimeCode] = useState<{ code: string; kind: 'password' | 'recovery' } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const changePassword = async (): Promise<void> => {
    const stored = loadToken(config.serverUrl, config.user);
    if (stored === null) return;
    setPasswordBusy(true);
    setPasswordError(null);
    setOneTimeCode(null);
    setCodeCopied(false);
    try {
      const result = await authRequest(
        config.serverUrl,
        '/api/password',
        { currentPassword, newPassword },
        stored.token,
      );
      setOneTimeCode({ code: result.recoveryCode, kind: 'password' });
      setCurrentPassword('');
      setNewPassword('');
      // The server signs out the other devices, so the list on screen is stale.
      await loadDevices();
    } catch (e) {
      setPasswordError(
        e instanceof AuthError && (e.status === 404 || e.status === 405)
          ? t('settings.featureUnavailable')
          : t('settings.passwordFailed', { message: failureMessage(e) }),
      );
    } finally {
      setPasswordBusy(false);
    }
  };

  const createRecoveryCode = async (): Promise<void> => {
    const stored = loadToken(config.serverUrl, config.user);
    if (stored === null) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    setOneTimeCode(null);
    setCodeCopied(false);
    try {
      const result = await authRequest(
        config.serverUrl,
        '/api/recovery-code',
        { currentPassword },
        stored.token,
      );
      setOneTimeCode({ code: result.recoveryCode, kind: 'recovery' });
    } catch (e) {
      setRecoveryError(
        e instanceof AuthError && (e.status === 404 || e.status === 405)
          ? t('settings.featureUnavailable')
          : t('settings.recoveryFailed', { message: failureMessage(e) }),
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  const copyRecoveryCode = async (code: string): Promise<void> => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) return;
    try {
      await clipboard.writeText(code);
      setCodeCopied(true);
    } catch {
      // The code sits in a select-all input, so a failed write still leaves it
      // copyable by hand; the button keeps its idle label.
      setCodeCopied(false);
    }
  };

  const [pushStatus, setPushStatus] = useState<PushStatus>('checking');
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const stored = loadToken(config.serverUrl, config.user);
      if (stored === null) {
        if (!cancelled) setPushStatus('checking');
        return;
      }
      try {
        const status = await getPushStatus(config.serverUrl, stored.token);
        if (!cancelled) setPushStatus(status);
      } catch {
        if (!cancelled) setPushStatus('disabled');
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [config.serverUrl, config.user]);

  const togglePush = (enable: boolean): void => {
    const stored = storedToken;
    if (stored === null) return;
    setPushBusy(true);
    setPushError(null);
    const run = enable
      ? enablePush(config.serverUrl, stored.token)
      : disablePush(config.serverUrl, stored.token);
    run
      .then(() => {
        setPushStatus(enable ? 'enabled' : 'disabled');
        toast.success(enable ? t('settings.notifications.enabled') : t('settings.notifications.disabled'));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setPushError(t('settings.notifications.error', { message: msg }));
        setPushStatus(enable ? 'disabled' : 'enabled');
      })
      .finally(() => setPushBusy(false));
  };

  const logout = async (): Promise<void> => {
    const stored = storedToken;
    if (stored !== null) {
      try {
        // Best-effort server-side revocation; local state is cleared either way.
        await authRequest(config.serverUrl, '/api/logout', {}, stored.token);
      } catch (e) {
        console.warn('server-side logout failed:', e);
      }
    }
    onLogout();
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const exportBackup = (): void => {
    const now = Date.now();
    downloadHistoryBackup(
      historyBackupFilename(config.user, now),
      buildHistoryBackup(config.user, config.serverUrl, client.getConfirmed(), now),
    );
    toast.success(t('settings.exportDone'));
  };

  /** Parse the picked file into a backup, or null when it is not one. */
  const readBackup = async (file: File): Promise<HistoryBackup | null> => {
    try {
      return parseHistoryBackup(await readFileText(file));
    } catch {
      return null;
    }
  };

  const importBackup = async (file: File): Promise<void> => {
    setImporting(true);
    const backup = await readBackup(file);
    if (backup === null) {
      setImporting(false);
      toast.error(t('settings.invalidFile'));
      return;
    }
    try {
      // Prove the whole history replays before touching the workspace: a
      // backup whose ops no longer validate must not replace anything.
      WorktreeState.fromOps(backup.entries.map((entry) => entry.op));
      if (client.getConfirmed().length > 0 || client.getPendingCount() > 0) {
        toast.error(t('settings.importEmptyOnly'));
        return;
      }
      if (!window.confirm(t('settings.importConfirm', { n: backup.entries.length }))) {
        return;
      }
      await client.importHistory(backup.entries);
      toast.success(t('settings.importDone', { n: backup.entries.length }));
    } catch (e) {
      toast.error(t('settings.importFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImporting(false);
    }
  };

  const nodeCount = flattenTree(tree).length - 1;
  const pendingCount = client.getPendingCount();

  const userOptions = [
    { value: LOCAL_USER, label: t('settings.localUser') },
    ...listLoggedInUsers(config.serverUrl).map((name) => ({ value: name, label: name })),
  ];

  const dayOptions = [3, 4, 5, 6, 7, 8, 9].map((days) => ({ value: String(days), label: String(days) }));

  const langOptions = LANGS.map((code) => ({ value: code, label: t(`language.${code}`) }));

  const filterOptions: SliderOption<FilterDisplayMode>[] = [
    { value: 'hide', label: t('filter.hide'), testId: 'settings-filter-mode-hide' },
    { value: 'highlight', label: t('filter.highlight'), testId: 'settings-filter-mode-highlight' },
  ];

  const themeOptions: SliderOption<ThemePref>[] = [
    { value: 'system', label: t('settings.themeSystem'), testId: 'settings-theme-system' },
    { value: 'light', label: t('settings.themeLight'), testId: 'settings-theme-light' },
    { value: 'dark', label: t('settings.themeDark'), testId: 'settings-theme-dark' },
  ];

  return (
    <div className="page-wrap">
      <header className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('tabs.settings')}</h1>
        </div>
      </header>
      <div className="page-body">
        <div className="settings">
          {storedToken !== null && (
            <>
              <section className="card">
                <div className="section-head">
                  <h2 className="section-title">{t('settings.account')}</h2>
                </div>
                <p className="setting__hint">
                  {t('settings.loggedIn', {
                    user: config.user,
                    label: storedToken.label ?? t('settings.noLabel'),
                  })}
                </p>
              </section>

              <section className="card">
                <div className="section-head">
                  <h2 className="section-title">{t('settings.notifications.title')}</h2>
                </div>
                <p className="setting__hint">{t('settings.notifications.hint')}</p>
                {pushStatus === 'checking' && <span className="muted">…</span>}
                {pushStatus === 'unsupported' && (
                  <p className="setting__hint">{t('settings.notifications.unsupported')}</p>
                )}
                {pushStatus === 'serverDisabled' && (
                  <p className="setting__hint">{t('settings.notifications.serverDisabled')}</p>
                )}
                {pushStatus === 'denied' && (
                  <p className="form__error">{t('settings.notifications.denied')}</p>
                )}
                {pushStatus === 'enabled' && (
                  <p className="setting__hint">{t('settings.notifications.enabled')}</p>
                )}
                {pushStatus === 'disabled' && (
                  <p className="setting__hint">{t('settings.notifications.disabled')}</p>
                )}
                <div className="settings__actions">
                  {(pushStatus === 'disabled' || pushStatus === 'denied') && (
                    <button
                      type="button"
                      onClick={() => togglePush(true)}
                      disabled={pushBusy}
                      data-testid="settings-push-enable"
                      className="btn btn--primary btn--sm"
                    >
                      {t('settings.notifications.enable')}
                    </button>
                  )}
                  {pushStatus === 'enabled' && (
                    <button
                      type="button"
                      onClick={() => togglePush(false)}
                      disabled={pushBusy}
                      data-testid="settings-push-disable"
                      className="btn btn--sm"
                    >
                      {t('settings.notifications.disable')}
                    </button>
                  )}
                </div>
                {pushError !== null && (
                  <p className="form__error" data-testid="settings-push-error">
                    {pushError}
                  </p>
                )}
              </section>

              <section className="card" data-testid="settings-security">
                <div className="section-head">
                  <h2 className="section-title">{t('settings.security')}</h2>
                </div>

                <div className="stack">
                  <h3 className="setting__label">{t('settings.devices')}</h3>
                  <p className="setting__hint">{t('settings.devicesHint')}</p>
                  {devices === null && devicesError === null && <span className="muted">…</span>}
                  {devices !== null && (
                    <ul className="stack" data-testid="settings-devices">
                      {devices.map((device) => (
                        <li key={device.id} className="setting" data-testid={`settings-device-${device.id}`}>
                          <div className="device-row">
                            <div className="cluster">
                              <span className="setting__label">
                                {device.label ?? t('settings.deviceUnnamed')}
                              </span>
                              {device.current && (
                                <span className="pill pill--brand">{t('settings.deviceCurrent')}</span>
                              )}
                            </div>
                            <span className="setting__hint">
                              {t('settings.deviceCreated')}{' '}
                              <span className="mono">{formatDeviceTime(device.createdAt)}</span>
                              {' · '}
                              {t('settings.deviceLastUsed')}{' '}
                              <span className="mono">
                                {device.lastUsedAt === null
                                  ? t('settings.deviceNever')
                                  : formatDeviceTime(device.lastUsedAt)}
                              </span>
                            </span>
                          </div>
                          {!device.current && (
                            <button
                              type="button"
                              onClick={() => void revokeDevice(device.id)}
                              disabled={revokingId !== null}
                              data-testid={`settings-device-revoke-${device.id}`}
                              className="btn btn--danger btn--sm"
                            >
                              {t('settings.deviceRevoke')}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {devicesError !== null && (
                    <p className="form__error" data-testid="settings-devices-error">
                      {t('settings.devicesFailed', { message: devicesError })}
                    </p>
                  )}
                </div>

                <div className="stack">
                  <label className="field">
                    <span className="field__label">{t('settings.currentPassword')}</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      data-testid="settings-current-password"
                      className="input"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">{t('settings.newPasswordOptional')}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      data-testid="settings-new-password"
                      className="input"
                    />
                  </label>
                  <div className="settings__actions">
                    <button
                      type="button"
                      onClick={() => void changePassword()}
                      disabled={passwordBusy || currentPassword === '' || newPassword.length < 8}
                      data-testid="settings-change-password"
                      className="btn btn--primary btn--sm"
                    >
                      {t('settings.changePassword')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void createRecoveryCode()}
                      disabled={recoveryBusy || currentPassword === ''}
                      data-testid="settings-create-recovery"
                      className="btn btn--sm"
                    >
                      {t('settings.createRecovery')}
                    </button>
                  </div>
                  {passwordError !== null && (
                    <p className="form__error" data-testid="settings-password-error">
                      {passwordError}
                    </p>
                  )}
                  {recoveryError !== null && (
                    <p className="form__error" data-testid="settings-recovery-error">
                      {recoveryError}
                    </p>
                  )}
                  {oneTimeCode !== null && (
                    <div className="notice notice--success" role="status" data-testid="settings-one-time-code">
                      <p className="notice__title">
                        {oneTimeCode.kind === 'password'
                          ? t('settings.passwordChanged')
                          : t('settings.recoveryCreated')}
                      </p>
                      <p className="setting__hint">{t('settings.recoveryHint')}</p>
                      <div className="setting">
                        <input
                          readOnly
                          value={oneTimeCode.code}
                          aria-label={t('settings.recoveryCreated')}
                          data-testid="settings-recovery-code"
                          className="input input--mono flex-1"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <button
                          type="button"
                          onClick={() => void copyRecoveryCode(oneTimeCode.code)}
                          data-testid="settings-recovery-copy"
                          className="btn btn--sm"
                        >
                          {codeCopied ? t('settings.recoveryCopied') : t('settings.recoveryCopy')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.user')}</h2>
            </div>
            <p className="setting__hint">{t('settings.currentUser', { user: config.user })}</p>
            <div className="setting">
              <ExpandSelect
                value={config.user}
                options={userOptions}
                onChange={(user) => updateConfig({ user })}
                label={t('settings.user')}
                testId="settings-user-select"
                className="w-56 max-w-full"
              />
              <div className="cluster">
                <button
                  type="button"
                  onClick={onLoginOther}
                  data-testid="settings-login-other"
                  className="btn btn--primary btn--sm"
                >
                  {t('settings.loginOther')}
                </button>
                {storedToken !== null && (
                  <button
                    type="button"
                    onClick={() => void logout()}
                    data-testid="settings-logout"
                    className="btn btn--danger btn--sm"
                  >
                    {t('settings.logout')}
                  </button>
                )}
              </div>
            </div>
            <p className="setting__hint">{t('settings.userNote')}</p>
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.serverUrl')}</h2>
            </div>
            <div className="setting">
              <input
                value={serverDraft}
                onChange={(e) => setServerDraft(e.target.value)}
                data-testid="settings-server-input"
                aria-label={t('settings.serverUrl')}
                className="input input--mono flex-1"
              />
              <button
                type="button"
                onClick={applyServer}
                data-testid="settings-apply-server"
                className="btn btn--primary btn--sm"
              >
                {t('settings.apply')}
              </button>
            </div>
            <div className="settings__presets">
              <span className="setting__hint">{t('settings.serverPresets')}</span>
              <div className="cluster">
                {SERVER_PRESETS.map((url) => {
                  const host = serverHost(url);
                  return (
                    <button
                      key={url}
                      type="button"
                      onClick={() => applyServerUrl(url)}
                      aria-pressed={currentServer === url}
                      aria-label={url}
                      title={url}
                      data-testid={`settings-server-preset-${host}`}
                      className="server-chip"
                    >
                      {currentServer === url && (
                        <CheckIcon className="server-chip__check icon icon--sm" />
                      )}
                      <span className="server-chip__host">{host}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="setting__hint">{t('settings.serverNote')}</p>
            {serverError !== null && <p className="form__error">{serverError}</p>}
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.capture')}</h2>
            </div>
            <div className="setting">
              <input
                value={quickDraft}
                onChange={(e) => setQuickDraft(e.target.value)}
                data-testid="settings-quick-path-input"
                aria-label={t('settings.capture')}
                className="input input--mono flex-1"
              />
              <button
                type="button"
                onClick={applyQuickPath}
                data-testid="settings-apply-quick-path"
                className="btn btn--primary btn--sm"
              >
                {t('settings.apply')}
              </button>
            </div>
            <p className="setting__hint">{t('settings.captureNote')}</p>
            {quickError !== null && <p className="form__error">{quickError}</p>}
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.ai.title')}</h2>
            </div>
            <p className="setting__hint">{t('settings.ai.hint')}</p>
            <div className="stack">
              <label className="field">
                <span className="field__label">{t('settings.ai.baseUrl')}</span>
                <input
                  value={aiBaseDraft}
                  onChange={(e) => setAiBaseDraft(e.target.value)}
                  data-testid="settings-ai-base-url"
                  className="input input--mono"
                />
              </label>
              <div className="form__row">
                <label className="field">
                  <span className="field__label">{t('settings.ai.model')}</span>
                  <input
                    value={aiModelDraft}
                    onChange={(e) => setAiModelDraft(e.target.value)}
                    data-testid="settings-ai-model"
                    className="input input--mono"
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t('settings.ai.apiKey')}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={aiKeyDraft}
                    onChange={(e) => setAiKeyDraft(e.target.value)}
                    data-testid="settings-ai-key"
                    className="input input--mono"
                  />
                </label>
              </div>
              <p className="setting__hint">{t('settings.ai.keyHint')}</p>
              <div className="settings__actions">
                <button
                  type="button"
                  onClick={applyAi}
                  data-testid="settings-ai-apply"
                  className="btn btn--primary btn--sm"
                >
                  {t('settings.ai.apply')}
                </button>
                <button
                  type="button"
                  onClick={() => void testAi()}
                  disabled={aiTesting}
                  data-testid="settings-ai-test"
                  className="btn btn--sm"
                >
                  {aiTesting ? t('settings.ai.testing') : t('settings.ai.test')}
                </button>
              </div>
              {aiStatus !== null && (
                <p className="notice notice--success" role="status" data-testid="settings-ai-status">
                  {aiStatus}
                </p>
              )}
              {aiError !== null && (
                <p className="form__error" data-testid="settings-ai-error">
                  {aiError}
                </p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('agent.semester.title')}</h2>
            </div>
            <SemesterFields
              semester={config.ai.semester}
              onChange={(semester) => updateConfig({ ai: { ...config.ai, semester } })}
              testIdPrefix="settings-semester"
            />
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.display')}</h2>
            </div>
            <div className="stack">
              <Checkbox
                checked={config.display.showId}
                onChange={(v) => updateConfig({ display: { ...config.display, showId: v } })}
                label={t('settings.showId')}
                testId="settings-show-id"
              />
              <Checkbox
                checked={config.display.showWeight}
                onChange={(v) => updateConfig({ display: { ...config.display, showWeight: v } })}
                label={t('settings.showWeight')}
              />
              <Checkbox
                checked={config.display.showReminders}
                onChange={(v) => updateConfig({ display: { ...config.display, showReminders: v } })}
                label={t('settings.showReminders')}
              />
              <div className="field">
                <span className="field__label">{t('settings.filterMode')}</span>
                <Slider
                  label={t('settings.filterMode')}
                  value={config.display.filterMode}
                  options={filterOptions}
                  onChange={(filterMode) =>
                    updateConfig({ display: { ...config.display, filterMode } })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.theme')}</h2>
            </div>
            <Slider
              label={t('settings.theme')}
              value={config.theme}
              options={themeOptions}
              onChange={(theme) => updateConfig({ theme })}
            />
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.autoReminder')}</h2>
            </div>
            <div className="stack">
              <Checkbox
                checked={config.autoReminder.enabled}
                onChange={(v) => updateConfig({ autoReminder: { ...config.autoReminder, enabled: v } })}
                label={t('settings.autoReminderEnabled')}
                testId="settings-auto-reminder-enabled"
              />
              <label className="setting">
                <span className="setting__label">{t('settings.autoReminderPct')}</span>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={config.autoReminder.pct}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    if (e.target.value === '' || !Number.isFinite(raw)) return;
                    const pct = Math.min(99, Math.max(1, Math.round(raw)));
                    updateConfig({ autoReminder: { ...config.autoReminder, pct } });
                  }}
                  data-testid="settings-auto-reminder-pct"
                  className="input input--compact w-20"
                />
              </label>
              <p className="setting__hint">{t('settings.autoReminderHint')}</p>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.calendar')}</h2>
            </div>
            <div className="setting">
              <span className="setting__label">{t('settings.calendarDays')}</span>
              <ExpandSelect
                value={String(config.calendarDays)}
                options={dayOptions}
                onChange={(value) => updateConfig({ calendarDays: Number(value) })}
                label={t('settings.calendarDays')}
                testId="settings-calendar-days"
                className="w-24"
              />
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.language')}</h2>
            </div>
            <ExpandSelect
              value={config.lang}
              options={langOptions}
              onChange={(lang) => updateConfig({ lang })}
              label={t('settings.language')}
              testId="settings-language"
              className="w-56 max-w-full"
            />
          </section>

          <section className="card">
            <div className="section-head">
              <h2 className="section-title">{t('settings.data')}</h2>
            </div>
            <div className="setting">
              <span className="setting__label">{t('stats.nodesHeading')}</span>
              <span className="setting__value mono">{nodeCount}</span>
            </div>
            <div className="setting">
              <span className="setting__label">{t('settings.pendingCount')}</span>
              <span className="setting__value mono">{pendingCount}</span>
            </div>
            <p className="setting__hint">{t('settings.exportHint')}</p>
            <p className="setting__hint">{t('settings.importHint')}</p>
            <div className="settings__actions">
              <button
                type="button"
                onClick={exportBackup}
                data-testid="settings-export-backup"
                className="btn btn--sm"
              >
                {t('settings.export')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                aria-label={t('settings.import')}
                data-testid="settings-import-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so picking the same file again still fires onChange.
                  e.target.value = '';
                  if (file !== undefined) void importBackup(file);
                }}
                className="visually-hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                data-testid="settings-import-backup"
                className="btn btn--sm"
              >
                {t('settings.import')}
              </button>
              <button
                type="button"
                onClick={clearCache}
                data-testid="settings-clear-cache"
                className="btn btn--danger btn--sm"
              >
                {t('settings.clearCache')}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        data-testid={props.testId}
      />
      {props.label}
    </label>
  );
}

interface SliderOption<T extends string> {
  value: T;
  label: string;
  testId: string;
}

/** One-of-N pill whose thumb slides to the chosen item; `data-count`/`data-active` drive the slide. */
function Slider<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<SliderOption<T>>;
  onChange: (value: T) => void;
}): ReactElement {
  const { label, value, options, onChange } = props;
  const activeIndex = indexOfOption(options, value);
  return (
    <div
      className="segmented"
      data-count={options.length}
      data-active={activeIndex}
      role="group"
      aria-label={label}
    >
      <span className="segmented__thumb" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          aria-pressed={index === activeIndex}
          onClick={() => onChange(option.value)}
          data-testid={option.testId}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The index the thumb has to sit at; a value outside the options is a bug, not a default. */
function indexOfOption<T extends string>(options: ReadonlyArray<{ value: T }>, value: T): number {
  const index = options.findIndex((option) => option.value === value);
  if (index === -1) throw new Error(`unknown option value: ${value}`);
  return index;
}
