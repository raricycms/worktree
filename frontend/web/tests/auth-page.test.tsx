import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../src/i18n';
import { AuthPage } from '../src/pages/AuthPage';

const SERVER = 'http://localhost:3000';

function renderPage(props: Partial<Parameters<typeof AuthPage>[0]> = {}) {
  const onAuthed = vi.fn();
  const onUseLocal = vi.fn();
  render(
    <I18nProvider lang="en">
      <AuthPage serverUrl={SERVER} user="alice" onAuthed={onAuthed} onUseLocal={onUseLocal} {...props} />
    </I18nProvider>,
  );
  return { onAuthed, onUseLocal };
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const fillAndSubmit = async (username = 'alice', password = 'hunter2222') => {
  fireEvent.change(screen.getByTestId('auth-username'), { target: { value: username } });
  fireEvent.change(screen.getByTestId('auth-password'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('auth-submit'));
};

describe('AuthPage', () => {
  it('keeps the plain register flow on a server without recovery codes', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ username: 'alice', token: 'tok-3', tokenId: 5 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { onAuthed } = renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-register'));
    await fillAndSubmit();
    await waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith('alice', { token: 'tok-3', tokenId: 5, label: undefined }),
    );
  });

  it('reports an unavailable recovery endpoint instead of a wrong code', async () => {
    stubFetch(() => new Response('', { status: 401 }));
    renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-recover'));
    fireEvent.change(screen.getByTestId('auth-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('auth-recovery-input'), { target: { value: 'ABCD-1234' } });
    fireEvent.change(screen.getByTestId('auth-password'), { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-error').textContent).toBe(
        'This server does not support account recovery yet.',
      ),
    );
  });

  it('logs in and reports the issued token', async () => {
    const calls = stubFetch(() =>
      new Response(JSON.stringify({ username: 'alice', token: 'tok-1', tokenId: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { onAuthed } = renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith('alice', { token: 'tok-1', tokenId: 3, label: undefined }));
    expect(calls[0]!.url).toBe(`${SERVER}/api/login`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ username: 'alice', password: 'hunter2222' });
  });

  it('registers, shows the one-time recovery code, then reports the token', async () => {
    const calls = stubFetch(() =>
      new Response(
        JSON.stringify({ username: 'alice', token: 'tok-2', tokenId: 4, recoveryCode: 'ABCD-EF01-2345-6789-ABCD' }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const { onAuthed } = renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-register'));
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByTestId('auth-recovery-value')).toHaveProperty('value', 'ABCD-EF01-2345-6789-ABCD'));
    expect(onAuthed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('auth-recovery-continue'));
    expect(onAuthed).toHaveBeenCalledWith('alice', { token: 'tok-2', tokenId: 4, label: undefined });
    expect(calls[0]!.url).toBe(`${SERVER}/api/register`);
  });

  it('resets a password with the recovery code and shows the new code', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ recoveryCode: 'NEW1-CODE-2345-6789-ABCD' }), { status: 200 }));
    renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-recover'));
    fireEvent.change(screen.getByTestId('auth-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('auth-recovery-input'), { target: { value: 'OLD1-CODE-2345-6789-ABCD' } });
    fireEvent.change(screen.getByTestId('auth-password'), { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-recovery-value')).toHaveProperty('value', 'NEW1-CODE-2345-6789-ABCD'),
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      username: 'alice',
      recoveryCode: 'OLD1-CODE-2345-6789-ABCD',
      newPassword: 'newpass123',
    });
    expect(calls[0]!.url).toBe(`${SERVER}/api/recover`);
  });

  it('reports an invalid recovery code', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid recovery code' }), { status: 400 }));
    renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-recover'));
    fireEvent.change(screen.getByTestId('auth-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('auth-recovery-input'), { target: { value: 'bad-code' } });
    fireEvent.change(screen.getByTestId('auth-password'), { target: { value: 'newpass123' } });
    fireEvent.click(screen.getByTestId('auth-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('auth-error').textContent).toBe('Invalid username or recovery code'),
    );
  });

  it('sends the device label when provided', async () => {
    const calls = stubFetch(() =>
      new Response(JSON.stringify({ username: 'alice', token: 'tok-1', tokenId: 3 }), { status: 200 }),
    );
    const { onAuthed } = renderPage();
    fireEvent.change(screen.getByTestId('auth-label'), { target: { value: '  my phone ' } });
    await fillAndSubmit();
    await waitFor(() => expect(onAuthed).toHaveBeenCalledWith('alice', { token: 'tok-1', tokenId: 3, label: 'my phone' }));
    expect(JSON.parse(calls[0]!.init.body as string).label).toBe('my phone');
  });

  it('shows the invalid-credentials message on 401', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid username or password' }), { status: 401 }));
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByTestId('auth-error').textContent).toBe('Invalid username or password'));
  });

  it('shows the username-taken message on 409', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'username taken' }), { status: 409 }));
    renderPage();
    fireEvent.click(screen.getByTestId('auth-mode-register'));
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByTestId('auth-error').textContent).toBe('Username already taken'));
  });

  it('rejects a short password locally', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 500 }));
    renderPage();
    await fillAndSubmit('alice', 'short');
    await waitFor(() =>
      expect(screen.getByTestId('auth-error').textContent).toBe('Password must be at least 8 characters'),
    );
    expect(calls).toHaveLength(0);
  });

  it('offers the local user as an escape hatch', () => {
    const { onUseLocal } = renderPage();
    fireEvent.click(screen.getByTestId('auth-use-local'));
    expect(onUseLocal).toHaveBeenCalled();
  });
});
