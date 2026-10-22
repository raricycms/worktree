import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import {
  daysFromCivil,
  formatCivilDate,
  isValidCivilDate,
  newId,
  parseCivilDate,
  weekdayFromDays,
} from '@worktree/core';
import type { CivilDate } from '@worktree/core';
import type { WorktreeClient } from '@worktree/client';
import {
  ProviderError,
  WEEKDAYS,
  analyzeTimetableRows,
  draftToRows,
  extractTimetable,
  rowsToRules,
} from '@worktree/agent';
import type {
  LlmTransport,
  Semester,
  TimetableRow,
  TimetableRowView,
  Weekday,
} from '@worktree/agent';
import { useI18n } from '../i18n';
import type { Translate } from '../i18n';
import { MAX_IMAGE_MB, imageFileProblem, imageFileToJpegDataUrl } from '../image';

const MAX_SEMESTER_WEEKS = 60;
const MINUTE_MS = 60 * 1000;

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

/** The device's current UTC offset in ms, whole minutes (matches the client). */
export function deviceTzOffsetMs(): number {
  return Math.round((-new Date().getTimezoneOffset() * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
}

/** Abort is a user action, not a failure: the UI reports it as "stopped". */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError';
  return error instanceof Error && error.name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a provider/transport failure to an actionable message. Status codes are
 * the only reliable signal the OpenAI-compatible endpoint gives us; the HTTP
 * message is kept for the cases the catalogue has no wording for.
 */
export function agentErrorText(error: unknown, t: Translate): string {
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) return t('agent.error.unauthorized');
    if (error.status === 402) return t('agent.error.quota');
    if (error.status === 429) return t('agent.error.rateLimit');
    // A 400 that names an image/vision/modality problem means the configured
    // model is text-only, which the user can only fix by changing the model.
    if (error.status === 400 && /image|vision|modal/i.test(error.message)) {
      return t('agent.error.imageUnsupported');
    }
    if (error.status !== undefined) {
      return t('agent.error.status', { status: error.status, message: error.message });
    }
    return t('agent.error.generic', { message: error.message });
  }
  return t('agent.error.generic', { message: messageOf(error) });
}

function semesterFromInput(dateText: string, weeksText: string): Semester | null {
  const date: CivilDate | null = parseCivilDate(dateText);
  if (date === null || !isValidCivilDate(date)) return null;
  if (weekdayFromDays(daysFromCivil(date.year, date.month, date.day)) !== 1) return null;
  const totalWeeks = Number(weeksText);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_SEMESTER_WEEKS) return null;
  return { firstMonday: date, totalWeeks };
}

function parseWeekday(value: string): Weekday {
  const weekday = Number(value);
  if (weekday === 1 || weekday === 2 || weekday === 3 || weekday === 4 || weekday === 5 || weekday === 6 || weekday === 7) {
    return weekday;
  }
  throw new Error(`invalid weekday: ${value}`);
}

/**
 * The teaching calendar fields, shared by Settings and the import panel. The
 * date input is `YYYY-MM-DD` because the wire format and the core civil date
 * are the same string; the anchor must be a Monday.
 */
export function SemesterFields(props: {
  semester: Semester | null;
  onChange: (semester: Semester | null) => void;
  /** Prefix for stable test handles (`<prefix>-first-monday`, …). */
  testIdPrefix: string;
}): ReactElement {
  const { t } = useI18n();
  const { semester, onChange, testIdPrefix } = props;
  const [dateDraft, setDateDraft] = useState(semester === null ? '' : formatCivilDate(semester.firstMonday));
  const [weeksDraft, setWeeksDraft] = useState(semester === null ? '16' : String(semester.totalWeeks));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDateDraft(semester === null ? '' : formatCivilDate(semester.firstMonday));
    setWeeksDraft(semester === null ? '16' : String(semester.totalWeeks));
  }, [semester]);

  const apply = (): void => {
    const parsed = semesterFromInput(dateDraft, weeksDraft);
    if (parsed === null) {
      setError(t('agent.semester.invalid'));
      return;
    }
    setError(null);
    onChange(parsed);
  };

  return (
    <div className="stack agent-semester">
      <div className="form__row agent-semester__row">
        <label className="field">
          <span className="field__label">{t('agent.semester.firstMonday')}</span>
          <input
            type="date"
            value={dateDraft}
            onChange={(event) => setDateDraft(event.target.value)}
            data-testid={`${testIdPrefix}-first-monday`}
            className="input input--compact agent-semester__date"
          />
        </label>
        <label className="field">
          <span className="field__label">{t('agent.semester.totalWeeks')}</span>
          <input
            type="number"
            min={1}
            max={MAX_SEMESTER_WEEKS}
            value={weeksDraft}
            onChange={(event) => setWeeksDraft(event.target.value)}
            data-testid={`${testIdPrefix}-weeks`}
            className="input input--compact w-24"
          />
        </label>
        <button
          type="button"
          onClick={apply}
          data-testid={`${testIdPrefix}-save`}
          className="btn btn--primary btn--sm"
        >
          {t('agent.semester.save')}
        </button>
        {semester !== null && (
          <button
            type="button"
            onClick={() => onChange(null)}
            data-testid={`${testIdPrefix}-clear`}
            className="btn btn--sm"
          >
            {t('agent.semester.clear')}
          </button>
        )}
      </div>
      <p className="setting__hint">
        {semester === null
          ? t('agent.semester.hint')
          : t('agent.semester.current', {
              first: formatCivilDate(semester.firstMonday),
              weeks: semester.totalWeeks,
            })}
      </p>
      {error !== null && (
        <p className="form__error" data-testid={`${testIdPrefix}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export interface TimetableExtractResult {
  rows: TimetableRow[];
  warnings: string[];
}

/** The vision round trip, injectable so the preview UI is testable offline. */
export type TimetableExtract = (
  imageDataUrl: string,
  semester: Semester,
  signal: AbortSignal,
) => Promise<TimetableExtractResult>;

interface ImportResult {
  rules: number;
  duplicates: TimetableRowView[];
  warnings: string[];
}

function rowLabel(row: TimetableRow, t: Translate): string {
  return `${row.course} · ${t(WEEKDAY_LABEL_KEYS[row.weekday])} ${row.start}–${row.end}`;
}

/**
 * Timetable import: semester → image → parse → editable preview → confirm.
 * Parsing only fills the preview; `client.applyMany` is called on confirm and
 * never before, so a cancelled or broken preview cannot write anything.
 */
export function TimetableImport(props: {
  client: WorktreeClient;
  semester: Semester | null;
  onSemesterChange: (semester: Semester | null) => void;
  transport: LlmTransport;
  extract?: TimetableExtract;
}): ReactElement {
  const { t, lang } = useI18n();
  const { client, semester, onSemesterChange, transport, extract } = props;

  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rows, setRows] = useState<TimetableRow[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const tzOffset = useMemo(deviceTzOffsetMs, []);

  const extractRows = useMemo<TimetableExtract>(
    () =>
      extract ??
      (async (dataUrl, anchor, signal) => {
        const draft = await extractTimetable({
          transport,
          imageDataUrl: dataUrl,
          semester: anchor,
          signal,
          language: lang,
        });
        return { rows: draftToRows(draft), warnings: draft.warnings };
      }),
    [extract, transport, lang],
  );

  const viewById = useMemo(() => {
    if (rows === null || semester === null) return new Map<string, TimetableRowView>();
    const views = analyzeTimetableRows(rows, { semester, tzOffset, state: client.planningState() });
    return new Map(views.map((view) => [view.row.id, view]));
  }, [rows, semester, tzOffset, client]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const prepare = async (file: File): Promise<void> => {
    const problem = imageFileProblem(file);
    if (problem === 'type') {
      setError(t('agent.import.invalidType'));
      return;
    }
    if (problem === 'size') {
      setError(t('agent.import.tooLarge', { mb: MAX_IMAGE_MB }));
      return;
    }
    setPreparing(true);
    setError(null);
    setResult(null);
    setRows(null);
    setWarnings([]);
    try {
      const dataUrl = await imageFileToJpegDataUrl(file);
      setImageDataUrl(dataUrl);
      setImageName(file.name);
    } catch (e) {
      setError(t('agent.import.imageFailed', { message: messageOf(e) }));
    } finally {
      setPreparing(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file fires change again.
    event.target.value = '';
    if (file === undefined) return;
    void prepare(file);
  };

  const parse = async (): Promise<void> => {
    if (imageDataUrl === null) {
      setError(t('agent.import.needImage'));
      return;
    }
    if (semester === null) {
      setError(t('agent.import.needSemester'));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setParsing(true);
    setError(null);
    setResult(null);
    try {
      const extracted = await extractRows(imageDataUrl, semester, controller.signal);
      setRows(extracted.rows);
      setWarnings(extracted.warnings);
    } catch (e) {
      if (!isAbortError(e)) setError(agentErrorText(e, t));
    } finally {
      setParsing(false);
      abortRef.current = null;
    }
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const updateRow = (id: string, patch: Partial<TimetableRow>): void => {
    setRows((current) =>
      current === null ? current : current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const addRow = (): void => {
    setRows((current) => [
      ...(current ?? []),
      { id: newId(), course: '', weekday: 1, start: '08:00', end: '09:40', weeks: '1-16' },
    ]);
  };

  const removeRow = (id: string): void => {
    setRows((current) => (current === null ? current : current.filter((row) => row.id !== id)));
  };

  const discard = (): void => {
    setRows(null);
    setWarnings([]);
    setError(null);
    setImageDataUrl(null);
    setImageName(null);
    setResult(null);
  };

  const confirm = (): void => {
    if (rows === null) return;
    if (semester === null) {
      setError(t('agent.import.needSemester'));
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const plan = rowsToRules(rows, {
        semester,
        tzOffset,
        newId,
        existingRules: client.getRules(),
      });
      client.applyMany(plan.ops);
      setResult({ rules: plan.ops.length, duplicates: plan.duplicates, warnings: plan.warnings });
      setRows(null);
      setWarnings([]);
      setImageDataUrl(null);
      setImageName(null);
    } catch (e) {
      setError(agentErrorText(e, t));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <section className="card agent-import" data-testid="timetable-import">
      <div className="section-head">
        <h2 className="section-title">{t('agent.import.title')}</h2>
        {parsing && <span className="pill pill--brand">{t('agent.import.parsing')}</span>}
      </div>
      <p className="setting__hint">{t('agent.import.hint')}</p>

      <div className="stack agent-import__form">
        <SemesterFields semester={semester} onChange={onSemesterChange} testIdPrefix="timetable-semester" />

        <label className="field">
          <span className="field__label">{t('agent.import.image')}</span>
          <input
            type="file"
            accept="image/*"
            onChange={onFileChange}
            data-testid="timetable-file"
            className="input agent-import__file"
          />
          <span className="setting__hint">{t('agent.import.imageHint', { mb: MAX_IMAGE_MB })}</span>
        </label>

        {imageDataUrl !== null && (
          <div className="agent-import__picked">
            <img
              src={imageDataUrl}
              alt={t('agent.import.previewAlt')}
              className="agent-import__preview"
              data-testid="timetable-image-preview"
            />
            <span className="tiny muted mono">{imageName}</span>
          </div>
        )}

        <div className="form__actions">
          <button
            type="button"
            onClick={() => void parse()}
            disabled={parsing || preparing || imageDataUrl === null || semester === null}
            aria-busy={parsing}
            data-testid="timetable-parse"
            className="btn btn--primary btn--sm"
          >
            {parsing ? t('agent.import.parsing') : t('agent.import.parse')}
          </button>
          {parsing && (
            <button type="button" onClick={stop} data-testid="timetable-stop" className="btn btn--danger btn--sm">
              {t('agent.stop')}
            </button>
          )}
          {(rows !== null || imageDataUrl !== null) && (
            <button type="button" onClick={discard} data-testid="timetable-discard" className="btn btn--sm">
              {t('agent.import.discard')}
            </button>
          )}
        </div>

        {error !== null && (
          <p className="notice notice--danger" role="alert" data-testid="timetable-error">
            {error}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="notice" data-testid="timetable-warnings">
            <p className="notice__title">{t('agent.import.warningsTitle')}</p>
            <ul className="agent-import__list">
              {warnings.map((warning) => (
                <li key={warning} className="small">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        )}

        {result !== null && (
          <div className="notice notice--success" role="status" data-testid="timetable-result">
            <p className="notice__title">
              {t('agent.import.done', { rules: result.rules, duplicates: result.duplicates.length })}
            </p>
            {result.duplicates.length > 0 && (
              <>
                <p className="small">{t('agent.import.duplicatesTitle')}</p>
                <ul className="agent-import__list">
                  {result.duplicates.map((view) => (
                    <li key={view.row.id} className="small">
                      {rowLabel(view.row, t)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.warnings.map((warning) => (
              <p key={warning} className="small">
                {warning}
              </p>
            ))}
          </div>
        )}
      </div>

      {rows !== null && (
        <div className="agent-import__preview-wrap">
          <div className="section-head">
            <h3 className="section-title">{t('agent.import.previewTitle', { n: rows.length })}</h3>
            <button type="button" onClick={addRow} data-testid="timetable-add-row" className="btn btn--sm">
              {t('agent.import.addRow')}
            </button>
          </div>
          <p className="setting__hint">{t('agent.import.previewHint')}</p>
          <div className="agent-table-wrap">
            <table className="agent-table">
              <thead>
                <tr>
                  <th scope="col">{t('agent.import.column.course')}</th>
                  <th scope="col">{t('agent.import.column.weekday')}</th>
                  <th scope="col">{t('agent.import.column.start')}</th>
                  <th scope="col">{t('agent.import.column.end')}</th>
                  <th scope="col">{t('agent.import.column.weeks')}</th>
                  <th scope="col">{t('agent.import.column.teacher')}</th>
                  <th scope="col">{t('agent.import.column.location')}</th>
                  <th scope="col">{t('agent.import.column.dates')}</th>
                  <th scope="col">{t('agent.import.column.conflicts')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('agent.import.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const view = viewById.get(row.id);
                  return (
                    <tr key={row.id} data-testid="timetable-row">
                      <td>
                        <input
                          value={row.course}
                          onChange={(event) => updateRow(row.id, { course: event.target.value })}
                          aria-label={t('agent.import.column.course')}
                          data-testid={`timetable-course-${index}`}
                          className="input input--compact"
                        />
                      </td>
                      <td>
                        <select
                          value={row.weekday}
                          onChange={(event) => updateRow(row.id, { weekday: parseWeekday(event.target.value) })}
                          aria-label={t('agent.import.column.weekday')}
                          data-testid={`timetable-weekday-${index}`}
                          className="select input--compact"
                        >
                          {WEEKDAYS.map((weekday) => (
                            <option key={weekday} value={weekday}>
                              {t(WEEKDAY_LABEL_KEYS[weekday])}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="time"
                          value={row.start}
                          onChange={(event) => updateRow(row.id, { start: event.target.value })}
                          aria-label={t('agent.import.column.start')}
                          data-testid={`timetable-start-${index}`}
                          className="input input--compact agent-table__time"
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          value={row.end}
                          onChange={(event) => updateRow(row.id, { end: event.target.value })}
                          aria-label={t('agent.import.column.end')}
                          data-testid={`timetable-end-${index}`}
                          className="input input--compact agent-table__time"
                        />
                      </td>
                      <td>
                        <input
                          value={row.weeks}
                          onChange={(event) => updateRow(row.id, { weeks: event.target.value })}
                          aria-label={t('agent.import.column.weeks')}
                          data-testid={`timetable-weeks-${index}`}
                          className="input input--compact agent-table__weeks"
                        />
                      </td>
                      <td>
                        <input
                          value={row.teacher ?? ''}
                          onChange={(event) =>
                            updateRow(row.id, { teacher: event.target.value === '' ? undefined : event.target.value })
                          }
                          aria-label={t('agent.import.column.teacher')}
                          data-testid={`timetable-teacher-${index}`}
                          className="input input--compact"
                        />
                      </td>
                      <td>
                        <input
                          value={row.location ?? ''}
                          onChange={(event) =>
                            updateRow(row.id, { location: event.target.value === '' ? undefined : event.target.value })
                          }
                          aria-label={t('agent.import.column.location')}
                          data-testid={`timetable-location-${index}`}
                          className="input input--compact"
                        />
                      </td>
                      <td className="agent-table__dates mono">
                        {view === undefined ? '—' : `${view.firstDate} – ${view.lastDate}`}
                      </td>
                      <td>
                        {view !== undefined && view.conflicts.length > 0 ? (
                          <ul className="agent-table__conflicts">
                            {view.conflicts.map((conflict) => (
                              <li key={conflict} className="pill pill--conflict">
                                {conflict}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="tiny muted">—</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => removeRow(row.id)}
                          aria-label={t('agent.import.removeRow')}
                          data-testid={`timetable-remove-${index}`}
                          className="btn btn--danger btn--xs"
                        >
                          {t('agent.import.removeRow')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form__actions">
            <button
              type="button"
              onClick={confirm}
              disabled={confirming || rows.length === 0}
              data-testid="timetable-confirm"
              className="btn btn--primary"
            >
              {confirming ? t('agent.import.confirming') : t('agent.import.confirm', { n: rows.length })}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
