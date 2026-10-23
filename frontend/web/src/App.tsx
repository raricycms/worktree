import { useEffect, useState } from 'react';
import { isRecord } from '@worktree/core';
import { AppConfig, LOCAL_USER, clearToken, loadConfig, loadToken, saveConfig, saveToken, stateKey } from './config';
import type { StoredToken } from './config';
import { useWorktreeClient } from './hooks/useWorktreeClient';
import { I18nProvider, useI18n } from './i18n';
import { FilterProvider } from './filter-context';
import { captureParamText, stripCaptureParams } from './capture-params';
import { watchTheme } from './theme';
import { QuickCapture } from './components/QuickCapture';
import { StatusBar } from './components/StatusBar';
import { Tabs } from './components/Tabs';
import { TreePage } from './pages/TreePage';
import { CalendarPage } from './pages/CalendarPage';
import { StatsPage } from './pages/StatsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ConflictPage } from './pages/ConflictPage';
import { RepairPage } from './pages/RepairPage';
import { AuthPage } from './pages/AuthPage';
import { FirstRunPage } from './pages/FirstRunPage';
import { AgentPage } from './pages/AgentPage';

export type Tab = 'tree' | 'calendar' | 'agent' | 'stats' | 'settings';

/** `?tab=` opens a page directly (notifications, bookmarks, home-screen links). */
function tabFromLocation(): Tab {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (raw === 'tree' || raw === 'calendar' || raw === 'agent' || raw === 'stats' || raw === 'settings') {
    return raw;
  }
  return 'tree';
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(loadConfig);
  const [tab, setTab] = useState<Tab>(tabFromLocation);
  const [clientEpoch, setClientEpoch] = useState(0);
  // Explicitly requested login screen ("log in another user"); the only way
  // to reach the auth page while a valid token exists.
  const [showAuth, setShowAuth] = useState(false);
  // First-run offers both entry points; the account button starts at register.
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  const token = config.user === LOCAL_USER ? null : loadToken(config.serverUrl, config.user)?.token ?? null;

  const { snap, error } = useWorktreeClient({
    serverUrl: config.serverUrl,
    user: config.user,
    token,
    epoch: clientEpoch,
  });

  useEffect(() => watchTheme(config.theme), [config.theme]);

  const updateConfig = (patch: Partial<AppConfig>): void => {
    const next = { ...config, ...patch };
    saveConfig(next);
    setConfig(next);
  };

  const clearCache = (): void => {
    try {
      localStorage.removeItem(stateKey(config.serverUrl, config.user));
    } catch (e) {
      console.error('failed to clear cache:', e);
    }
    setClientEpoch((e) => e + 1);
  };

  const onAuthed = (username: string, stored: StoredToken): void => {
    // The server-confirmed username is authoritative: the user may have typed
    // a different name than config.user, and the token belongs to the former.
    saveToken(config.serverUrl, username, stored);
    updateConfig({ user: username, onboarded: true });
    setShowAuth(false);
    setClientEpoch((e) => e + 1);
  };

  /** After logout (or a revoked-token relogin): back to the offline user. */
  const logout = (): void => {
    clearToken(config.serverUrl, config.user);
    // The identity choice is already made; do not show the first-run screen
    // again for someone who just chose to work offline.
    updateConfig({ user: LOCAL_USER, onboarded: true });
    setClientEpoch((e) => e + 1);
  };

  /** The current token is dead: clear it and ask for fresh credentials. */
  const relogin = (): void => {
    clearToken(config.serverUrl, config.user);
    setShowAuth(true);
    setClientEpoch((e) => e + 1);
  };

  if (error) {
    return <ErrorScreen message={error} lang={config.lang} />;
  }

  const needsAuth = config.user !== LOCAL_USER && token === null;
  if (needsAuth || showAuth) {
    return (
      <I18nProvider lang={config.lang}>
        <AuthPage
          serverUrl={config.serverUrl}
          user={config.user}
          initialMode={authMode}
          localDataCount={config.user === LOCAL_USER ? (snap?.client.getConfirmed().length ?? 0) : 0}
          onAuthed={onAuthed}
          onUseLocal={() => {
            updateConfig({ user: LOCAL_USER, onboarded: true });
            setShowAuth(false);
          }}
        />
      </I18nProvider>
    );
  }
  if (!snap) return null;

  // A fresh browser starts as the offline `local` user with no data. The
  // choice renders inside the shell so quick capture and topbar links keep
  // working while it is open.
  const firstRun = config.user === LOCAL_USER && !config.onboarded && snap.tree.children.length === 0;

  return (
    <I18nProvider lang={config.lang}>
      {snap.replayFailure !== null ? (
        <RepairPage client={snap.client} />
      ) : snap.conflict !== null ? (
        <ConflictPage conflict={snap.conflict} client={snap.client} display={config.display} />
      ) : (
        <FilterProvider
          filter={config.filter}
          mode={config.display.filterMode}
          setFilter={(f) => updateConfig({ filter: f })}
          setMode={(m) => updateConfig({ display: { ...config.display, filterMode: m } })}
        >
          <Shell
            config={config}
            tab={tab}
            setTab={setTab}
            snap={snap}
            updateConfig={updateConfig}
            clearCache={clearCache}
            onLogout={logout}
            onLoginOther={() => {
              setAuthMode('login');
              setShowAuth(true);
            }}
            firstRun={firstRun}
            onFirstRunAccount={() => {
              setAuthMode('register');
              setShowAuth(true);
            }}
            onFirstRunLogin={() => {
              setAuthMode('login');
              setShowAuth(true);
            }}
            onFirstRunStayLocal={() => updateConfig({ onboarded: true })}
          />
        </FilterProvider>
      )}
    </I18nProvider>
  );
}

function Shell(props: {
  config: AppConfig;
  tab: Tab;
  setTab: (tab: Tab) => void;
  snap: NonNullable<ReturnType<typeof useWorktreeClient>['snap']>;
  updateConfig: (patch: Partial<AppConfig>) => void;
  clearCache: () => void;
  onLogout: () => void;
  onLoginOther: () => void;
  /** No identity choice has been made yet: the tree tab shows it instead. */
  firstRun: boolean;
  onFirstRunAccount: () => void;
  onFirstRunLogin: () => void;
  onFirstRunStayLocal: () => void;
}) {
  const { t } = useI18n();
  const {
    config,
    tab,
    setTab,
    snap,
    updateConfig,
    clearCache,
    onLogout,
    onLoginOther,
    firstRun,
    onFirstRunAccount,
    onFirstRunLogin,
    onFirstRunStayLocal,
  } = props;
  const { client, tree, online, pendingCount, authFailed, storageFailure } = snap;

  // Deep link from a notification click: ?node=<id> on first load, or a
  // worktree-open-node message from the service worker while running.
  const [initialNodeId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('node'),
  );
  const [focusNode, setFocusNode] = useState<{ id: string; nonce: number } | null>(null);

  // Capture entry: ?quick=1 (PWA shortcut) or the Android share target's
  // text/title/url params open the overlay on first load; ⌘K/Ctrl+K opens it
  // from anywhere. The link params are dropped once read, so a reload does not
  // capture twice.
  const [initialQuickText] = useState<string | null>(() => captureParamText(window.location.search));
  const [quickText, setQuickText] = useState(initialQuickText ?? '');
  const [quickOpen, setQuickOpen] = useState(initialQuickText !== null);
  // Closing consumes the link's text: the next ⌘K opens empty.
  const closeQuick = (): void => {
    setQuickOpen(false);
    setQuickText('');
  };

  useEffect(() => {
    if (initialQuickText !== null) stripCaptureParams();
  }, [initialQuickText]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.repeat && !e.isComposing) {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // event.data is attacker-influenced (any page can postMessage); guard it.
      if (!isRecord(event.data)) return;
      const data = event.data;
      if (data.type !== 'worktree-open-node' || typeof data.url !== 'string') return;
      const node = new URL(data.url, window.location.origin).searchParams.get('node');
      if (node === null) return;
      setTab('tree');
      setFocusNode({ id: node, nonce: Date.now() });
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [setTab]);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        {t('app.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <span className="brand">{t('app.title')}</span>
          <Tabs active={tab} onChange={setTab} />
          <div className="topbar__actions">
            {config.user === LOCAL_USER && tree.children.length > 0 && (
              <button
                type="button"
                onClick={() => setTab('settings')}
                data-testid="save-work"
                title={t('firstRun.saveWorkHint')}
                className="btn btn--sm"
              >
                {t('firstRun.saveWork')}
              </button>
            )}
            <StatusBar
              online={online}
              pendingCount={pendingCount}
              client={client}
              authFailed={authFailed}
              onRelogin={onLogout}
            />
          </div>
        </div>
      </header>
      {storageFailure !== null && (
        <div className="app__banner">
          <div data-testid="storage-failure" role="alert" className="notice notice--danger">
            <span className="notice__title">{t('status.storageFailed')}</span>{' '}
            <span>{storageFailure.message}</span>
          </div>
        </div>
      )}
      <main className="app__main" id="main-content">
        {tab === 'tree' && !firstRun && (
          <TreePage
            tree={tree}
            client={client}
            display={config.display}
            updateConfig={updateConfig}
            initialNodeId={initialNodeId ?? undefined}
            focusNode={focusNode}
            autoReminder={config.autoReminder}
          />
        )}
        {tab === 'tree' && firstRun && (
          <FirstRunPage
            onCreateAccount={onFirstRunAccount}
            onLogin={onFirstRunLogin}
            onStayLocal={onFirstRunStayLocal}
          />
        )}
        {tab === 'calendar' && (
          <CalendarPage
            client={client}
            tree={tree}
            display={config.display}
            calendarDays={config.calendarDays}
          />
        )}
        {tab === 'agent' && (
          <AgentPage
            client={client}
            config={config}
            updateConfig={updateConfig}
            onOpenSettings={() => setTab('settings')}
          />
        )}
        {tab === 'stats' && <StatsPage tree={tree} blocks={client.getBlocks()} />}
        {tab === 'settings' && (
          <SettingsPage
            config={config}
            client={client}
            tree={tree}
            updateConfig={updateConfig}
            onClearCache={clearCache}
            onLogout={onLogout}
            onLoginOther={onLoginOther}
          />
        )}
      </main>
      {quickOpen && (
        <QuickCapture
          client={client}
          path={config.quickAddPath}
          initialText={quickText}
          onClose={closeQuick}
        />
      )}
    </div>
  );
}

function ErrorScreen({ message, lang }: { message: string; lang: string }) {
  return (
    <I18nProvider lang={lang}>
      <ErrorScreenBody message={message} />
    </I18nProvider>
  );
}

function ErrorScreenBody({ message }: { message: string }) {
  const { t } = useI18n();
  const [user, setUser] = useState('');
  const [serverUrl, setServerUrl] = useState('');

  const recover = (): void => {
    const current = loadConfig();
    saveConfig({
      ...current,
      user: user.trim() === '' ? LOCAL_USER : user.trim(),
      serverUrl: serverUrl.trim() === '' ? current.serverUrl : serverUrl.trim(),
    });
    window.location.reload();
  };

  return (
    <div className="auth">
      <div className="auth__panel">
        <div className="notice notice--danger">
          <p className="notice__title">{t('recover.title')}</p>
          <p className="tiny">{message}</p>
        </div>
        <div className="form">
          <label className="field">
            <span className="field__label">{t('recover.username')}</span>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={loadConfig().user}
              className="input"
            />
          </label>
          <label className="field">
            <span className="field__label">{t('recover.serverUrl')}</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={loadConfig().serverUrl}
              className="input"
            />
          </label>
        </div>
        <button type="button" onClick={recover} className="btn btn--primary btn--block">
          {t('recover.apply')}
        </button>
      </div>
    </div>
  );
}
