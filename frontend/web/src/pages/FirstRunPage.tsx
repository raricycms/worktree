import { useI18n } from '../i18n';

/**
 * The identity choice shown in the tree tab when a fresh browser starts in the
 * offline workspace. It is deliberately part of the shell (not a blocking
 * screen): quick capture, a share-target link and the topbar still work while
 * the user decides, and the choice only disappears once it is made.
 */
export function FirstRunPage(props: {
  onCreateAccount: () => void;
  onLogin: () => void;
  onStayLocal: () => void;
}) {
  const { t } = useI18n();
  const { onCreateAccount, onLogin, onStayLocal } = props;
  return (
    <div className="page-wrap">
      <div className="page-body page-body--narrow">
        <div className="stack stack--lg">
          <header>
            <h1 className="page-title">{t('firstRun.title')}</h1>
            <p className="page-meta">{t('firstRun.lead')}</p>
          </header>

          <div className="card">
            <div className="stack">
              <div>
                <p className="small">
                  <strong>{t('firstRun.localTitle')}</strong>
                </p>
                <p className="tiny muted">{t('firstRun.localBody')}</p>
              </div>
              <div>
                <p className="small">
                  <strong>{t('firstRun.accountTitle')}</strong>
                </p>
                <p className="tiny muted">{t('firstRun.accountBody')}</p>
              </div>
            </div>
            <div className="settings__actions">
              <button
                type="button"
                onClick={onCreateAccount}
                data-testid="first-run-account"
                className="btn btn--primary"
              >
                {t('firstRun.createAccount')}
              </button>
              <button
                type="button"
                onClick={onLogin}
                data-testid="first-run-login"
                className="btn"
              >
                {t('firstRun.login')}
              </button>
              <button
                type="button"
                onClick={onStayLocal}
                data-testid="first-run-offline"
                className="btn btn--link"
              >
                {t('firstRun.stayOffline')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
