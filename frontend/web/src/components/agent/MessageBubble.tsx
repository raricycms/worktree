import type { ReactElement } from 'react';
import type { WorktreeClient } from '@worktree/client';
import type { AskUserRequest, Semester, TimetableRow } from '@worktree/agent';
import type { ChatMessage } from '../../agent/conversations';
import { useI18n } from '../../i18n';
import { AskCard } from './AskCard';
import { MarkdownText } from './MarkdownText';
import { TimetableCard } from './TimetableCard';
import { ToolSteps } from './ToolSteps';
import { Sparkles } from './icons';

export interface MessageBubbleProps {
  message: ChatMessage;
  live?: boolean;
  semester: Semester | null;
  onSemesterChange: (semester: Semester | null) => void;
  /** Needed by the timetable card for calendar-conflict analysis. */
  client: WorktreeClient;
  disabled?: boolean;
  onConfirmTimetable?: (messageId: string, rows: TimetableRow[]) => void | Promise<void>;
  onCancelTimetable?: (messageId: string) => void;
  /** A question the live turn is paused on; normally rendered by the page itself. */
  pendingAsk?: AskUserRequest | null;
  onAnswer?: (answer: string) => void;
  /** The tool currently running in a live turn, shown as a spinner row. */
  runningTool?: string | null;
}

/**
 * One transcript message. The user side sits right with the brand tint, the
 * assistant side gets the sparkle avatar and a plain surface. Images, answered
 * questions, tool steps and a timetable artifact all belong to the bubble, so
 * the page only decides which message to hand it.
 */
export function MessageBubble({
  message,
  live = false,
  semester,
  onSemesterChange,
  client,
  disabled = false,
  onConfirmTimetable,
  onCancelTimetable,
  pendingAsk = null,
  onAnswer,
  runningTool = null,
}: MessageBubbleProps): ReactElement {
  const { t } = useI18n();

  if (message.role === 'note') {
    return (
      <p className="agent-note" data-role="note" data-testid="agent-message-note">
        {message.text}
      </p>
    );
  }

  const isUser = message.role === 'user';
  const showText = message.text !== '' || live;
  const showSteps = message.steps.length > 0 || (runningTool !== null && runningTool !== undefined && runningTool !== '');

  const confirmRows = async (rows: TimetableRow[]): Promise<void> => {
    if (onConfirmTimetable === undefined) return;
    await onConfirmTimetable(message.id, rows);
  };

  const cancel = (): void => {
    onCancelTimetable?.(message.id);
  };

  return (
    <article
      className={`agent-bubble agent-bubble--${message.role}${live ? ' is-live' : ''}`}
      data-role={message.role}
      data-testid={`agent-message-${message.role}`}
    >
      {!isUser && (
        <span className="agent-bubble__avatar" aria-hidden="true">
          <Sparkles size={14} />
        </span>
      )}
      <div className="agent-bubble__body">
        {message.images.length > 0 && (
          <div className="agent-bubble__images">
            {message.images.map((attachment) => (
              <figure key={attachment.id} className="agent-bubble__image">
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  width={attachment.width}
                  height={attachment.height}
                  data-testid="agent-message-image"
                />
              </figure>
            ))}
          </div>
        )}

        {message.asks.length > 0 && (
          <ul className="agent-asks" aria-label={t('agent.ask.answered')}>
            {message.asks.map((ask, index) => (
              <li key={`${ask.question}-${index}`} className="agent-asks__item">
                <p className="agent-asks__question">{ask.question}</p>
                <p className="agent-asks__answer">
                  <span className="agent-asks__label">{t('agent.ask.answered')}</span> {ask.answer}
                </p>
              </li>
            ))}
          </ul>
        )}

        {showText && (
          <div className="agent-bubble__text" data-testid={live ? 'agent-live-text' : undefined}>
            <MarkdownText text={message.text} />
            {live && <span className="agent-bubble__caret" aria-hidden="true" />}
          </div>
        )}

        {showSteps && <ToolSteps steps={message.steps} runningTool={runningTool} />}

        {pendingAsk !== null && onAnswer !== undefined && (
          <AskCard request={pendingAsk} disabled={disabled} onAnswer={onAnswer} />
        )}

        {message.artifact !== undefined && (
          <TimetableCard
            artifact={message.artifact}
            semester={semester}
            onSemesterChange={onSemesterChange}
            disabled={disabled}
            onConfirm={confirmRows}
            onCancel={cancel}
            client={client}
          />
        )}
      </div>
    </article>
  );
}
