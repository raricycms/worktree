import { useEffect, useId, useState } from 'react';
import type { Node } from '@worktree/core';
import { useI18n } from '../i18n';
import type { Translate } from '../i18n';
import { dueToday } from '../today';
import type { RelativeTime } from '../today';
import { ChevronDownIcon } from './icons';
import { CompletionCheckbox } from './TreeNode';

/** Re-render once a minute so the relative labels stay live. */
const REFRESH_MS = 60_000;

function relativeLabel(t: Translate, relative: RelativeTime): string {
  const unit =
    relative.unit === 'days'
      ? t('today.days', { n: relative.amount })
      : relative.unit === 'hours'
        ? t('today.hours', { n: relative.amount })
        : t('today.minutes', { n: relative.amount });
  return relative.kind === 'overdue'
    ? t('today.overdueBy', { time: unit })
    : t('today.dueIn', { time: unit });
}

/**
 * The daily loop above the tree: open nodes due today or earlier, earliest
 * first. It is deliberately local state (open/closed) and a local clock; it
 * never writes configuration. `nowMs` is a test seam, as in CalendarPage.
 */
export function TodaySection(props: {
  tree: Node;
  onSelect: (id: string) => void;
  /** Same children-first completion handler the tree rows use. */
  onToggleComplete?: (id: string) => void;
  /** Test seam; defaults to the real clock. */
  nowMs?: number;
}) {
  const { t } = useI18n();
  const { tree, onSelect, onToggleComplete, nowMs } = props;
  const [open, setOpen] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const headingId = useId();
  const panelId = useId();

  useEffect(() => {
    if (nowMs !== undefined) return;
    const interval = setInterval(() => setClock(Date.now()), REFRESH_MS);
    return () => clearInterval(interval);
  }, [nowMs]);

  const entries = dueToday(tree, nowMs ?? clock);

  return (
    <section className="card today" data-testid="today-section" aria-labelledby={headingId}>
      <div className="section-head today__head">
        <h2 className="section-title" id={headingId}>
          {t('today.title')}
        </h2>
        <div className="today__meta">
          <span className="pill mono today__count" data-testid="today-count">
            {t('today.count', { n: entries.length })}
          </span>
          <button
            type="button"
            className="btn btn--icon today__toggle"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? t('tree.collapse') : t('tree.expand')}
            data-testid="today-toggle"
            onClick={() => setOpen(!open)}
          >
            <ChevronDownIcon className="icon icon--sm" />
          </button>
        </div>
      </div>
      <div
        id={panelId}
        className={open ? 'today__panel is-open' : 'today__panel'}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="today__clip">
          <div className="today__content">
            {entries.length === 0 ? (
              <p className="empty today__empty">{t('today.empty')}</p>
            ) : (
              <ul className="today__list">
                {entries.map((entry) => (
                  <li
                    key={entry.node.id}
                    className="today__row"
                    data-node-id={entry.node.id}
                    data-testid={`today-row-${entry.node.id}`}
                  >
                    {onToggleComplete !== undefined && (
                      <CompletionCheckbox
                        id={entry.node.id}
                        completed={false}
                        testId={`today-complete-${entry.node.id}`}
                        onChange={() => onToggleComplete(entry.node.id)}
                      />
                    )}
                    <button
                      type="button"
                      className="today__label"
                      data-testid={`today-label-${entry.node.id}`}
                      onClick={() => onSelect(entry.node.id)}
                    >
                      <span className="node-name">{entry.node.name}</span>
                    </button>
                    {entry.relative.kind === 'overdue' && (
                      <span className="pill today__overdue">{t('today.overdue')}</span>
                    )}
                    <span
                      className="today__time mono tiny"
                      data-testid={`today-time-${entry.node.id}`}
                    >
                      {relativeLabel(t, entry.relative)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
