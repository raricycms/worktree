import { useId, useState } from 'react';
import type { NodeFilter } from '@worktree/core';
import { hasActiveFilter } from '@worktree/core';
import type { FilterDisplayMode } from '../config';
import { useI18n } from '../i18n';
import { epochToLocalInput, localInputToEpoch } from '../time';
import { ChevronDownIcon, FilterIcon } from './icons';

export interface FilterBarProps {
  filter: NodeFilter;
  mode: FilterDisplayMode;
  onFilterChange: (filter: NodeFilter) => void;
  onModeChange: (mode: FilterDisplayMode) => void;
}

/** The three completion states, in slider order. `undefined` is "any". */
const STATUS_OPTIONS: { value: boolean | undefined; labelKey: string }[] = [
  { value: undefined, labelKey: 'filter.statusAll' },
  { value: false, labelKey: 'filter.statusUncompleted' },
  { value: true, labelKey: 'filter.statusCompleted' },
];

const MODE_OPTIONS: { value: FilterDisplayMode; labelKey: string }[] = [
  { value: 'hide', labelKey: 'filter.hide' },
  { value: 'highlight', labelKey: 'filter.highlight' },
];

function Segmented(props: {
  labelId: string;
  testId: string;
  activeIndex: number;
  options: { label: string }[];
  onSelect: (index: number) => void;
}) {
  const { labelId, testId, activeIndex, options, onSelect } = props;
  return (
    <div
      className="segmented"
      data-count={options.length}
      data-active={activeIndex}
      role="group"
      aria-labelledby={labelId}
      data-testid={testId}
    >
      <span className="segmented__thumb" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          key={option.label}
          type="button"
          className="segmented__item"
          aria-pressed={index === activeIndex}
          onClick={() => onSelect(index)}
          data-testid={`${testId}-${index}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A filter trigger whose panel expands in the page flow below it instead of
 * over the page: it can never overflow the viewport or cover a row. The panel
 * stays mounted so the collapse can animate; while closed it is `inert`.
 */
export function FilterBar(props: FilterBarProps) {
  const { t } = useI18n();
  const { filter, mode, onFilterChange, onModeChange } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const statusLabelId = useId();
  const modeLabelId = useId();
  const active = hasActiveFilter(filter);
  const activeCount = Object.values(filter).filter((value) => value !== undefined).length;
  const statusIndex = STATUS_OPTIONS.findIndex((option) => option.value === filter.status);
  const modeIndex = MODE_OPTIONS.findIndex((option) => option.value === mode);

  const set = (patch: Partial<NodeFilter>): void => {
    onFilterChange({ ...filter, ...patch });
  };

  const setDatetime = (key: 'deadlineBefore' | 'createdAfter' | 'createdBefore', value: string): void => {
    const ms = localInputToEpoch(value);
    set({ [key]: ms ?? undefined });
  };

  const clear = (): void => onFilterChange({});

  return (
    <div className="tree-panel__filters" data-testid="filter-bar">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="filter-toggle"
        data-active={active ? 'true' : 'false'}
        aria-expanded={open}
        aria-controls={panelId}
        className={active ? 'btn btn--sm pill--brand' : 'btn btn--sm'}
      >
        <FilterIcon className="icon icon--sm" />
        {t('filter.title')}
        {active && <span className="pill mono">{activeCount}</span>}
        <ChevronDownIcon className="filter-bar__chevron icon icon--sm" />
      </button>
      <div
        id={panelId}
        className={open ? 'filter-panel is-open' : 'filter-panel'}
        data-testid="filter-panel"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="filter-panel__clip">
          <div className="filter-panel__content">
            <label className="field filter-panel__field--wide">
              <span className="field__label">{t('filter.keyword')}</span>
              <input
                type="text"
                value={filter.keyword ?? ''}
                onChange={(e) => set({ keyword: e.target.value === '' ? undefined : e.target.value })}
                placeholder={t('filter.keywordPlaceholder')}
                data-testid="filter-keyword"
                className="input input--compact"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={filter.overdue === true}
                onChange={(e) => set({ overdue: e.target.checked ? true : undefined })}
                data-testid="filter-overdue"
              />
              {t('filter.overdue')}
            </label>
            <div className="field filter-panel__field--full">
              <span className="field__label" id={statusLabelId}>
                {t('filter.status')}
              </span>
              <Segmented
                labelId={statusLabelId}
                testId="filter-status"
                activeIndex={statusIndex}
                options={STATUS_OPTIONS.map((option) => ({ label: t(option.labelKey) }))}
                onSelect={(index) => set({ status: STATUS_OPTIONS[index].value })}
              />
            </div>
            <label className="field">
              <span className="field__label">{t('filter.deadlineBefore')}</span>
              <input
                type="datetime-local"
                step={1}
                value={filter.deadlineBefore !== undefined ? epochToLocalInput(filter.deadlineBefore) : ''}
                onChange={(e) => setDatetime('deadlineBefore', e.target.value)}
                data-testid="filter-deadline-before"
                className="input input--compact input--mono"
              />
            </label>
            <label className="field">
              <span className="field__label">{t('filter.createdAfter')}</span>
              <input
                type="datetime-local"
                step={1}
                value={filter.createdAfter !== undefined ? epochToLocalInput(filter.createdAfter) : ''}
                onChange={(e) => setDatetime('createdAfter', e.target.value)}
                data-testid="filter-created-after"
                className="input input--compact input--mono"
              />
            </label>
            <label className="field">
              <span className="field__label">{t('filter.createdBefore')}</span>
              <input
                type="datetime-local"
                step={1}
                value={filter.createdBefore !== undefined ? epochToLocalInput(filter.createdBefore) : ''}
                onChange={(e) => setDatetime('createdBefore', e.target.value)}
                data-testid="filter-created-before"
                className="input input--compact input--mono"
              />
            </label>
            <div className="field filter-panel__field--full">
              <span className="field__label" id={modeLabelId}>
                {t('filter.mode')}
              </span>
              <Segmented
                labelId={modeLabelId}
                testId="filter-mode"
                activeIndex={modeIndex}
                options={MODE_OPTIONS.map((option) => ({ label: t(option.labelKey) }))}
                onSelect={(index) => onModeChange(MODE_OPTIONS[index].value)}
              />
            </div>
            {active && (
              <div className="filter-panel__actions">
                <button type="button" onClick={clear} data-testid="filter-clear" className="btn btn--sm">
                  {t('filter.clear')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
