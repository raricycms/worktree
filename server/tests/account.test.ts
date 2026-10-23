import http from 'node:http';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prismaMock, resetDb, seedUser } from './helpers/prismaMock';

vi.mock('../src/db', () => ({ prisma: prismaMock }));

import { createApp } from '../src/app';
import { HistoryStore } from '../src/store';
import { WsHub } from '../src/ws';

const PW = 'hunter2222';
/** Five groups of four uppercase hex chars, e.g. AB12-CD34-EF56-7890-ABCD. */
const CODE_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){4}$/;

interface AccountAuth {
  username: string;
  token: string;
  tokenId: number;
  recoveryCode: string;
}

function makeApp() {
  const store = new HistoryStore();
  const hub = new WsHub(http.createServer());
  return createApp({ store, hub });
}

async function register(app: ReturnType<typeof makeApp>, username: string): Promise<AccountAuth> {
  const res = await request(app).post('/api/register').send({ username, password: PW });
  expect(res.status).toBe(201);
  return res.body as AccountAuth;
}

async function storedUser(name: string) {
  const user = await prismaMock.user.findUnique({ where: { name } });
  if (user === null) throw new Error(`user ${name} not found`);
  return user;
}

/** Compares the stored hash against an independently normalized SHA-256. */
function independentRecoveryHash(code: string): string {
  const normalized = code.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function authedPost(
  app: ReturnType<typeof makeApp>,
  path: string,
  token: string,
  body: Record<string, unknown>,
) {
  return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

describe('account recovery code at registration', () => {
  beforeEach(() => resetDb());

  it('returns a formatted recovery code exactly once and only stores its hash', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    expect(auth.recoveryCode).toMatch(CODE_RE);
    expect(auth.token).toBeTruthy();

    const row = await storedUser('alice');
    expect(row.recoveryHash).toBe(independentRecoveryHash(auth.recoveryCode));
    expect(row.recoveryHash).toHaveLength(64);
    expect(row.recoveryHash).not.toBe(auth.recoveryCode);

    // login stays unchanged: it never returns the recovery code
    const login = await request(app).post('/api/login').send({ username: 'alice', password: PW });
    expect(login.status).toBe(200);
    expect(login.body).not.toHaveProperty('recoveryCode');
  });

  it('accepts a recovery code typed with lower case and spaces instead of dashes', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const typed = auth.recoveryCode.toLowerCase().replace(/-/g, ' ');
    const res = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: typed, newPassword: 'brand-new-pass' });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCode).toMatch(CODE_RE);
  });
});

describe('POST /api/recover', () => {
  beforeEach(() => resetDb());

  it('resets the password, revokes every token, and returns a reusable new code', async () => {
    const app = makeApp();
    const first = await register(app, 'alice');
    const second = await request(app).post('/api/login').send({ username: 'alice', password: PW, label: 'phone' });
    expect(second.status).toBe(200);

    const res = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: first.recoveryCode, newPassword: 'brand-new-pass' });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCode).toMatch(CODE_RE);
    expect(res.body.recoveryCode).not.toBe(first.recoveryCode);

    expect((await request(app).post('/api/login').send({ username: 'alice', password: PW })).status).toBe(401);
    for (const token of [first.token, second.body.token]) {
      const history = await request(app).get('/api/history').set('Authorization', `Bearer ${token}`);
      expect(history.status).toBe(401);
    }
    expect(
      (await request(app).post('/api/login').send({ username: 'alice', password: 'brand-new-pass' })).status,
    ).toBe(200);

    const again = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: res.body.recoveryCode, newPassword: 'third-password' });
    expect(again.status).toBe(200);

    const stale = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: res.body.recoveryCode, newPassword: 'fourth-password' });
    expect(stale.status).toBe(400);
  });

  it('400s identically for a wrong code and an unknown user', async () => {
    const app = makeApp();
    await register(app, 'alice');
    const wrong = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: '0000-0000-0000-0000-0000', newPassword: 'brand-new-pass' });
    const unknown = await request(app)
      .post('/api/recover')
      .send({ username: 'nobody', recoveryCode: '0000-0000-0000-0000-0000', newPassword: 'brand-new-pass' });
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'invalid recovery code' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('400s with the same message for a user that has no recovery code', async () => {
    const app = makeApp();
    await seedUser('legacy');
    const res = await request(app)
      .post('/api/recover')
      .send({ username: 'legacy', recoveryCode: '0000-0000-0000-0000-0000', newPassword: 'brand-new-pass' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid recovery code' });
  });

  it('rejects a new password outside 8..1024 characters', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const short = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: auth.recoveryCode, newPassword: 'short' });
    const long = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: auth.recoveryCode, newPassword: 'x'.repeat(1025) });
    expect(short.status).toBe(400);
    expect(long.status).toBe(400);
    expect(short.body).toEqual({ error: 'password must be 8-1024 characters' });
    expect(long.body).toEqual(short.body);
  });
});

describe('POST /api/password', () => {
  beforeEach(() => resetDb());

  it('401s for a wrong current password without touching the credentials', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const res = await authedPost(app, '/api/password', auth.token, {
      currentPassword: 'wrong-password',
      newPassword: 'next-password',
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid current password' });
    expect((await request(app).post('/api/login').send({ username: 'alice', password: PW })).status).toBe(200);
    expect((await storedUser('alice')).recoveryHash).toBe(independentRecoveryHash(auth.recoveryCode));
  });

  it('changes the password, keeps the current token, signs out other devices and rotates the code', async () => {
    const app = makeApp();
    const current = await register(app, 'alice');
    const other = await request(app).post('/api/login').send({ username: 'alice', password: PW, label: 'phone' });
    expect(other.status).toBe(200);

    const res = await authedPost(app, '/api/password', current.token, {
      currentPassword: PW,
      newPassword: 'next-password',
    });
    expect(res.status).toBe(200);
    const newCode: string = res.body.recoveryCode;
    expect(newCode).toMatch(CODE_RE);
    expect(newCode).not.toBe(current.recoveryCode);
    expect((await storedUser('alice')).recoveryHash).toBe(independentRecoveryHash(newCode));

    expect((await request(app).get('/api/history').set('Authorization', `Bearer ${current.token}`)).status).toBe(200);
    expect((await request(app).get('/api/history').set('Authorization', `Bearer ${other.body.token}`)).status).toBe(401);

    expect((await request(app).post('/api/login').send({ username: 'alice', password: PW })).status).toBe(401);
    expect(
      (await request(app).post('/api/login').send({ username: 'alice', password: 'next-password' })).status,
    ).toBe(200);

    const oldCode = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: current.recoveryCode, newPassword: 'recovered-pass' });
    expect(oldCode.status).toBe(400);
    const newCodeRes = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: newCode, newPassword: 'recovered-pass' });
    expect(newCodeRes.status).toBe(200);
  });

  it('rejects an invalid new password with 400 and requires authentication', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const short = await authedPost(app, '/api/password', auth.token, {
      currentPassword: PW,
      newPassword: 'short',
    });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: 'password must be 8-1024 characters' });

    const anonymous = await request(app).post('/api/password').send({ currentPassword: PW, newPassword: 'next-password' });
    expect(anonymous.status).toBe(401);
  });
});

describe('POST /api/recovery-code', () => {
  beforeEach(() => resetDb());

  it('rotates the code and invalidates the previous one without changing the password', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const res = await authedPost(app, '/api/recovery-code', auth.token, { currentPassword: PW });
    expect(res.status).toBe(200);
    const newCode: string = res.body.recoveryCode;
    expect(newCode).toMatch(CODE_RE);
    expect(newCode).not.toBe(auth.recoveryCode);
    expect((await storedUser('alice')).recoveryHash).toBe(independentRecoveryHash(newCode));

    expect((await request(app).post('/api/login').send({ username: 'alice', password: PW })).status).toBe(200);
    const stale = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: auth.recoveryCode, newPassword: 'recovered-pass' });
    expect(stale.status).toBe(400);
    const rotated = await request(app)
      .post('/api/recover')
      .send({ username: 'alice', recoveryCode: newCode, newPassword: 'recovered-pass' });
    expect(rotated.status).toBe(200);
  });

  it('401s for a wrong current password and for an unauthenticated request', async () => {
    const app = makeApp();
    const auth = await register(app, 'alice');
    const wrong = await authedPost(app, '/api/recovery-code', auth.token, { currentPassword: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid current password' });
    expect((await storedUser('alice')).recoveryHash).toBe(independentRecoveryHash(auth.recoveryCode));

    const anonymous = await request(app).post('/api/recovery-code').send({ currentPassword: PW });
    expect(anonymous.status).toBe(401);
  });
});
