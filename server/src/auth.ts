import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db';

export const PASSWORD_MIN_LEN = 8;
export const PASSWORD_MAX_LEN = 1024;
export const LABEL_MAX_LEN = 100;
/** Upper bound for a submitted recovery code (users may type dashes/spaces). */
export const RECOVERY_CODE_INPUT_MAX_LEN = 100;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Self-describing format so params can be raised later without a migration:
// scrypt$N=16384,r=8,p=1$<salt-b64>$<key-b64>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const n = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // Cap params: they come from our own writes, but a tampered hash must not
  // turn verification into a DoS vector.
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(m[4], 'base64');
  const expected = Buffer.from(m[5], 'base64');
  const key = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing');

/** Opaque 256-bit device token; the server only ever stores its hash. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** High-entropy tokens need no slow KDF — plain SHA-256 is correct here. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const RECOVERY_CODE_BYTES = 10;
const RECOVERY_GROUP_LEN = 4;

/** 80 bits of entropy rendered as 20 uppercase hex chars, shown to the user as
 *  five dash-separated groups of four (`ABCD-1234-...`). */
export function generateRecoveryCode(): string {
  const hex = randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += RECOVERY_GROUP_LEN) {
    groups.push(hex.slice(i, i + RECOVERY_GROUP_LEN));
  }
  return groups.join('-');
}

/** Typing tolerance: users may paste the code with dashes, spaces or lower case. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** Like tokens, the code is high entropy, so plain SHA-256 is the right hash. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

const DUMMY_RECOVERY_HASH = hashRecoveryCode('dummy-recovery-code-for-timing');

/** Timing-safe and null-safe: a missing stored hash (unknown user or a user
 *  without a recovery code) still spends the same comparison time. */
function verifyRecoveryCode(code: string, stored: string | null): boolean {
  const actual = Buffer.from(hashRecoveryCode(code), 'hex');
  const expected = Buffer.from(stored ?? DUMMY_RECOVERY_HASH, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected) && stored !== null;
}

export class UsernameTakenError extends Error {
  constructor() {
    super('username taken');
  }
}

async function createToken(userId: number, label: string | null): Promise<{ token: string; tokenId: number }> {
  const token = generateToken();
  const row = await prisma.token.create({ data: { tokenHash: hashToken(token), userId, label } });
  return { token, tokenId: row.id };
}

export async function registerUser(
  username: string,
  password: string,
): Promise<{ username: string; token: string; tokenId: number; recoveryCode: string }> {
  const passwordHash = await hashPassword(password);
  const recoveryCode = generateRecoveryCode();
  try {
    // create + P2002, never upsert: upsert would overwrite an existing
    // user's passwordHash and hand over the account.
    const user = await prisma.user.create({
      data: { name: username, passwordHash, recoveryHash: hashRecoveryCode(recoveryCode) },
    });
    const { token, tokenId } = await createToken(user.id, null);
    return { username: user.name, token, tokenId, recoveryCode };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new UsernameTakenError();
    }
    throw e;
  }
}

export async function loginUser(
  username: string,
  password: string,
  label: string | null,
): Promise<{ username: string; token: string; tokenId: number } | null> {
  const user = await prisma.user.findUnique({ where: { name: username } });
  if (!user) {
    // Burn scrypt time on unknown users too, so login timing does not
    // reveal which usernames exist.
    await verifyPassword(password, await DUMMY_HASH);
    return null;
  }
  if (user.passwordHash === null || !(await verifyPassword(password, user.passwordHash))) return null;
  const { token, tokenId } = await createToken(user.id, label);
  return { username: user.name, token, tokenId };
}

export interface ResolvedToken {
  userId: number;
  username: string;
  tokenId: number;
  lastUsedAt: Date | null;
}

export async function resolveToken(token: string): Promise<ResolvedToken | null> {
  const row = await prisma.token.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!row) return null;
  return { userId: row.userId, username: row.user.name, tokenId: row.id, lastUsedAt: row.lastUsedAt };
}

export async function listTokens(
  userId: number,
): Promise<Array<{ id: number; label: string | null; createdAt: Date; lastUsedAt: Date | null }>> {
  return prisma.token.findMany({ where: { userId }, orderBy: { id: 'asc' } });
}

export async function revokeToken(userId: number, tokenId: number): Promise<boolean> {
  const res = await prisma.token.deleteMany({ where: { id: tokenId, userId } });
  return res.count > 0;
}

/** Changes the password and rotates the recovery code, signing every other
 *  device out; the presented token stays valid. Null: wrong current password. */
export async function changePassword(
  userId: number,
  tokenId: number,
  currentPassword: string,
  newPassword: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null || user.passwordHash === null) return null;
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return null;
  const passwordHash = await hashPassword(newPassword);
  const recoveryCode = generateRecoveryCode();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, recoveryHash: hashRecoveryCode(recoveryCode) },
    });
    await tx.token.deleteMany({ where: { userId, id: { not: tokenId } } });
  });
  return recoveryCode;
}

/** Replaces the recovery code without touching the password or the tokens. */
export async function rotateRecoveryCode(userId: number, currentPassword: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user === null || user.passwordHash === null) return null;
  if (!(await verifyPassword(currentPassword, user.passwordHash))) return null;
  const recoveryCode = generateRecoveryCode();
  await prisma.user.update({ where: { id: userId }, data: { recoveryHash: hashRecoveryCode(recoveryCode) } });
  return recoveryCode;
}

/** Public account recovery: the code alone resets the password and signs every
 *  device out. Null for an unknown user, a missing code or a wrong code — all
 *  indistinguishable to the caller. */
export async function recoverAccount(
  username: string,
  recoveryCode: string,
  newPassword: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { name: username } });
  if (user === null) {
    // Unknown user: spend the same comparison time as a real verification so
    // the response timing does not reveal whether the username exists.
    void verifyRecoveryCode(recoveryCode, null);
    return null;
  }
  if (!verifyRecoveryCode(recoveryCode, user.recoveryHash)) return null;
  const passwordHash = await hashPassword(newPassword);
  const newRecoveryCode = generateRecoveryCode();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, recoveryHash: hashRecoveryCode(newRecoveryCode) },
    });
    await tx.token.deleteMany({ where: { userId: user.id } });
  });
  return newRecoveryCode;
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Throttled lastUsedAt touch — at most one UPDATE per token per hour. */
export async function touchToken(tokenId: number, lastUsedAt: Date | null): Promise<void> {
  if (lastUsedAt !== null && Date.now() - lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  try {
    await prisma.token.update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } });
  } catch {
    // Token revoked concurrently — the request itself already succeeded.
  }
}
