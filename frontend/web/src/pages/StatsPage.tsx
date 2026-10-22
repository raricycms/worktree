import { useEffect, useState } from 'react';
import { computeStats } from '@worktree/core';
import type { Block, Node } from '@worktree/core';
import { useI18n } from '../i18n';

/** Re-render once a minute so time-based stats (overdue, missed) stay live. */
const REFRESH_MS = 60_000;

function pct(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

function fmtDays(days: number | null): string {
  return days === null ? '—' : `${Math.round(days)}d`;
}

interface StatItem {
  label: string;
  value: string;
}

interface StatGroup {
  heading: string;
  items: StatItem[];
}

export function StatsPage({ tree, blocks }: { tree: Node; blocks: Block[] }) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(interval);
  }, []);
  const stats = computeStats(tree, blocks, Date.now());

  const groups: StatGroup[] = [
    {
      heading: t('stats.nodesHeading'),
      items: [
        { label: t('stats.completed'), value: String(stats.nodes.completed) },
        { label: t('stats.incomplete'), value: String(stats.nodes.incomplete) },
        { label: t('stats.total'), value: String(stats.nodes.total) },
        { label: t('stats.completionRatio'), value: pct(stats.nodes.completionRatio) },
      ],
    },
    {
      heading: t('stats.remindersHeading'),
      items: [
        { label: t('stats.total'), value: String(stats.reminders.total) },
        { label: t('stats.remindersActive'), value: String(stats.reminders.active) },
        { label: t('stats.remindersMissed'), value: String(stats.reminders.missed) },
      ],
    },
    {
      heading: t('stats.blocksHeading'),
      items: [
        { label: t('stats.total'), value: String(stats.blocks.total) },
        { label: t('stats.completed'), value: String(stats.blocks.completed) },
        { label: t('stats.completionRatio'), value: pct(stats.blocks.completionRatio) },
        { label: t('stats.blocksLinked'), value: String(stats.blocks.linked) },
        { label: t('stats.blocksUpcoming7d'), value: `${Math.round(stats.blocks.upcoming7dHours)}h` },
      ],
    },
    {
      heading: t('stats.timingHeading'),
      items: [
        { label: t('stats.completionBuffer'), value: pct(stats.timing.completionBufferRatio) },
        { label: t('stats.blockBuffer'), value: pct(stats.timing.blockBufferRatio) },
        { label: t('stats.overdueIncomplete'), value: String(stats.timing.overdueIncomplete) },
        { label: t('stats.lateCompletionRatio'), value: pct(stats.timing.lateCompletionRatio) },
        { label: t('stats.completed7d'), value: String(stats.timing.completed7d) },
        { label: t('stats.completed30d'), value: String(stats.timing.completed30d) },
        { label: t('stats.avgIncompleteAge'), value: fmtDays(stats.timing.avgIncompleteAgeDays) },
        { label: t('stats.oldestIncomplete'), value: fmtDays(stats.timing.oldestIncompleteDays) },
      ],
    },
  ];

  return (
    <div className="page-wrap">
      <header className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('stats.title')}</h1>
        </div>
      </header>
      <div className="page-body">
        <div className="stat-groups">
          {groups.map((group) => (
            <section key={group.heading}>
              <div className="section-head">
                <h2 className="section-title">{group.heading}</h2>
              </div>
              <div className="stat-grid">
                {group.items.map((item) => (
                  <div key={item.label} className="stat">
                    <span className="stat__label">{item.label}</span>
                    <span className="stat__value">{item.value}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
