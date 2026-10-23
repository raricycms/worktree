import type { HistoryNode, HistoryOperation, ServerState } from './types';

/** POST /submit request body. */
export interface SubmitRequest {
  htrop: HistoryOperation[];
}

/** POST /register request body. `inviteCode` is ignored while registration
 * is open; reserved for the future invite-code mode. */
export interface RegisterRequest {
  username: string;
  password: string;
  inviteCode?: string;
}

/** POST /login request body. `label` names this device for token management. */
export interface LoginRequest {
  username: string;
  password: string;
  label?: string;
}

/** Success body shared by /register and /login. The raw token is returned
 * exactly once; the server only stores its hash. */
export interface AuthResponse {
  username: string;
  token: string;
  tokenId: number;
}

/** POST /register success body: the auth response plus the one-time recovery
 * code. The server stores only its hash; a second register never reveals it.
 * Servers released before account recovery omit the code — the client then
 * skips the one-time-code panel and keeps the plain auth flow. */
export interface RegisterResponse extends AuthResponse {
  recoveryCode?: string;
}

/** POST /recover request body. The code is the only credential: it resets the
 * password when every device token is gone. */
export interface RecoverRequest {
  username: string;
  recoveryCode: string;
  newPassword: string;
}

/** POST /password request body (authenticated). */
export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
}

/** POST /recovery-code request body (authenticated): rotate the code without
 * changing the password. */
export interface RecoveryCodeRequest {
  currentPassword: string;
}

/** Success body of /recover, /password and /recovery-code: the new recovery
 * code, shown exactly once. */
export interface RecoveryCodeResponse {
  recoveryCode: string;
}

/** GET /tokens response body. `current` marks the token making the request. */
export interface TokensResponse {
  tokens: Array<{
    id: number;
    label: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    current: boolean;
  }>;
}

/** POST /rewrite request body. */
export interface RewriteRequest {
  /** Id of the last history entry the client has seen; 409 when not the current head. */
  base: string | null;
  history: HistoryNode[];
}

/** 400 response body for rejected submits. */
export interface ConflictResponse {
  conflict_id: string;
  reason: string;
}

/**
 * GET /history response. `cursorFound` distinguishes a normal delta
 * (true, nodes = entries after the cursor) from a full history returned
 * because the cursor no longer exists (false — the history was rewritten).
 */
export interface HistoryPage {
  cursorFound: boolean;
  nodes: HistoryNode[];
}

/** Messages broadcast over /websocket. */
export type ServerMessage =
  | { type: 'op'; node: HistoryNode }
  | { type: 'removed'; id: string }
  | { type: 'history-replaced' }
  | { type: 'state'; state: ServerState };
