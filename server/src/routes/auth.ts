import { Router } from 'express';
import type {
  LoginRequest,
  PasswordChangeRequest,
  RecoverRequest,
  RecoveryCodeRequest,
  RegisterRequest,
} from '@worktree/core';
import {
  LABEL_MAX_LEN,
  PASSWORD_MAX_LEN,
  PASSWORD_MIN_LEN,
  RECOVERY_CODE_INPUT_MAX_LEN,
  UsernameTakenError,
  changePassword,
  listTokens,
  loginUser,
  recoverAccount,
  registerUser,
  revokeToken,
  rotateRecoveryCode,
} from '../auth';
import type { RegistrationGate } from '../registration';
import { parseUsername } from '../user';

function readPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < PASSWORD_MIN_LEN || value.length > PASSWORD_MAX_LEN) return null;
  return value;
}

/** A current password is any non-empty value within the stored length range;
 *  it is only ever compared against the hash, never validated as a new one. */
function readCurrentPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > PASSWORD_MAX_LEN) return null;
  return value;
}

function readLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label.length === 0) return null;
  return label.length <= LABEL_MAX_LEN ? label : null;
}

/** register/login/recover — mounted at /api before the auth middleware. */
export function publicAuthRouter(gate: RegistrationGate): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const body: RegisterRequest | undefined = req.body;
    const username = parseUsername(body?.username);
    if (username === null) {
      res.status(400).json({ error: 'invalid username' });
      return;
    }
    const password = readPassword(body?.password);
    if (password === null) {
      res.status(400).json({ error: `password must be ${PASSWORD_MIN_LEN}-${PASSWORD_MAX_LEN} characters` });
      return;
    }
    if (body?.inviteCode !== undefined && (typeof body.inviteCode !== 'string' || body.inviteCode.length > 100)) {
      res.status(400).json({ error: 'invalid invite code' });
      return;
    }

    const decision = gate.check(username, body?.inviteCode);
    if (!decision.ok) {
      // `invite` mode maps these to 403 with the reason; nothing to do while
      // the only gate is open registration.
      res.status(403).json({ error: decision.reason });
      return;
    }

    try {
      const auth = await registerUser(username, password);
      res.status(201).json(auth);
    } catch (e) {
      if (e instanceof UsernameTakenError) {
        res.status(409).json({ error: 'username taken' });
        return;
      }
      throw e;
    }
  });

  router.post('/login', async (req, res) => {
    const body: LoginRequest | undefined = req.body;
    const username = parseUsername(body?.username);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (username === null || password.length === 0 || password.length > PASSWORD_MAX_LEN) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    const auth = await loginUser(username, password, readLabel(body?.label));
    if (auth === null) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    res.json(auth);
  });

  router.post('/recover', async (req, res) => {
    const body: RecoverRequest | undefined = req.body;
    const newPassword = readPassword(body?.newPassword);
    if (newPassword === null) {
      res.status(400).json({ error: `password must be ${PASSWORD_MIN_LEN}-${PASSWORD_MAX_LEN} characters` });
      return;
    }
    const username = parseUsername(body?.username);
    const recoveryCode = typeof body?.recoveryCode === 'string' ? body.recoveryCode : '';
    if (username === null || recoveryCode.length > RECOVERY_CODE_INPUT_MAX_LEN) {
      // Same answer as a wrong code: the response must not reveal whether the
      // username exists.
      res.status(400).json({ error: 'invalid recovery code' });
      return;
    }
    const rotatedCode = await recoverAccount(username, recoveryCode, newPassword);
    if (rotatedCode === null) {
      res.status(400).json({ error: 'invalid recovery code' });
      return;
    }
    res.json({ recoveryCode: rotatedCode });
  });

  return router;
}

/** logout/tokens/account security — mounted at /api after the auth middleware. */
export function authedAuthRouter(): Router {
  const router = Router();

  router.post('/logout', async (_req, res) => {
    await revokeToken(res.locals.userId, res.locals.tokenId);
    res.json({ ok: true });
  });

  router.post('/password', async (req, res) => {
    const body: PasswordChangeRequest | undefined = req.body;
    const newPassword = readPassword(body?.newPassword);
    if (newPassword === null) {
      res.status(400).json({ error: `password must be ${PASSWORD_MIN_LEN}-${PASSWORD_MAX_LEN} characters` });
      return;
    }
    const currentPassword = readCurrentPassword(body?.currentPassword);
    if (currentPassword === null) {
      res.status(401).json({ error: 'invalid current password' });
      return;
    }
    const recoveryCode = await changePassword(res.locals.userId, res.locals.tokenId, currentPassword, newPassword);
    if (recoveryCode === null) {
      res.status(401).json({ error: 'invalid current password' });
      return;
    }
    res.json({ recoveryCode });
  });

  router.post('/recovery-code', async (req, res) => {
    const body: RecoveryCodeRequest | undefined = req.body;
    const currentPassword = readCurrentPassword(body?.currentPassword);
    if (currentPassword === null) {
      res.status(401).json({ error: 'invalid current password' });
      return;
    }
    const recoveryCode = await rotateRecoveryCode(res.locals.userId, currentPassword);
    if (recoveryCode === null) {
      res.status(401).json({ error: 'invalid current password' });
      return;
    }
    res.json({ recoveryCode });
  });

  router.get('/tokens', async (_req, res) => {
    const tokens = await listTokens(res.locals.userId);
    res.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        label: t.label,
        createdAt: t.createdAt.toISOString(),
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        current: t.id === res.locals.tokenId,
      })),
    });
  });

  router.delete('/tokens/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const revoked = await revokeToken(res.locals.userId, id);
    if (!revoked) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
