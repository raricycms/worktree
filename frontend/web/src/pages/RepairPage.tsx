import { useCallback, useEffect, useState } from 'react';
import type { RepairDrop } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { useI18n } from '../i18n';

/**
 * Shown when the confirmed history no longer replays (entries stored before
 * a validation rule existed). The only repair is dropping those entries, so
 * the page lists exactly what would be removed and requires confirmation.
 */
export function RepairPage(props: { client: WorktreeClient }) {
  const { t } = useI18n();
  const { client } = props;
  const [drops, setDrops] = useState<RepairDrop[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const plan = useCallback(async (): Promise<void> => {
    setDrops(null);
    setLoadError(null);
    try {
      setDrops(await client.planRepair());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void plan();
  }, [plan]);

  const apply = async (): Promise<void> => {
    setApplying(true);
    setApplyError(null);
    try {
      await client.repairHistory();
      // On success the kernel clears the failure and emits; App unmounts us.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setApplyError(t('repair.error', { message }));
      setApplying(false);
      // The plan may have changed (e.g. the server history advanced): re-read it.
      void plan();
    }
  };

  // Recover from the server itself: replace this device's copy with the
  // server's history as-is. Nothing is dropped from the server.
  const adopt = async (): Promise<void> => {
    setApplying(true);
    setApplyError(null);
    try {
      await client.adoptServerHistory();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setApplyError(t('repair.adoptError', { message }));
    }
    setApplying(false);
    // A server history that itself needs a repair now lists its drops.
    void plan();
  };

  return (
    <div className="standalone">
      <header className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('repair.title')}</h1>
        </div>
      </header>

      <div className="page-body page-body--narrow">
        <div className="stack stack--lg">
          <p className="page-lead">{t('repair.explanation')}</p>

          {loadError !== null && (
            <div className="notice notice--danger">
              <p>{t('repair.loadError', { message: loadError })}</p>
              <div className="settings__actions">
                <button type="button" onClick={() => void plan()} className="btn btn--sm">
                  {t('repair.retry')}
                </button>
              </div>
            </div>
          )}

          {drops === null && loadError === null && (
            <p className="muted small">{t('repair.loading')}</p>
          )}

          {drops !== null && drops.length === 0 && (
            <section className="card">
              <div className="stack">
                <div className="notice notice--success">{t('repair.nothing')}</div>
                <p className="setting__hint">{t('repair.adoptHint')}</p>
                <div className="settings__actions">
                  <button
                    type="button"
                    disabled={applying}
                    onClick={() => void adopt()}
                    data-testid="repair-adopt"
                    className="btn btn--primary btn--sm"
                  >
                    {applying ? t('repair.adopting') : t('repair.adopt')}
                  </button>
                  <button type="button" onClick={() => void plan()} className="btn btn--sm">
                    {t('repair.retry')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {drops !== null && drops.length > 0 && (
            <>
              <section className="card">
                <div className="section-head">
                  <h2 className="section-title">{t('repair.entries', { n: drops.length })}</h2>
                </div>
                <div className="stack">
                  <ul className="stack">
                    {drops.map((drop) => (
                      <li key={drop.entry.id} className="card--quiet">
                        <p>{drop.description}</p>
                        <p className="mono tiny muted">
                          {drop.entry.id} — {drop.reason}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="notice notice--danger">{t('repair.warning')}</p>
                </div>
              </section>

              <div className="settings__actions">
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => void apply()}
                  data-testid="repair-apply"
                  className="btn btn--danger w-full sm:w-auto"
                >
                  {applying ? t('repair.applying') : t('repair.apply')}
                </button>
              </div>
            </>
          )}

          {applyError !== null && <div className="notice notice--danger">{applyError}</div>}
        </div>
      </div>
    </div>
  );
}
