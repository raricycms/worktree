import { useState } from 'react';
import type { WorktreeClient } from '@worktree/client';
import { useI18n } from '../i18n';

/**
 * Sync state and the actions that change it. Status is never carried by the
 * dot alone: every state also names itself in text.
 */
export function StatusBar(props: {
  online: boolean;
  pendingCount: number;
  client: WorktreeClient;
  authFailed?: boolean;
  onRelogin?: () => void;
}) {
  const { t } = useI18n();
  const { online, pendingCount, client, authFailed = false, onRelogin } = props;
  const [reconnecting, setReconnecting] = useState(false);

  const pending = client.getPending();
  const removeCount = pending.filter((p) => p.kind === 'remove').length;
  const canUndo = pending.some((p) => p.kind === 'add') || client.getConfirmed().length > removeCount;

  const onReconnect = async (): Promise<void> => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await client.reconnect();
    } catch (e) {
      console.error('reconnect failed:', e);
    } finally {
      setReconnecting(false);
    }
  };

  const onUndo = (): void => {
    try {
      client.undo();
    } catch (e) {
      console.error('undo failed:', e);
    }
  };

  if (authFailed) {
    return (
      <div className="status">
        <span className="status__state" data-state="unauthorized">
          <span className="status__dot" aria-hidden />
          <span>{t('status.unauthorized')}</span>
        </span>
        {onRelogin !== undefined && (
          <button type="button" onClick={onRelogin} data-testid="status-relogin" className="btn btn--sm">
            {t('status.loginAgain')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="status">
      {/* The local user never connects, so "offline" and its danger dot would
          report a failure where the mode simply is offline-only. */}
      <span
        className="status__state"
        data-state={client.isLocal() ? 'local' : online ? 'online' : 'offline'}
      >
        <span className="status__dot" aria-hidden />
        <span>{client.isLocal() ? t('status.local') : online ? t('status.online') : t('status.offline')}</span>
      </span>
      {pendingCount > 0 && (
        <span className="pill pill--brand" data-testid="status-pending">
          {t('status.pending', { n: pendingCount })}
        </span>
      )}
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        data-testid="status-undo"
        className="btn btn--sm"
      >
        {t('status.undo')}
      </button>
      {!online && !client.isLocal() && (
        <button
          type="button"
          onClick={() => void onReconnect()}
          disabled={reconnecting}
          data-testid="status-reconnect"
          className="btn btn--sm btn--primary"
        >
          {reconnecting ? t('status.reconnecting') : t('status.reconnect')}
        </button>
      )}
    </div>
  );
}
