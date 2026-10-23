import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react';
import { useI18n } from '../../i18n';
import type { ChatAttachment } from '../../agent/conversations';
import { MAX_ATTACHMENTS } from '../../agent/attachments';
import { ImagePlus, Send, Stop, X } from './icons';

const MAX_TEXTAREA_HEIGHT = 200;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  attachments: ChatAttachment[];
  attachError: string | null;
  attaching: boolean;
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
}

/**
 * The bottom bar: attachments, an auto-growing textarea and one circular action
 * that switches between send and stop. Enter sends, Shift+Enter is a newline,
 * and IME composition never sends.
 */
export function Composer(props: ComposerProps): ReactElement {
  const { t } = useI18n();
  const {
    value,
    onChange,
    onSend,
    onStop,
    busy,
    disabled,
    attachments,
    attachError,
    attaching,
    onFiles,
    onRemoveAttachment,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const pickFiles = (): void => {
    fileRef.current?.click();
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.target.files ?? [])];
    // Reset so choosing the same file again fires change.
    event.target.value = '';
    if (files.length > 0) onFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      onFiles(files);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (busy || disabled) return;
    event.preventDefault();
    setDragging(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (busy || disabled) return;
    const files = [...event.dataTransfer.files];
    if (files.length > 0) onFiles(files);
  };

  const canSend = !disabled && !busy && (value.trim() !== '' || attachments.length > 0);

  return (
    <div
      className={`agent-composer-wrap${dragging ? ' is-dragging' : ''}`}
      data-testid="agent-composer"
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <ul className="agent-attachments" aria-label={t('agent.attach.button')}>
          {attachments.map((attachment) => (
            <li key={attachment.id} className="agent-attachment" data-testid="agent-attachment">
              <img className="agent-attachment__img" src={attachment.dataUrl} alt={attachment.name} />
              <span className="agent-attachment__name">{attachment.name}</span>
              <button
                type="button"
                className="agent-attachment__remove"
                data-testid="agent-attachment-remove"
                aria-label={t('agent.attach.remove')}
                title={t('agent.attach.remove')}
                disabled={busy}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachError !== null && (
        <p className="agent-composer__error" data-testid="agent-attach-error" role="alert">
          {attachError}
        </p>
      )}
      <form
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="agent-composer__field">
          <textarea
            ref={textareaRef}
            rows={1}
            className="agent-composer__input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={t('agent.placeholder')}
            aria-label={t('agent.placeholder')}
            disabled={busy || disabled}
            data-testid="agent-input"
          />
          <div className="agent-composer__row">
            <button
              type="button"
              className="agent-composer__attach"
              data-testid="agent-attach"
              aria-label={t('agent.attach.button')}
              title={t('agent.attach.hint', { n: MAX_ATTACHMENTS })}
              disabled={busy || disabled || attaching || attachments.length >= MAX_ATTACHMENTS}
              onClick={pickFiles}
            >
              <ImagePlus size={18} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              data-testid="agent-file-input"
              onChange={onFileChange}
            />
            {busy ? (
              <button
                type="button"
                className="agent-send agent-send--stop"
                data-testid="agent-stop"
                aria-label={t('agent.stop')}
                title={t('agent.stop')}
                onClick={onStop}
              >
                <Stop size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className="agent-send"
                data-testid="agent-send"
                aria-label={t('agent.send')}
                title={t('agent.send')}
                disabled={!canSend}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="agent-disclaimer">{t('agent.disclaimer')}</p>
    </div>
  );
}
