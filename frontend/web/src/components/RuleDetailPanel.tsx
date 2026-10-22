import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  civilFromDays,
  civilFromTimestamp,
  dayFromTimestamp,
  daysFromCivil,
  endOfCivilDay,
  formatCivilDate,
  occurrenceStart,
  parseCivilDate,
  weekdayFromDays,
} from '@worktree/core';
import type { BlockRule, CivilDate, CivilTime, RuleFreq } from '@worktree/core';
import type { BlockRulePatch, WorktreeClient } from '@worktree/client';
import { useI18n } from '../i18n';
import type { Translate } from '../i18n';
import { WEEKDAY_KEYS, weekdayName } from '../weekdays';
import { ExpandSelect } from './ExpandSelect';
import { CheckIcon, TrashIcon, XIcon } from './icons';

const MINUTE_MS = 60_000;
/** bySetPos value of the "every such weekday" option; the model has no 0. */
const POS_EVERY = 0;
const POS_LAST = -1;
const FREQ_OPTIONS: RuleFreq[] = ['daily', 'weekly', 'monthly', 'yearly'];
const NTH_OPTIONS: { value: number; key: string }[] = [
  { value: POS_EVERY, key: 'rule.nthEvery' },
  { value: 1, key: 'rule.nth1' },
  { value: 2, key: 'rule.nth2' },
  { value: 3, key: 'rule.nth3' },
  { value: 4, key: 'rule.nth4' },
  { value: 5, key: 'rule.nth5' },
  { value: POS_LAST, key: 'rule.nthLast' },
];

/**
 * Create or edit a calendar rule. `rule === null` means "new rule".
 * The panel speaks the rule's own civil time (`tzOffset`), not the device's:
 * a rule stays anchored to the zone it was created in, so its occurrences
 * never move with a DST shift.
 */
export function RuleDetailPanel(props: {
  rule: BlockRule | null;
  /** Civil day of the occurrence the panel was opened from; enables "skip". */
  day?: number;
  client: WorktreeClient;
  nowMs?: number;
  /** The caller provides its own chrome (modal, bottom sheet). */
  bare?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { rule, day, client, nowMs = Date.now(), bare = false, onClose } = props;
  const tzOffset = rule?.tzOffset ?? deviceTzOffsetMs();
  const anchor: CivilDate = rule?.startDate ?? civilFromTimestamp(nowMs, tzOffset).date;
  const anchorDay = daysFromCivil(anchor.year, anchor.month, anchor.day);

  const [name, setName] = useState(rule?.name ?? '');
  const [note, setNote] = useState(rule?.note ?? '');
  const [freq, setFreq] = useState<RuleFreq>(rule?.freq ?? 'weekly');
  const [intervalText, setIntervalText] = useState(String(rule?.interval ?? 1));
  const [startDateText, setStartDateText] = useState(formatCivilDate(anchor));
  const [timeText, setTimeText] = useState(formatCivilTime(rule?.timeOfDay ?? { hour: 9, minute: 0 }));
  const [durationText, setDurationText] = useState(String((rule?.duration ?? 60 * MINUTE_MS) / MINUTE_MS));
  const [byDay, setByDay] = useState<number[]>(rule?.byDay ?? [weekdayFromDays(anchorDay)]);
  const [nthPos, setNthPos] = useState(rule?.bySetPos ?? POS_EVERY);
  const [byMonthDayText, setByMonthDayText] = useState(
    rule?.byMonthDay !== undefined ? rule.byMonthDay.map(formatMonthDay).join(', ') : String(anchor.day),
  );
  const [byMonth, setByMonth] = useState<number[]>(rule?.byMonth ?? [anchor.month]);
  const [untilText, setUntilText] = useState(
    rule?.until !== undefined ? formatCivilDate(civilFromDays(dayFromTimestamp(rule.until, tzOffset))) : '',
  );
  const [active, setActive] = useState(rule?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  const skips = rule !== null ? client.getSkips(rule.id) : [];
  const showTzHint = rule !== null && rule.tzOffset !== deviceTzOffsetMs();
  /** A monthly rule without byMonthDay repeats by weekday; empty text means that. */
  const byNthWeekday = freq === 'monthly' && byMonthDayText.trim() === '';

  const run = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (e) {
      setError(t('rule.error', { message: e instanceof Error ? e.message : String(e) }));
      return false;
    }
  };

  const save = (): void => {
    const interval = Number(intervalText);
    const startDate = parseCivilDate(startDateText);
    const time = parseCivilTime(timeText);
    const durationMs = Math.round(Number(durationText) * MINUTE_MS);
    const monthDays = parseMonthDays(byMonthDayText);
    const until = untilText.trim() === '' ? null : parseCivilDate(untilText);

    if (name === '') return setError(t('rule.nameRequired'));
    if (!Number.isInteger(interval) || interval < 1) return setError(t('rule.intervalRequired'));
    if (!Number.isFinite(durationMs) || durationMs < 1) return setError(t('rule.durationRequired'));
    if (startDate === null) return setError(t('rule.dateRequired'));
    if (time === null) return setError(t('rule.timeRequired'));
    if (untilText.trim() !== '' && until === null) return setError(t('rule.untilRequired'));
    if (freq === 'yearly' && byMonth.length === 0) return setError(t('rule.monthsRequired'));
    if ((freq === 'weekly' || byNthWeekday) && byDay.length === 0) return setError(t('rule.weekdaysRequired'));
    if (freq === 'monthly' && !byNthWeekday && monthDays === null) return setError(t('rule.monthDayRequired'));
    if (freq === 'yearly' && monthDays === null) return setError(t('rule.monthDayRequired'));

    const selectors = {
      byDay: freq === 'weekly' || byNthWeekday ? sortNumbers(byDay) : null,
      byMonthDay: freq === 'yearly' ? monthDays : freq === 'monthly' && !byNthWeekday ? monthDays : null,
      byMonth: freq === 'yearly' ? sortNumbers(byMonth) : null,
      bySetPos: byNthWeekday && nthPos !== POS_EVERY ? nthPos : null,
    };
    const untilMs =
      until !== null ? endOfCivilDay(daysFromCivil(until.year, until.month, until.day), tzOffset) : null;

    if (rule === null) {
      if (
        run(() =>
          client.addBlockRule({
            name,
            note,
            freq,
            interval,
            startDate,
            timeOfDay: time,
            duration: durationMs,
            until: untilMs ?? undefined,
            byDay: selectors.byDay ?? undefined,
            byMonthDay: selectors.byMonthDay ?? undefined,
            byMonth: selectors.byMonth ?? undefined,
            bySetPos: selectors.bySetPos ?? undefined,
          }),
        )
      ) {
        onClose();
      }
      return;
    }

    const patch: BlockRulePatch = {};
    if (name !== rule.name) patch.name = name;
    if (note !== rule.note) patch.note = note;
    if (active !== rule.active) patch.active = active;
    if (freq !== rule.freq) patch.freq = freq;
    if (interval !== rule.interval) patch.interval = interval;
    if (!sameDate(startDate, rule.startDate)) patch.startDate = startDate;
    if (time.hour !== rule.timeOfDay.hour || time.minute !== rule.timeOfDay.minute) patch.timeOfDay = time;
    if (durationMs !== rule.duration) patch.duration = durationMs;
    if (untilMs !== (rule.until ?? null)) patch.until = untilMs;
    if (!sameNumbers(rule.byDay, selectors.byDay)) patch.byDay = selectors.byDay;
    if (!sameNumbers(rule.byMonthDay, selectors.byMonthDay)) patch.byMonthDay = selectors.byMonthDay;
    if (!sameNumbers(rule.byMonth, selectors.byMonth)) patch.byMonth = selectors.byMonth;
    if ((rule.bySetPos ?? null) !== selectors.bySetPos) patch.bySetPos = selectors.bySetPos;
    // An untouched panel must not clear the rule's skips (every day-set field
    // present in the patch does), so an empty diff sends nothing at all.
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const dropped = clearedFutureSkips(rule, skips, patch, nowMs);
    if (dropped.length > 0) {
      const days = dropped.map((d) => formatCivilDate(civilFromDays(d))).join(', ');
      if (!window.confirm(t('rule.clearSkipsConfirm', { days }))) return;
    }
    if (run(() => client.editBlockRule(rule.id, patch))) onClose();
  };

  const toggle = (values: number[], value: number): number[] =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];

  const weekdayToggles = (label: string, testIdPrefix: string): ReactNode => (
    <div className="segmented segmented--chips" role="group" aria-label={label}>
      {WEEKDAY_KEYS.map((key, i) => (
        <button
          key={key}
          type="button"
          data-testid={`${testIdPrefix}-${i}`}
          aria-pressed={byDay.includes(i)}
          onClick={() => setByDay((values) => toggle(values, i))}
          className="segmented__item"
        >
          {t(key)}
        </button>
      ))}
    </div>
  );

  return (
    <div className={bare ? 'detail' : 'card detail'} data-testid="rule-detail">
      <div className="detail__head">
        <h2 className="detail__title">{rule === null ? t('rule.newTitle') : t('rule.editTitle')}</h2>
        <div className="detail__actions">
          <button
            type="button"
            data-testid="rule-cancel"
            onClick={onClose}
            aria-label={t('calendar.close')}
            className="btn btn--icon"
          >
            <XIcon className="icon" />
          </button>
        </div>
      </div>

      {rule !== null && (
        <div className="detail__actions">
          {day !== undefined ? (
            <button
              type="button"
              data-testid="rule-skip"
              onClick={() => run(() => client.skipOccurrence(rule.id, day))}
              className="btn btn--sm"
            >
              <XIcon className="icon icon--sm" />
              {t('rule.skip')}
            </button>
          ) : (
            <p className="tiny muted">{t('rule.skipHint')}</p>
          )}
          <button
            type="button"
            data-testid="rule-delete"
            onClick={() => {
              if (window.confirm(t('rule.deleteConfirm', { name: rule.name })) && run(() => client.removeBlockRule(rule.id))) {
                onClose();
              }
            }}
            className="btn btn--sm btn--danger"
          >
            <TrashIcon className="icon icon--sm" />
            {t('rule.delete')}
          </button>
        </div>
      )}

      {showTzHint && (
        <p data-testid="rule-tz-hint" className="notice">
          {t('rule.tzHint', { offset: formatOffset(rule.tzOffset) })}
        </p>
      )}

      <div className="detail__section">
        <div className="form">
          <label className="field">
            <span className="field__label">{t('rule.name')}</span>
            <input
              data-testid="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          </label>

          <label className="field">
            <span className="field__label">{t('rule.note')}</span>
            <textarea
              data-testid="rule-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="textarea"
              rows={2}
            />
          </label>

          <div className="form__row">
            <div className="field">
              <span className="field__label">{t('rule.freq')}</span>
              <ExpandSelect
                value={freq}
                options={FREQ_OPTIONS.map((value) => ({ value, label: t(`rule.freq${capitalize(value)}`) }))}
                onChange={(value) => setFreq(parseFreq(value))}
                label={t('rule.freq')}
                testId="rule-freq"
              />
            </div>
            <label className="field">
              <span className="field__label">{t('rule.interval')}</span>
              <div className="cluster">
                <input
                  data-testid="rule-interval"
                  type="number"
                  min={1}
                  step={1}
                  value={intervalText}
                  onChange={(e) => setIntervalText(e.target.value)}
                  className="input w-24"
                />
                <span className="tiny muted">{t(`rule.unit.${freq}`)}</span>
              </div>
            </label>
          </div>

          <div className="form__row">
            <label className="field">
              <span className="field__label">{t('rule.startDate')}</span>
              <input
                data-testid="rule-start-date"
                type="date"
                value={startDateText}
                onChange={(e) => setStartDateText(e.target.value)}
                className="input"
              />
            </label>
            <label className="field">
              <span className="field__label">{t('rule.time')}</span>
              <input
                data-testid="rule-time"
                type="time"
                value={timeText}
                onChange={(e) => setTimeText(e.target.value)}
                className="input"
              />
            </label>
            <label className="field">
              <span className="field__label">{t('rule.duration')}</span>
              <input
                data-testid="rule-duration"
                type="number"
                min={1}
                step={1}
                value={durationText}
                onChange={(e) => setDurationText(e.target.value)}
                className="input"
              />
            </label>
          </div>

          {freq === 'weekly' && (
            <div className="field">
              <span className="field__label">{t('rule.weekdays')}</span>
              {weekdayToggles(t('rule.weekdays'), 'rule-day')}
            </div>
          )}

          {freq === 'monthly' && (
            <div className="field">
              <label className="check items-start">
                <input
                  data-testid="rule-nth-mode"
                  type="checkbox"
                  checked={byNthWeekday}
                  onChange={(e) => setByMonthDayText(e.target.checked ? '' : String(anchor.day))}
                />
                <span className="small">{t('rule.modeNthWeekday')}</span>
              </label>
              {byNthWeekday ? (
                <div className="field">
                  <span className="field__label">
                    {t('rule.nth')} {t('rule.weekday')}
                  </span>
                  <ExpandSelect
                    value={String(nthPos)}
                    options={NTH_OPTIONS.map((option) => ({ value: String(option.value), label: t(option.key) }))}
                    onChange={(value) => setNthPos(parseNth(value))}
                    label={`${t('rule.nth')} ${t('rule.weekday')}`}
                    testId="rule-nth"
                  />
                </div>
              ) : (
                <label className="field">
                  <span className="field__label">{t('rule.monthDay')}</span>
                  <input
                    data-testid="rule-month-day"
                    value={byMonthDayText}
                    onChange={(e) => setByMonthDayText(e.target.value)}
                    className="input w-28"
                  />
                </label>
              )}
              {byNthWeekday && weekdayToggles(t('rule.weekday'), 'rule-nth-day')}
            </div>
          )}

          {freq === 'yearly' && (
            <div className="field">
              <span className="field__label">{t('rule.month')}</span>
              <div className="segmented segmented--chips" role="group" aria-label={t('rule.month')}>
                {monthRange().map((month) => (
                  <button
                    key={month}
                    type="button"
                    data-testid={`rule-month-${month}`}
                    aria-pressed={byMonth.includes(month)}
                    onClick={() => setByMonth((values) => toggle(values, month))}
                    className="segmented__item"
                  >
                    {t(`rule.monthName${month}`)}
                  </button>
                ))}
              </div>
              <label className="field">
                <span className="field__label">{t('rule.monthDay')}</span>
                <input
                  data-testid="rule-year-day"
                  value={byMonthDayText}
                  onChange={(e) => setByMonthDayText(e.target.value)}
                  className="input w-28"
                />
              </label>
            </div>
          )}

          <label className="field">
            <span className="field__label">{t('rule.until')}</span>
            <input
              data-testid="rule-until"
              type="date"
              value={untilText}
              onChange={(e) => setUntilText(e.target.value)}
              className="input"
            />
            <span className="tiny muted">{t('rule.untilHint')}</span>
          </label>

          <label className="check">
            <input
              data-testid="rule-active"
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>{t('rule.active')}</span>
          </label>

          {rule !== null && (
            <div className="field">
              <span className="field__label">{t('rule.exceptions')}</span>
              {skips.length === 0 ? (
                <p className="small muted">{t('rule.noExceptions')}</p>
              ) : (
                <ul data-testid="rule-exceptions" className="detail__list">
                  {skips.map((skippedDay) => (
                    <li key={skippedDay} className="detail__list-row">
                      <span className="mono small">{formatCivilDate(civilFromDays(skippedDay))}</span>
                      <button
                        type="button"
                        data-testid={`rule-restore-${skippedDay}`}
                        onClick={() => run(() => client.unskipOccurrence(rule.id, skippedDay))}
                        className="btn btn--xs"
                      >
                        <CheckIcon className="icon icon--sm" />
                        {t('rule.restore')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error !== null && <p className="form__error">{error}</p>}

          <button type="button" data-testid="rule-save" onClick={save} className="btn btn--primary btn--block">
            {t('rule.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Skips a patch would clear (it touches the day set) whose occurrence is still ahead of `now`.
 *  Mirrors Calendar's day-set rule: the field's presence in the patch is what clears them. */
function clearedFutureSkips(
  rule: BlockRule,
  skips: readonly number[],
  patch: BlockRulePatch,
  now: number,
): number[] {
  const touchesDaySet =
    patch.freq !== undefined ||
    patch.interval !== undefined ||
    patch.startDate !== undefined ||
    patch.byDay !== undefined ||
    patch.byMonthDay !== undefined ||
    patch.byMonth !== undefined ||
    patch.bySetPos !== undefined ||
    patch.until !== undefined;
  return touchesDaySet ? skips.filter((day) => occurrenceStart(rule, day) > now) : [];
}

/** The device's current UTC offset in ms, whole minutes (matches the client). */
function deviceTzOffsetMs(): number {
  return Math.round((-new Date().getTimezoneOffset() * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
}

function formatOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${sign}${pad(Math.floor(abs / 3_600_000))}:${pad(Math.floor(abs / MINUTE_MS) % 60)}`;
}

export function formatCivilTime(time: CivilTime): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

function parseCivilTime(text: string): CivilTime | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** `15` or `last` (the model's -1); null when the text is not a valid entry. */
function parseMonthDays(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return null;
  const days: number[] = [];
  for (const part of parts) {
    const value = part === 'last' ? -1 : Number(part);
    if (!Number.isInteger(value) || value < -1 || value === 0 || value > 31) return null;
    days.push(value);
  }
  return days;
}

/** The month-day input's own syntax ("last"), round-tripped with `parseMonthDays`. */
function formatMonthDay(day: number): string {
  return day === -1 ? 'last' : String(day);
}

/** One-line "Daily 09:00 · 60min" summary for the rules list. */
export function ruleSummary(rule: BlockRule, t: Translate): string {
  const parts: string[] = [t(`rule.freq${capitalize(rule.freq)}`)];
  if (rule.interval > 1) parts.push(`×${rule.interval}`);
  if (rule.byDay !== undefined) parts.push(rule.byDay.map((d) => weekdayName(t, d)).join(' '));
  if (rule.byMonthDay !== undefined) {
    parts.push(rule.byMonthDay.map((d) => (d === -1 ? t('rule.monthDayLast') : String(d))).join(', '));
  }
  if (rule.byMonth !== undefined) parts.push(rule.byMonth.map((m) => t(`rule.monthName${m}`)).join(' '));
  if (rule.bySetPos !== undefined) parts.push(nthLabel(rule.bySetPos, t));
  parts.push(`${formatCivilTime(rule.timeOfDay)} · ${rule.duration / MINUTE_MS}min`);
  if (!rule.active) parts.push(t('rule.off'));
  return parts.join(' · ');
}

function nthLabel(pos: number, t: Translate): string {
  if (pos === -1) return t('rule.nthLast');
  if (pos >= 1 && pos <= 5) return t(`rule.nth${pos}`);
  return String(pos);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sameDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function sameNumbers(a: number[] | undefined, b: number[] | null): boolean {
  const left = sortNumbers(a ?? []);
  const right = sortNumbers(b ?? []);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function sortNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function parseFreq(value: string): RuleFreq {
  if (value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly') return value;
  throw new Error(`unknown frequency: ${value}`);
}

function parseNth(value: string): number {
  const position = Number(value);
  if (!Number.isInteger(position)) throw new Error(`unknown nth position: ${value}`);
  return position;
}

function monthRange(): number[] {
  const months: number[] = [];
  for (let m = 1; m <= 12; m++) months.push(m);
  return months;
}
