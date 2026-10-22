import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { StoredChatMessage } from '../agent-chat-storage';

/**
 * Assistant replies often use `**bold**`; render it as emphasis instead of
 * showing raw asterisks. Everything else stays literal text (React escapes it),
 * and line breaks survive through the message's pre-wrap styling.
 */
function renderText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  text.split('\n').forEach((line, lineIndex) => {
    if (lineIndex > 0) nodes.push('\n');
    line.split(/(\*\*[^*]+\*\*)/g).forEach((part, partIndex) => {
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
        nodes.push(<strong key={`b-${lineIndex}-${partIndex}`}>{part.slice(2, -2)}</strong>);
      } else if (part !== '') {
        nodes.push(part);
      }
    });
  });
  return nodes;
}

/** Localized names for the agent's tool calls. Unknown tools fall back to their wire name. */
const TOOL_LABEL_KEYS: Record<string, string> = {
  get_agenda: 'agent.tool.getAgenda',
  search_tasks: 'agent.tool.searchTasks',
  get_task: 'agent.tool.getTask',
  find_free_slots: 'agent.tool.findFreeSlots',
  suggest_tasks: 'agent.tool.suggestTasks',
  create_event: 'agent.tool.createEvent',
  create_task: 'agent.tool.createTask',
  create_recurring: 'agent.tool.createRecurring',
  update_event: 'agent.tool.updateEvent',
  complete_task: 'agent.tool.completeTask',
  cancel_event: 'agent.tool.cancelEvent',
};

/**
 * One chat message. An assistant turn that used tools carries the steps as a
 * disclosure: collapsed to a count until opened, so the reply stays readable.
 */
export function ChatMessage({ message }: { message: StoredChatMessage }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasSteps = message.steps.length > 0;

  return (
    <article
      className={`agent-msg agent-msg--${message.role}`}
      data-role={message.role}
      data-testid={`agent-message-${message.role}`}
    >
      <p className="agent-msg__text">{renderText(message.text)}</p>
      {hasSteps && (
        <div className={`agent-steps${open ? ' is-open' : ''}`}>
          <button
            type="button"
            className="btn btn--xs agent-steps__toggle"
            aria-expanded={open}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            data-testid="agent-steps-toggle"
          >
            {t('agent.steps.count', { n: message.steps.length })}
          </button>
          <div className="agent-steps__panel" inert={!open}>
            <ul className="agent-steps__list" aria-label={t('agent.steps.label')}>
              {message.steps.map((step, index) => (
                <li
                  key={`${step.tool}-${index}`}
                  className="agent-steps__item"
                  data-ok={step.ok}
                  data-testid="agent-step"
                >
                  <span className="pill">{t(TOOL_LABEL_KEYS[step.tool] ?? step.tool)}</span>
                  <span className="agent-steps__summary tiny muted">{step.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}
