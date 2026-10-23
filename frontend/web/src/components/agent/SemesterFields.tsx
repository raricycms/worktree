import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  daysFromCivil,
  formatCivilDate,
  isValidCivilDate,
  parseCivilDate,
  weekdayFromDays,
} from '@worktree/core';
import type { CivilDate } from '@worktree/core';
import type { Semester } from '@worktree/agent';
import { useI18n } from '../../i18n';

const MAX_SEMESTER_WEEKS = 60;

function semesterFromInput(dateText: string, weeksText: string): Semester | null {
  const date: CivilDate | null = parseCivilDate(dateText);
  if (date === null || !isValidCivilDate(date)) return null;
  if (weekdayFromDays(daysFromCivil(date.year, date.month, date.day)) !== 1) return null;
  const totalWeeks = Number(weeksText);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > MAX_SEMESTER_WEEKS) return null;
  return { firstMonday: date, totalWeeks };
}

/**
 * The teaching calendar fields, shared by Settings and the timetable card. The
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
