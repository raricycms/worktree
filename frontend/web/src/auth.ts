import type {
  AuthResponse,
  LoginRequest,
  RecoverRequest,
  RecoveryCodeResponse,
  RegisterRequest,
  RegisterResponse,
  TokensResponse,
} from '@worktree/core';
import {
  isAuthResponse,
  isRecoveryCodeResponse,
  isRecord,
  isRegisterResponse,
  isTokensResponse,
} from '@worktree/core';

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function baseOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function errorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const parsed: unknown = await res.json();
    if (isRecord(parsed) && typeof parsed.error === 'string') message = parsed.error;
  } catch {
    // non-JSON error body
  }
  return message;
}

async function jsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new AuthError(res.status, 'malformed response');
  }
}

/**
 * Calls a public auth endpoint directly (not via ServerAPI, which is bound
 * to a token at construction). Throws AuthError with the server's message.
 */
export async function authRequest(
  baseUrl: string,
  path: '/api/register',
  body: RegisterRequest,
): Promise<RegisterResponse>;
export async function authRequest(
  baseUrl: string,
  path: '/api/login',
  body: LoginRequest,
): Promise<AuthResponse>;
export async function authRequest(
  baseUrl: string,
  path: '/api/logout',
  body: object,
  token: string,
): Promise<{ ok: boolean }>;
export async function authRequest(
  baseUrl: string,
  path: '/api/recover',
  body: RecoverRequest,
): Promise<RecoveryCodeResponse>;
export async function authRequest(
  baseUrl: string,
  path: '/api/password' | '/api/recovery-code',
  body: object,
  token: string,
): Promise<RecoveryCodeResponse>;
export async function authRequest(
  baseUrl: string,
  path: '/api/register' | '/api/login' | '/api/logout' | '/api/recover' | '/api/password' | '/api/recovery-code',
  body: object,
  token?: string,
): Promise<AuthResponse | RegisterResponse | RecoveryCodeResponse | { ok: boolean }> {
  const res = await fetch(baseOf(baseUrl) + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AuthError(res.status, await errorMessage(res));
  const parsed = await jsonBody(res);
  if (path === '/api/register') {
    if (!isRegisterResponse(parsed)) throw new AuthError(res.status, 'malformed response');
    return parsed;
  }
  if (path === '/api/login') {
    if (!isAuthResponse(parsed)) throw new AuthError(res.status, 'malformed response');
    return parsed;
  }
  if (path === '/api/logout') {
    if (!isRecord(parsed) || parsed.ok !== true) throw new AuthError(res.status, 'malformed response');
    return { ok: true };
  }
  if (!isRecoveryCodeResponse(parsed)) throw new AuthError(res.status, 'malformed response');
  return parsed;
}

/** GET /api/tokens — every device token on this account. */
export async function listTokensRequest(baseUrl: string, token: string): Promise<TokensResponse> {
  const res = await fetch(baseOf(baseUrl) + '/api/tokens', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AuthError(res.status, await errorMessage(res));
  const parsed = await jsonBody(res);
  if (!isTokensResponse(parsed)) throw new AuthError(res.status, 'malformed response');
  return parsed;
}

/** DELETE /api/tokens/:id — revoke one device token. */
export async function revokeTokenRequest(
  baseUrl: string,
  token: string,
  tokenId: number,
): Promise<{ ok: boolean }> {
  const res = await fetch(`${baseOf(baseUrl)}/api/tokens/${tokenId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AuthError(res.status, await errorMessage(res));
  const parsed = await jsonBody(res);
  if (!isRecord(parsed) || parsed.ok !== true) throw new AuthError(res.status, 'malformed response');
  return { ok: true };
}
