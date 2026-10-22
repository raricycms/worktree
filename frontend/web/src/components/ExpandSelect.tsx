import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronDownIcon } from './icons';

export interface ExpandOption {
  value: string;
  label: string;
}

/**
 * An option list that unfolds from its own trigger inside the page flow,
 * instead of opening a native popup: the panel is part of the layout, so it
 * can never cover the page or escape the viewport, and expanding/collapsing
 * both animate. The panel stays mounted so the collapse transition can run;
 * while closed it is `inert`, so no control inside it is reachable.
 */
export function ExpandSelect(props: {
  value: string;
  options: ExpandOption[];
  onChange: (value: string) => void;
  /** Accessible name of the list and its trigger. */
  label: string;
  /** Placed on the trigger so a page keeps one stable handle per control. */
  testId?: string;
  className?: string;
}): ReactElement {
  const { value, options, onChange, label, testId, className } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const doc = rootRef.current?.ownerDocument;
    if (doc === undefined) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    doc.addEventListener('pointerdown', onPointerDown);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);
  const rootClass = ['expand-select', open ? 'is-open' : '', className ?? ''].filter((part) => part !== '').join(' ');

  return (
    <div ref={rootRef} className={rootClass} role="group" aria-label={label}>
      <button
        type="button"
        className="expand-select__toggle"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        data-testid={testId}
      >
        <span className="expand-select__label">{current?.label ?? ''}</span>
        <ChevronDownIcon className="expand-select__chevron icon icon--sm" />
      </button>
      <div className="expand-select__panel" id={listId} inert={!open}>
        <div className="expand-select__clip">
          <div className="expand-select__list" role="listbox" aria-label={label}>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className="expand-select__option"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                data-testid={testId === undefined ? undefined : `${testId}-option-${option.value}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
