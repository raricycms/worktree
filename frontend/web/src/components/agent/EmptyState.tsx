import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { useI18n } from '../../i18n';
import { Calendar, Clock, ImagePlus, ListTodo, Sparkles } from './icons';

interface Suggestion {
  id: 'agenda' | 'timetable' | 'todos' | 'plan';
  icon: typeof Calendar;
  labelKey: string;
  promptKey: string;
}

const SUGGESTIONS: Suggestion[] = [
  { id: 'agenda', icon: Calendar, labelKey: 'agent.suggestion.agenda', promptKey: 'agent.suggestion.agendaPrompt' },
  { id: 'timetable', icon: ImagePlus, labelKey: 'agent.suggestion.timetable', promptKey: 'agent.suggestion.timetablePrompt' },
  { id: 'todos', icon: ListTodo, labelKey: 'agent.suggestion.todos', promptKey: 'agent.suggestion.todosPrompt' },
  { id: 'plan', icon: Clock, labelKey: 'agent.suggestion.plan', promptKey: 'agent.suggestion.planPrompt' },
];

/** Local-time greeting: the first thing a new conversation shows. */
function greetingKey(hour: number): string {
  if (hour < 12) return 'agent.empty.titleMorning';
  if (hour < 18) return 'agent.empty.titleAfternoon';
  return 'agent.empty.titleEvening';
}

/**
 * The empty thread: a greeting plus four starting points. Each card fills the
 * composer through `onSuggestion`, so the user can edit before sending.
 */
export function EmptyState({ onSuggestion }: { onSuggestion: (prompt: string) => void }): ReactElement {
  const { t } = useI18n();
  const titleKey = useMemo(() => greetingKey(new Date().getHours()), []);

  return (
    <div className="agent-empty" data-testid="agent-empty">
      <div className="agent-empty__hero">
        <span className="agent-empty__mark" aria-hidden="true">
          <Sparkles size={22} />
        </span>
        <h2 className="agent-empty__title">{t(titleKey)}</h2>
        <p className="agent-empty__subtitle">{t('agent.empty.subtitle')}</p>
      </div>
      <div className="agent-empty__grid">
        {SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.id}
              type="button"
              className="agent-suggestion"
              data-testid="agent-suggestion"
              data-suggestion={suggestion.id}
              onClick={() => onSuggestion(t(suggestion.promptKey))}
            >
              <span className="agent-suggestion__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="agent-suggestion__label">{t(suggestion.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
