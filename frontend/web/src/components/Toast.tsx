import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { CheckIcon, XIcon } from './icons';

type ToastTone = 'success' | 'error';

interface ToastEntry {
  id: number;
  tone: ToastTone;
  message: string;
  leaving: boolean;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

/** How long a toast reads before it starts leaving, and how long the exit takes. */
const LIFETIME_MS = 2800;
const EXIT_MS = 200;
/** Old toasts give way to new ones instead of growing a column down the page. */
const MAX_VISIBLE = 3;

const noop = (): void => {};

/**
 * Standalone component tests render pages without the provider; the fallback
 * keeps them working while the app mounts the provider once in `main.tsx`.
 */
const ToastContext = createContext<ToastApi>({ success: noop, error: noop });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/**
 * Success/error confirmations for actions whose effect is not visible where the
 * button sits (saved settings, a toggled subscription). Rendered into a fixed
 * viewport so any page can raise one without moving layout.
 */
export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<number>());

  const later = useCallback((run: () => void, delay: number): void => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      run();
    }, delay);
    timers.current.add(id);
  }, []);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current.clear();
    },
    [],
  );

  const dismiss = useCallback(
    (id: number): void => {
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
      later(() => setToasts((current) => current.filter((toast) => toast.id !== id)), EXIT_MS);
    },
    [later],
  );

  const push = useCallback(
    (tone: ToastTone, message: string): void => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, tone, message, leaving: false }].slice(-MAX_VISIBLE));
      later(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss, later],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={toast.leaving ? `toast toast--${toast.tone} is-leaving` : `toast toast--${toast.tone}`}
            data-testid={`toast-${toast.tone}`}
          >
            <span className="toast__icon" aria-hidden="true">
              {toast.tone === 'success' ? (
                <CheckIcon className="toast__glyph toast__glyph--check" />
              ) : (
                <XIcon className="toast__glyph" />
              )}
            </span>
            <span className="toast__message">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
