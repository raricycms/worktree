import { useState } from 'react';
import { USER_RE } from '@worktree/core';
import type { RegisterResponse } from '@worktree/core';
import { LOCAL_USER } from '../config';
import type { StoredToken } from '../config';
import { AuthError, authRequest } from '../auth';
import { useI18n } from '../i18n';

type Mode = 'login' | 'register' | 'recover';

type RecoveryPanel =
  | { kind: 'registered'; code: string; auth: { username: string; stored: StoredToken } }
  | { kind: 'reset'; code: string; username: string };

export function AuthPage(props: {
  serverUrl: string;
  user: string;
  /** `username` is the server-confirmed identity — it may differ from `user`. */
  onAuthed: (username: string, token: StoredToken) => void;
  onUseLocal: () => void;
  /** Which tab to open first; the first-run account button starts at register. */
  initialMode?: 'login' | 'register';
  /** Confirmed local changes, shown as a migration notice before switching. */
  localDataCount?: number;
}) {
  const { t } = useI18n();
  const { serverUrl, user, onAuthed, onUseLocal, initialMode = 'login', localDataCount = 0 } = props;

  const [mode, setMode] = useState<Mode>(initialMode);
  // "local" is a reserved client-side name; a server account with it could
  // never be addressed again. Start from an empty field for those users.
  const [username, setUsername] = useState(user === LOCAL_USER ? '' : user);
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<RecoveryPanel | null>(null);
  const [copied, setCopied] = useState(false);

  /** Switch tabs and clear the per-mode inputs so a password never leaks across modes. */
  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setPassword('');
    setRecoveryCode('');
    setCopied(false);
  };

  const copy = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // The value sits in a select-all input: a failed clipboard write still
      // leaves the code copyable by hand.
      setCopied(false);
    }
  };

  const submit = async (): Promise<void> => {
    const name = username.trim();
    if (!USER_RE.test(name)) {
      setError(t('auth.invalidUser'));
      return;
    }
    if (mode === 'recover') {
      if (recoveryCode.trim() === '' || password.length < 8) {
        setError(t('auth.recoverInvalid'));
        return;
      }
    } else if (password.length < 8) {
      setError(t('auth.shortPassword'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'recover') {
        const res = await authRequest(serverUrl, '/api/recover', {
          username: name,
          recoveryCode: recoveryCode.trim(),
          newPassword: password,
        });
        setPanel({ kind: 'reset', code: res.recoveryCode, username: name });
        return;
      }
      if (mode === 'login') {
        const res = await authRequest(serverUrl, '/api/login', {
          username: name,
          password,
          ...(label.trim() === '' ? {} : { label: label.trim() }),
        });
        onAuthed(res.username, { token: res.token, tokenId: res.tokenId, label: label.trim() || undefined });
        return;
      }
      const res: RegisterResponse = await authRequest(serverUrl, '/api/register', {
        username: name,
        password,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
      });
      const stored: StoredToken = {
        token: res.token,
        tokenId: res.tokenId,
        label: label.trim() || undefined,
      };
      // A server released before account recovery sends no code; keep the
      // plain flow for it instead of dead-ending registration.
      if (res.recoveryCode === undefined || res.recoveryCode === '') {
        onAuthed(res.username, stored);
        return;
      }
      // The code is returned exactly once; show it before entering the app.
      setPanel({ kind: 'registered', code: res.recoveryCode, auth: { username: res.username, stored } });
    } catch (e) {
      if (e instanceof AuthError) {
        if (mode === 'recover' && (e.status === 401 || e.status === 404 || e.status === 405)) {
          // A server without /api/recover answers 401/404 here; a wrong code on
          // a server that supports recovery answers 400 (handled below).
          setError(t('auth.recoverUnavailable'));
        } else if (mode === 'recover') setError(t('auth.recoverInvalid'));
        else if (e.status === 401) setError(t('auth.invalidCredentials'));
        else if (e.status === 409) setError(t('auth.usernameTaken'));
        else setError(e.message);
      } else {
        setError(t('auth.networkError'));
      }
    } finally {
      setBusy(false);
    }
  };

  const finishRegister = (): void => {
    if (panel === null || panel.kind !== 'registered') return;
    onAuthed(panel.auth.username, panel.auth.stored);
  };

  const backToLogin = (): void => {
    if (panel === null || panel.kind !== 'reset') return;
    setUsername(panel.username);
    setPanel(null);
    setPassword('');
    setError(null);
    setMode('login');
  };

  const activeIndex = mode === 'login' ? 0 : mode === 'register' ? 1 : 2;

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="stack">
          <h1 className="visually-hidden">{t('auth.title')}</h1>
          <span className="auth__brand">{t('app.title')}</span>
          <p className="page-meta mono">{serverUrl}</p>
        </div>

        {localDataCount > 0 && (
          <div className="notice" data-testid="auth-local-data">
            <p className="tiny">{t('firstRun.localDataNotice', { n: localDataCount })}</p>
          </div>
        )}

        {panel !== null ? (
          <div className="stack" data-testid="auth-recovery-panel">
            <h2 className="section-title">
              {panel.kind === 'registered' ? t('auth.recoveryTitle') : t('auth.recoveryNewTitle')}
            </h2>
            <p className="small muted">
              {panel.kind === 'registered' ? t('auth.recoveryBody') : t('auth.recoveryNewBody')}
            </p>
            <input
              readOnly
              value={panel.code}
              aria-label={t('auth.recoveryCode')}
              data-testid="auth-recovery-value"
              className="input input--mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => void copy(panel.code)}
              data-testid="auth-recovery-copy"
              className="btn btn--sm"
            >
              {copied ? t('auth.recoveryCopied') : t('auth.recoveryCopy')}
            </button>
            {panel.kind === 'registered' ? (
              <button
                type="button"
                onClick={finishRegister}
                data-testid="auth-recovery-continue"
                className="btn btn--primary btn--block"
              >
                {t('auth.recoverySaved')}
              </button>
            ) : (
              <button
                type="button"
                onClick={backToLogin}
                data-testid="auth-recovery-back"
                className="btn btn--primary btn--block"
              >
                {t('auth.recoverBackToLogin')}
              </button>
            )}
          </div>
        ) : (
          <>
            <div
              className="segmented"
              data-count={3}
              data-active={activeIndex}
              role="group"
              aria-label={t('auth.title')}
            >
              <span className="segmented__thumb" aria-hidden="true" />
              <button
                type="button"
                data-testid="auth-mode-login"
                aria-pressed={mode === 'login'}
                onClick={() => switchMode('login')}
                className="segmented__item"
              >
                {t('auth.login')}
              </button>
              <button
                type="button"
                data-testid="auth-mode-register"
                aria-pressed={mode === 'register'}
                onClick={() => switchMode('register')}
                className="segmented__item"
              >
                {t('auth.register')}
              </button>
              <button
                type="button"
                data-testid="auth-mode-recover"
                aria-pressed={mode === 'recover'}
                onClick={() => switchMode('recover')}
                className="segmented__item"
              >
                {t('auth.recoverMode')}
              </button>
            </div>

            <div className="form">
              <label className="field">
                <span className="field__label">{t('auth.username')}</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  data-testid="auth-username"
                  className="input"
                />
              </label>
              {mode === 'recover' ? (
                <>
                  <label className="field">
                    <span className="field__label">{t('auth.recoveryCode')}</span>
                    <input
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      autoComplete="off"
                      data-testid="auth-recovery-input"
                      className="input input--mono"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">{t('auth.newPassword')}</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      data-testid="auth-password"
                      className="input"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">{t('auth.password')}</span>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      data-testid="auth-password"
                      className="input"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">{t('auth.label')}</span>
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder={t('auth.labelPlaceholder')}
                      data-testid="auth-label"
                      className="input"
                    />
                  </label>
                </>
              )}
            </div>

            {error !== null && (
              <p className="form__error" data-testid="auth-error">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              data-testid="auth-submit"
              className="btn btn--primary btn--block"
            >
              {busy
                ? mode === 'recover'
                  ? t('auth.recoverBusy')
                  : t('auth.busy')
                : mode === 'login'
                  ? t('auth.login')
                  : mode === 'register'
                    ? t('auth.register')
                    : t('auth.recoverSubmit')}
            </button>
            <button type="button" onClick={onUseLocal} data-testid="auth-use-local" className="btn btn--block">
              {t('auth.useLocal')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
