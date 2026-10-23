import { useState } from 'react';
import type { ReactElement } from 'react';
import type { AskUserRequest } from '@worktree/agent';
import { useI18n } from '../../i18n';

/**
 * The model's pause for a missing detail: the question, quick-answer buttons,
 * and an "Other…" free-text escape hatch. Picking an option answers at once.
 */
export function AskCard({
  request,
  disabled = false,
  onAnswer,
}: {
  request: AskUserRequest;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
}): ReactElement {
  const { t } = useI18n();
  const [otherOpen, setOtherOpen] = useState(request.options.length === 0);
  const [draft, setDraft] = useState('');
  const canSubmit = draft.trim() !== '' && !disabled;

  const submit = (): void => {
    if (!canSubmit) return;
    onAnswer(draft.trim());
  };

  return (
    <div className="agent-ask" data-testid="agent-ask" role="group" aria-label={t('agent.ask.title')}>
      <p className="agent-ask__question">{request.question}</p>
      {request.options.length > 0 && (
        <div className="agent-ask__options">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn btn--sm agent-ask__option"
              disabled={disabled}
              onClick={() => onAnswer(option)}
              data-testid="agent-ask-option"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {!otherOpen ? (
        <button
          type="button"
          className="btn btn--xs btn--link agent-ask__other"
          disabled={disabled}
          onClick={() => setOtherOpen(true)}
          data-testid="agent-ask-other"
        >
          {t('agent.ask.other')}
        </button>
      ) : (
        <form
          className="agent-ask__form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('agent.ask.otherPlaceholder')}
            aria-label={t('agent.ask.other')}
            disabled={disabled}
            className="input input--compact agent-ask__input"
            data-testid="agent-ask-input"
            autoFocus
          />
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={!canSubmit}
            data-testid="agent-ask-submit"
          >
            {t('agent.ask.submit')}
          </button>
        </form>
      )}
    </div>
  );
}
