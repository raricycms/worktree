import { useState } from 'react';
import { USER_RE } from '@worktree/core';
import type { StoredToken } from '../config';
import { AuthError, authRequest } from '../auth';
import { useI18n } from '../i18n';

export function AuthPage(props: {
  serverUrl: string;
  user: string;
  /** `username` is the server-confirmed identity — it may differ from `user`. */
  onAuthed: (username: string, token: StoredToken) => void;
  onUseLocal: () => void;
}) {
  const { t } = useI18n();
  const { serverUrl, user, onAuthed, onUseLocal } = props;

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState(user);
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const name = username.trim();
    if (!USER_RE.test(name)) {
      setError(t('auth.invalidUser'));
      return;
    }
    if (password.length < 8) {
      setError(t('auth.shortPassword'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authRequest(
        serverUrl,
        mode === 'login' ? '/api/login' : '/api/register',
        { username: name, password, ...(label.trim() === '' ? {} : { label: label.trim() }) },
      );
      onAuthed(res.username, { token: res.token, tokenId: res.tokenId, label: label.trim() || undefined });
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.status === 401) setError(t('auth.invalidCredentials'));
        else if (e.status === 409) setError(t('auth.usernameTaken'));
        else setError(e.message);
      } else {
        setError(t('auth.networkError'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="stack">
          <h1 className="visually-hidden">{t('auth.title')}</h1>
          <span className="auth__brand">{t('app.title')}</span>
          <p className="page-meta mono">{serverUrl}</p>
        </div>

        <div
          className="segmented"
          data-count={2}
          data-active={mode === 'login' ? 0 : 1}
          role="group"
          aria-label={t('auth.title')}
        >
          <span className="segmented__thumb" aria-hidden="true" />
          <button
            type="button"
            data-testid="auth-mode-login"
            aria-pressed={mode === 'login'}
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className="segmented__item"
          >
            {t('auth.login')}
          </button>
          <button
            type="button"
            data-testid="auth-mode-register"
            aria-pressed={mode === 'register'}
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className="segmented__item"
          >
            {t('auth.register')}
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
          {busy ? t('auth.busy') : mode === 'login' ? t('auth.login') : t('auth.register')}
        </button>
        <button type="button" onClick={onUseLocal} data-testid="auth-use-local" className="btn btn--block">
          {t('auth.useLocal')}
        </button>
      </div>
    </div>
  );
}
