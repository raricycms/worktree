import type { Tab } from '../App';
import { useI18n } from '../i18n';

const TABS: { id: Tab; key: string }[] = [
  { id: 'tree', key: 'tabs.tree' },
  { id: 'calendar', key: 'tabs.calendar' },
  { id: 'stats', key: 'tabs.stats' },
  { id: 'settings', key: 'tabs.settings' },
];

/** Page navigation is the shared slider: the thumb slides to the current page. */
export function Tabs({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  const { t } = useI18n();
  const activeIndex = TABS.findIndex((tab) => tab.id === active);
  if (activeIndex === -1) throw new Error(`unknown tab: ${active}`);
  return (
    <nav className="segmented nav" data-count={TABS.length} data-active={activeIndex} aria-label={t('tabs.label')}>
      <span className="segmented__thumb" aria-hidden="true" />
      {TABS.map(({ id, key }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-current={active === id ? 'page' : undefined}
          className="segmented__item nav__item"
        >
          {t(key)}
        </button>
      ))}
    </nav>
  );
}
