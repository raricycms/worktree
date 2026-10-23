import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { newId } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import { WEEKDAYS, analyzeTimetableRows } from '@worktree/agent';
import type { Semester, TimetableRow, TimetableRowView, Weekday } from '@worktree/agent';
import { useI18n } from '../../i18n';
import type { Translate } from '../../i18n';
import type { ChatArtifact } from '../../agent/conversations';
import { Calendar, Plus, Trash } from './icons';
import { SemesterFields } from './SemesterFields';

const MINUTE_MS = 60 * 1000;

const DATE_SOURCE = String.raw`\d{4}-\d{2}-\d{2}`;
const RANGE_SOURCE = String.raw`\d{2}:\d{2}-\d{2}:\d{2}`;
const MORE_SOURCE = String.raw`(?: \(\+(\d+) more\))?`;

/** ISO weekday (Monday = 1) to the shared Sunday-first display catalogue. */
const WEEKDAY_LABEL_KEYS: Record<Weekday, string> = {
  1: 'weekday.mon',
  2: 'weekday.tue',
  3: 'weekday.wed',
  4: 'weekday.thu',
  5: 'weekday.fri',
  6: 'weekday.sat',
  7: 'weekday.sun',
};

function deviceTzOffsetMs(): number {
  return -new Date().getTimezoneOffset() * MINUTE_MS;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWeekday(value: string): Weekday {
  const weekday = Number(value);
  if (weekday === 1 || weekday === 2 || weekday === 3 || weekday === 4 || weekday === 5 || weekday === 6 || weekday === 7) {
    return weekday;
  }
  throw new Error(`invalid weekday: ${value}`);
}

function newRow(): TimetableRow {
  return { id: newId(), course: '', weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' };
}

function group(value: string | undefined): string {
  return value ?? '';
}

/**
 * `analyzeTimetableRows` reports conflicts as English sentences (it has no
 * locale). The card is their only consumer, so they are translated here; a
 * shape this function does not know falls back to the original sentence rather
 * than hiding a real problem.
 */
export function localizeConflict(text: string, t: Translate): string {
  const block = new RegExp(
    `^overlaps existing block "(.+)" on (${DATE_SOURCE}) (${RANGE_SOURCE})${MORE_SOURCE}$`,
  ).exec(text);
  if (block !== null) {
    return t('agent.timetable.conflict.block', {
      name: group(block[1]),
      date: group(block[2]),
      range: group(block[3]),
      more: group(block[4]) === '' ? '' : t('agent.timetable.conflict.more', { n: group(block[4]) }),
    });
  }
  const rule = new RegExp(
    `^overlaps existing rule "(.+)" on (${DATE_SOURCE}) (${RANGE_SOURCE})${MORE_SOURCE}$`,
  ).exec(text);
  if (rule !== null) {
    return t('agent.timetable.conflict.rule', {
      name: group(rule[1]),
      date: group(rule[2]),
      range: group(rule[3]),
      more: group(rule[4]) === '' ? '' : t('agent.timetable.conflict.more', { n: group(rule[4]) }),
    });
  }
  const preview = new RegExp(`^overlaps "(.+)" (${RANGE_SOURCE}) \\(weeks (.+)\\)$`).exec(text);
  if (preview !== null) {
    return t('agent.timetable.conflict.row', {
      name: group(preview[1]),
      time: group(preview[2]),
      weeks: group(preview[3]),
    });
  }
  const outsideOne = /^week (\d+) is outside the semester \(1\.\.(\d+)\)$/.exec(text);
  if (outsideOne !== null) {
    return t('agent.timetable.conflict.outsideOne', { week: group(outsideOne[1]), total: group(outsideOne[2]) });
  }
  const outsideMany = /^weeks (.+) are outside the semester \(1\.\.(\d+)\)$/.exec(text);
  if (outsideMany !== null) {
    return t('agent.timetable.conflict.outsideMany', { weeks: group(outsideMany[1]), total: group(outsideMany[2]) });
  }
  const invalidWeeks = /^invalid weeks "(.+)": .+$/.exec(text);
  if (invalidWeeks !== null) {
    return t('agent.timetable.conflict.invalidWeeks', { spec: group(invalidWeeks[1]) });
  }
  const invalidTime = /^invalid (start|end) time "(.+)" \(expected HH:mm\)$/.exec(text);
  if (invalidTime !== null) {
    const field = invalidTime[1] === 'start' ? t('agent.timetable.column.start') : t('agent.timetable.column.end');
    return t('agent.timetable.conflict.invalidTime', { field, value: group(invalidTime[2]) });
  }
  if (text.startsWith('invalid semester: ')) return t('agent.timetable.conflict.invalidSemester');
  return text;
}

/**
 * The editable timetable preview inside the chat. It only edits rows; nothing
 * is written until the page's `onConfirm` runs `rowsToRules` + `applyMany`, and
 * a rejected confirm leaves the card editable with the error inline.
 */
export function TimetableCard({
  artifact,
  semester,
  onSemesterChange,
  disabled = false,
  onConfirm,
  onCancel,
  client,
}: {
  artifact: ChatArtifact;
  semester: Semester | null;
  onSemesterChange: (semester: Semester | null) => void;
  disabled?: boolean;
  onConfirm: (rows: TimetableRow[]) => void | Promise<void>;
  onCancel: () => void;
  client: WorktreeClient;
}): ReactElement {
  const { t } = useI18n();
  const [rows, setRows] = useState<TimetableRow[]>(artifact.rows);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setRows(artifact.rows);
    setError(null);
    setConfirming(false);
  }, [artifact]);

  const tzOffset = useMemo(deviceTzOffsetMs, []);

  const viewById = useMemo(() => {
    if (semester === null) return new Map<string, TimetableRowView>();
    const views = analyzeTimetableRows(rows, { semester, tzOffset, state: client.planningState() });
    return new Map(views.map((view) => [view.row.id, view]));
  }, [rows, semester, tzOffset, client]);

  const updateRow = (id: string, patch: Partial<TimetableRow>): void => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    setRows((current) => [...current, newRow()]);
  };

  const removeRow = (id: string): void => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const confirm = (): void => {
    if (semester === null || disabled || confirming) return;
    setError(null);
    setConfirming(true);
    void (async () => {
      try {
        await onConfirm(rows);
      } catch (cause) {
        setError(t('agent.error.generic', { message: messageOf(cause) }));
      } finally {
        setConfirming(false);
      }
    })();
  };

  const canConfirm = !disabled && !confirming && semester !== null && rows.length > 0;
  const appliedRules = artifact.ruleIds === undefined ? artifact.rows.length : artifact.ruleIds.length;

  return (
    <section className="agent-timetable" data-testid="agent-timetable-card" data-state={artifact.state}>
      <header className="agent-timetable__head">
        <h3 className="agent-timetable__title">
          <Calendar size={16} className="agent-timetable__title-icon" />
          {t('agent.timetable.title')}
        </h3>
        {artifact.state === 'pending' && <span className="pill pill--brand">{t('agent.timetable.pending')}</span>}
      </header>

      {artifact.warnings.length > 0 && (
        <div className="notice agent-timetable__warnings" data-testid="agent-timetable-warnings">
          <ul className="agent-timetable__warnings-list">
            {artifact.warnings.map((warning) => (
              <li key={warning} className="small">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {artifact.state === 'applied' && (
        <p className="notice notice--success agent-timetable__result" role="status" data-testid="agent-timetable-result">
          {artifact.note ?? t('agent.timetable.applied', { n: appliedRules, skipped: 0 })}
        </p>
      )}

      {artifact.state === 'cancelled' && (
        <p className="notice agent-timetable__result muted" role="status" data-testid="agent-timetable-result">
          {artifact.note ?? t('agent.timetable.cancelled')}
        </p>
      )}

      {artifact.state === 'applied' && (
        <ul className="agent-timetable__applied-list">
          {artifact.rows.map((row) => (
            <li key={row.id} className="small muted">
              {row.course} · {t(WEEKDAY_LABEL_KEYS[row.weekday])} {row.start}–{row.end} · {row.weeks}
            </li>
          ))}
        </ul>
      )}

      {artifact.state === 'pending' && (
        <>
          <p className="setting__hint">{t('agent.timetable.hint')}</p>

          {semester === null && (
            <div className="agent-timetable__gate">
              <SemesterFields semester={null} onChange={onSemesterChange} testIdPrefix="agent-timetable-semester" />
              <p className="agent-timetable__hint">{t('agent.timetable.needSemester')}</p>
            </div>
          )}

          {semester !== null && <p className="agent-timetable__hint">{t('agent.timetable.semesterHint')}</p>}

          <ul className="agent-timetable__rows">
            {rows.map((row, index) => {
              const view = viewById.get(row.id);
              return (
                <li key={row.id} className="agent-timetable__row" data-testid="agent-timetable-row">
                  <div className="agent-timetable__row-head">
                    <input
                      value={row.course}
                      onChange={(event) => updateRow(row.id, { course: event.target.value })}
                      aria-label={t('agent.timetable.column.course')}
                      placeholder={t('agent.timetable.column.course')}
                      data-testid={`agent-timetable-course-${index}`}
                      className="input input--compact agent-timetable__course"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      disabled={disabled}
                      aria-label={t('agent.timetable.removeRow')}
                      title={t('agent.timetable.removeRow')}
                      data-testid={`agent-timetable-remove-${index}`}
                      className="btn btn--danger btn--xs agent-timetable__remove"
                    >
                      <Trash size={13} />
                    </button>
                  </div>
                  <div className="agent-timetable__fields">
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.weekday')}</span>
                      <select
                        value={row.weekday}
                        onChange={(event) => updateRow(row.id, { weekday: parseWeekday(event.target.value) })}
                        aria-label={t('agent.timetable.column.weekday')}
                        data-testid={`agent-timetable-weekday-${index}`}
                        className="select input--compact"
                      >
                        {WEEKDAYS.map((weekday) => (
                          <option key={weekday} value={weekday}>
                            {t(WEEKDAY_LABEL_KEYS[weekday])}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.start')}</span>
                      <input
                        type="time"
                        value={row.start}
                        onChange={(event) => updateRow(row.id, { start: event.target.value })}
                        aria-label={t('agent.timetable.column.start')}
                        data-testid={`agent-timetable-start-${index}`}
                        className="input input--compact"
                      />
                    </label>
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.end')}</span>
                      <input
                        type="time"
                        value={row.end}
                        onChange={(event) => updateRow(row.id, { end: event.target.value })}
                        aria-label={t('agent.timetable.column.end')}
                        data-testid={`agent-timetable-end-${index}`}
                        className="input input--compact"
                      />
                    </label>
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.weeks')}</span>
                      <input
                        value={row.weeks}
                        onChange={(event) => updateRow(row.id, { weeks: event.target.value })}
                        aria-label={t('agent.timetable.column.weeks')}
                        data-testid={`agent-timetable-weeks-${index}`}
                        className="input input--compact"
                      />
                    </label>
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.teacher')}</span>
                      <input
                        value={row.teacher ?? ''}
                        onChange={(event) =>
                          updateRow(row.id, { teacher: event.target.value === '' ? undefined : event.target.value })
                        }
                        aria-label={t('agent.timetable.column.teacher')}
                        data-testid={`agent-timetable-teacher-${index}`}
                        className="input input--compact"
                      />
                    </label>
                    <label className="agent-timetable__field">
                      <span className="agent-timetable__label">{t('agent.timetable.column.location')}</span>
                      <input
                        value={row.location ?? ''}
                        onChange={(event) =>
                          updateRow(row.id, { location: event.target.value === '' ? undefined : event.target.value })
                        }
                        aria-label={t('agent.timetable.column.location')}
                        data-testid={`agent-timetable-location-${index}`}
                        className="input input--compact"
                      />
                    </label>
                  </div>
                  <div className="agent-timetable__row-meta">
                    <span className="agent-timetable__dates mono" data-testid={`agent-timetable-dates-${index}`}>
                      {view === undefined
                        ? '—'
                        : t('agent.timetable.firstLast', { first: view.firstDate, last: view.lastDate })}
                    </span>
                    <span className="agent-timetable__conflicts" data-testid={`agent-timetable-conflicts-${index}`}>
                      {view !== undefined && view.conflicts.length > 0 ? (
                        view.conflicts.map((conflict) => (
                          <span key={conflict} className="pill agent-timetable__conflict">
                            {localizeConflict(conflict, t)}
                          </span>
                        ))
                      ) : (
                        <span className="tiny muted">{t('agent.timetable.noConflicts')}</span>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="agent-timetable__actions">
            <button
              type="button"
              onClick={addRow}
              disabled={disabled}
              data-testid="agent-timetable-add-row"
              className="btn btn--sm"
            >
              <Plus size={14} />
              {t('agent.timetable.addRow')}
            </button>
            <span className="spacer" />
            <button
              type="button"
              onClick={onCancel}
              disabled={disabled || confirming}
              data-testid="agent-timetable-cancel"
              className="btn btn--sm"
            >
              {t('agent.timetable.cancel')}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!canConfirm}
              aria-busy={confirming}
              data-testid="agent-timetable-confirm"
              className="btn btn--primary btn--sm"
            >
              {confirming ? t('agent.timetable.confirming') : t('agent.timetable.confirm', { n: rows.length })}
            </button>
          </div>

          {error !== null && (
            <p className="notice notice--danger agent-timetable__error" role="alert" data-testid="agent-timetable-error">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
