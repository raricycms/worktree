import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../src/components/Toast';

function Trigger() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast.success('Saved.')}>
        Save
      </button>
      <button type="button" onClick={() => toast.error('Failed.')}>
        Fail
      </button>
    </div>
  );
}

function renderToast() {
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('shows a success confirmation with the drawn check', () => {
    renderToast();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const toast = screen.getByTestId('toast-success');
    expect(toast.textContent).toContain('Saved.');
    expect(toast.className).toContain('toast--success');
    expect(toast.querySelector('.toast__glyph--check')).not.toBeNull();
  });

  it('leaves after its lifetime and is removed once the exit ends', () => {
    vi.useFakeTimers();
    renderToast();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('toast-success').className).not.toContain('is-leaving');

    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(screen.getByTestId('toast-success').className).toContain('is-leaving');

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId('toast-success')).toBeNull();
  });

  it('uses the danger tone for errors', () => {
    renderToast();
    fireEvent.click(screen.getByRole('button', { name: 'Fail' }));
    const toast = screen.getByTestId('toast-error');
    expect(toast.className).toContain('toast--error');
    expect(toast.textContent).toContain('Failed.');
  });

  it('keeps at most three toasts on screen', () => {
    renderToast();
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(screen.getAllByTestId('toast-success')).toHaveLength(3);
  });

  it('announces toasts through one persistent live region', () => {
    renderToast();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(region.textContent).toContain('Saved.');
  });

  it('works without a provider (standalone component tests)', () => {
    render(<Trigger />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByTestId('toast-success')).toBeNull();
  });
});
