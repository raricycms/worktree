import { useMemo, useState } from 'react';
import type { Block, BlockOccurrence, Node } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import type { DisplayPrefs } from '../config';
import { useI18n } from '../i18n';
import { weekdayNames } from '../weekdays';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { findNode } from '../tree-utils';
import {
  DAY_MS,
  DEFAULT_PX_PER_HOUR,
  HOUR_GUTTER_PX,
  MIN_PX_PER_HOUR,
  blockColor,
  dayOffsetCalc,
  dayStartMs,
  dayWidthCalc,
  formatDateInput,
  formatDayHeader,
  formatHourLabel,
  isToday,
  layoutBlocks,
  parseDateInput,
} from '../calendar-utils';
import { BlockDetailPanel } from '../components/BlockDetailPanel';
import { RuleDetailPanel, ruleSummary } from '../components/RuleDetailPanel';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from '../components/icons';

/** Nominal canvas height used by layoutBlocks; the render normalizes to %. */
const DAY_PX = 24 * DEFAULT_PX_PER_HOUR;

/** What the grid draws: a real block or a derived rule occurrence. */
type GridEntry =
  | { kind: 'block'; id: string; start: number; end: number; block: Block }
  | { kind: 'occurrence'; id: string; start: number; end: number; occ: BlockOccurrence };

type Editing =
  | { mode: 'add' }
  | { mode: 'edit'; id: string }
  | { mode: 'add-rule' }
  | { mode: 'rule'; ruleId: string; day?: number };

export function CalendarPage(props: {
  client: WorktreeClient;
  tree: Node;
  display: DisplayPrefs;
  calendarDays: number;
  /** Test seam; defaults to the real clock. */
  nowMs?: number;
}) {
  const { t } = useI18n();
  const weekdays = weekdayNames(t);
  const { client, tree, display, calendarDays, nowMs = Date.now() } = props;
  // Matches the shared workbench breakpoint: below it the detail panel is a
  // bottom sheet, above it the sticky side column.
  const isMobile = useMediaQuery('(max-width: 991px)');
  const [anchor, setAnchor] = useState<number>(() => dayStartMs(nowMs));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  const blocks = client.getBlocks();
  const rules = client.getRules();
  // Blocks and occurrences share one lane pool, so a rule never hides a block.
  const entries = useMemo(() => {
    const blockEntries: GridEntry[] = blocks.map((block) => ({
      kind: 'block',
      id: block.id,
      start: block.start,
      end: block.end,
      block,
    }));
    const occurrenceEntries: GridEntry[] = client
      .expandOccurrences(anchor, anchor + calendarDays * DAY_MS)
      .map((occ) => ({ kind: 'occurrence', id: occ.id, start: occ.occStart, end: occ.occEnd, occ }));
    return [...blockEntries, ...occurrenceEntries];
  }, [blocks, client, anchor, calendarDays]);
  const bars = useMemo(() => layoutBlocks(entries, anchor, calendarDays), [entries, anchor, calendarDays]);
  const days = useMemo(
    () => Array.from({ length: calendarDays }, (_, i) => anchor + i * DAY_MS),
    [anchor, calendarDays],
  );
  // Static marker for "now"; null while today is outside the visible window.
  const nowLine = useMemo(() => {
    if (nowMs < anchor || nowMs >= anchor + calendarDays * DAY_MS) return null;
    const dayIndex = Math.floor((nowMs - anchor) / DAY_MS);
    return {
      top: `${((nowMs - anchor - dayIndex * DAY_MS) / DAY_MS) * 100}%`,
      left: dayOffsetCalc(dayIndex / calendarDays),
      width: dayWidthCalc(1 / calendarDays),
    };
  }, [anchor, calendarDays, nowMs]);

  const editBlock = editing?.mode === 'edit' ? (blocks.find((b) => b.id === editing.id) ?? null) : null;
  const editRule =
    editing?.mode === 'rule' ? (rules.find((r) => r.id === editing.ruleId) ?? null) : null;
  const editRuleDay = editing?.mode === 'rule' ? editing.day : undefined;

  const nav = (delta: number): void => setAnchor((a) => a + delta * DAY_MS);

  const detailPanel =
    editBlock !== null ? (
      <BlockDetailPanel
        key={editBlock.id}
        bare
        block={editBlock}
        client={client}
        tree={tree}
        display={display}
        nowMs={nowMs}
        onClose={() => setEditing(null)}
      />
    ) : editRule !== null ? (
      <RuleDetailPanel
        key={editRule.id}
        bare
        rule={editRule}
        day={editRuleDay}
        client={client}
        nowMs={nowMs}
        onClose={() => setEditing(null)}
      />
    ) : null;

  return (
    <div className="page-wrap">
      <div className="page-head">
        <div className="page-head__inner">
          <h1 className="page-title">{t('tabs.calendar')}</h1>
        </div>
      </div>

      <div className="page-body">
        <div className="cal-page">
          <div className="cal-toolbar">
            <button
              type="button"
              data-testid="calendar-prev"
              aria-label={t('calendar.prev')}
              onClick={() => nav(-1)}
              className="btn btn--sm"
            >
              <ChevronLeftIcon className="icon icon--sm" />
              {isMobile ? '' : t('calendar.prev')}
            </button>
            <button
              type="button"
              data-testid="calendar-today"
              onClick={() => setAnchor(dayStartMs(nowMs))}
              className="btn btn--sm"
            >
              {t('calendar.today')}
            </button>
            <button
              type="button"
              data-testid="calendar-next"
              aria-label={t('calendar.next')}
              onClick={() => nav(1)}
              className="btn btn--sm"
            >
              {isMobile ? '' : t('calendar.next')}
              <ChevronRightIcon className="icon icon--sm" />
            </button>
            <input
              type="date"
              data-testid="calendar-date"
              aria-label={t('calendar.jumpToDay')}
              value={formatDateInput(anchor)}
              onChange={(e) => {
                const ms = parseDateInput(e.target.value);
                if (ms !== null) setAnchor(ms);
              }}
              className="input input--compact w-auto"
            />
            <div className="spacer" />
            <button
              type="button"
              data-testid="calendar-rules"
              onClick={() => {
                setEditing(null);
                setRulesOpen(true);
              }}
              className="btn btn--sm"
            >
              {t('rule.listTitle')}
            </button>
            <button
              type="button"
              data-testid="calendar-add-rule"
              onClick={() => setEditing({ mode: 'add-rule' })}
              className="btn btn--sm btn--primary"
            >
              + {t('rule.add')}
            </button>
            <button
              type="button"
              data-testid="calendar-add"
              onClick={() => setEditing({ mode: 'add' })}
              className="btn btn--sm btn--primary"
            >
              + {t('calendar.add')}
            </button>
          </div>

          <div className="workbench">
            <div className="workbench__main">
              <div className="cal">
                <div className="cal__canvas">
                  {/* The day head is the canvas's first child so it and the grid
                      share one content box; outside the canvas the card padding
                      and the scrollbar gutter offset it from the day columns. */}
                  <div className="cal__head">
                    <div className="cal__gutter" />
                    {days.map((d) => (
                      <div
                        key={d}
                        className="cal__dayhead"
                        data-today={isToday(d, nowMs) ? 'true' : 'false'}
                      >
                        {formatDayHeader(d, weekdays)}
                      </div>
                    ))}
                  </div>

                  {/* The canvas fills the available space, but hour rows never shrink
                      below MIN_PX_PER_HOUR — the day scrolls when the space is short.
                      The day columns share the width evenly (fewer days → wider). */}
                  <div className="cal__canvas-inner" style={{ minHeight: 24 * MIN_PX_PER_HOUR }}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h}>
                        <div
                          className="cal__hourline"
                          data-first={h === 0 ? 'true' : 'false'}
                          style={{ top: `${(h / 24) * 100}%` }}
                        />
                        <div
                          className="cal__hourlabel"
                          style={{ top: `${(h / 24) * 100}%`, left: 0, width: HOUR_GUTTER_PX - 4 }}
                        >
                          {formatHourLabel(h)}
                        </div>
                      </div>
                    ))}
                    {days.slice(1).map((d, i) => (
                      <div
                        key={d}
                        className="cal__daydivider"
                        style={{ left: dayOffsetCalc((i + 1) / calendarDays) }}
                      />
                    ))}
                    {days.map((d, i) =>
                      isToday(d, nowMs) ? (
                        <div
                          key={d}
                          className="cal__today"
                          style={{
                            left: dayOffsetCalc(i / calendarDays),
                            width: dayWidthCalc(1 / calendarDays),
                          }}
                        />
                      ) : null,
                    )}
                    {nowLine !== null && <div className="cal__now" style={nowLine} />}
                    {bars.map((bar) => {
                      const entry = bar.item;
                      const geometry = {
                        top: `${(bar.topPx / DAY_PX) * 100}%`,
                        height: `${(bar.heightPx / DAY_PX) * 100}%`,
                        // Each lane occupies 1/lanes of the day column; the old
                        // `1 - lane/lanes` width made lane 0 span the whole column.
                        left: dayOffsetCalc((bar.dayIndex + bar.lane / bar.lanes) / calendarDays),
                        width: dayWidthCalc(1 / bar.lanes / calendarDays),
                      };
                      if (entry.kind === 'block') {
                        const linked =
                          entry.block.nodeId !== undefined ? findNode(tree, entry.block.nodeId) : undefined;
                        const selected = editing?.mode === 'edit' && editing.id === bar.id;
                        return (
                          <button
                            key={`${bar.id}#${bar.dayIndex}`}
                            type="button"
                            data-testid={`block-${bar.id}`}
                            data-selected={selected ? 'true' : 'false'}
                            data-completed={entry.block.status ? 'true' : 'false'}
                            onClick={() => setEditing({ mode: 'edit', id: bar.id })}
                            title={entry.block.name + (linked ? ` · ${linked.name}` : '')}
                            className="cal-bar"
                            style={{
                              ...geometry,
                              backgroundColor: blockColor(bar.id),
                            }}
                          >
                            <span className="cal-bar__name">{entry.block.name}</span>
                            {linked !== undefined && <span className="cal-bar__link">{linked.name}</span>}
                          </button>
                        );
                      }
                      const selected =
                        editing?.mode === 'rule' &&
                        editing.ruleId === entry.occ.ruleId &&
                        editing.day === entry.occ.day;
                      return (
                        <button
                          key={`${bar.id}#${bar.dayIndex}`}
                          type="button"
                          data-testid={`occurrence-${bar.id}`}
                          data-selected={selected ? 'true' : 'false'}
                          data-completed="false"
                          onClick={() =>
                            setEditing({ mode: 'rule', ruleId: entry.occ.ruleId, day: entry.occ.day })
                          }
                          title={entry.occ.name}
                          className="cal-bar"
                          style={{ ...geometry, backgroundColor: blockColor(entry.occ.ruleId) }}
                        >
                          <span className="cal-bar__name">{entry.occ.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {!isMobile && (
              <div className="workbench__side">
                <div className="card">
                  {detailPanel ?? <p className="muted small">{t('calendar.hint')}</p>}
                </div>
              </div>
            )}
          </div>

          {isMobile && detailPanel !== null && (
            <div className="sheet">
              <div className="sheet__handle" />
              {detailPanel}
            </div>
          )}
        </div>
      </div>

      {editing?.mode === 'add' && (
        <div data-testid="block-modal" className="modal" onClick={() => setEditing(null)}>
          <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
            <BlockDetailPanel
              bare
              block={null}
              client={client}
              tree={tree}
              display={display}
              nowMs={nowMs}
              onClose={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {editing?.mode === 'add-rule' && (
        <div data-testid="rule-modal" className="modal" onClick={() => setEditing(null)}>
          <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
            <RuleDetailPanel bare rule={null} client={client} nowMs={nowMs} onClose={() => setEditing(null)} />
          </div>
        </div>
      )}

      {rulesOpen && (
        <div data-testid="rule-list-modal" className="modal" onClick={() => setRulesOpen(false)}>
          <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2 className="section-title">{t('rule.listTitle')}</h2>
              <button
                type="button"
                data-testid="rule-list-close"
                aria-label={t('calendar.close')}
                onClick={() => setRulesOpen(false)}
                className="btn btn--icon btn--sm"
              >
                <XIcon className="icon" />
              </button>
            </div>
            {rules.length === 0 ? (
              <p className="muted small">{t('rule.listEmpty')}</p>
            ) : (
              <ul className="rule-list">
                {rules.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      data-testid={`rule-list-${r.id}`}
                      onClick={() => {
                        setRulesOpen(false);
                        setEditing({ mode: 'rule', ruleId: r.id });
                      }}
                      className="rule-item"
                    >
                      <span className="node-name">
                        {r.name}
                        {r.active ? '' : ` · ${t('rule.off')}`}
                      </span>
                      <span className="tiny muted">{ruleSummary(r, t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
