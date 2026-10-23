import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ROOT_ID } from '@worktree/core';
import type { HistoryNode, Operation } from '@worktree/core';
import { prismaMock, resetDb } from './helpers/prismaMock';

vi.mock('../src/db', () => ({ prisma: prismaMock }));
vi.mock('../src/config', () => ({
  config: {
    port: 9997,
    databaseUrl: 'file:./dev.db',
    registrationMode: 'open',
    vapidPublicKey: undefined,
    vapidPrivateKey: undefined,
    vapidSubject: 'mailto:test@example.com',
    reminderSweepMs: 30_000,
  },
  pushEnabled: false,
}));

import { createApp } from '../src/app';
import { HistoryStore } from '../src/store';
import { WsHub } from '../src/ws';

const PW = 'hunter2222';
const EIGHT_MB = 8 * 1024 * 1024;

function makeApp() {
  const store = new HistoryStore();
  const hub = new WsHub(http.createServer());
  return createApp({ store, hub });
}

async function register(app: ReturnType<typeof makeApp>, username: string): Promise<string> {
  const res = await request(app).post('/api/register').send({ username, password: PW });
  expect(res.status).toBe(201);
  const token: string = res.body.token;
  return token;
}

/** One small add op; 1200 of them put the JSON body well over the old 100kb limit. */
const add = (i: number): Operation => ({
  kind: 'add',
  parentId: ROOT_ID,
  id: `node-${i}`,
  name: `node ${i}`,
  weight: i,
});

describe('JSON body limit', () => {
  beforeEach(() => resetDb());

  it('answers 413 (not 500) when a request body exceeds 8 MB', async () => {
    const app = makeApp();
    const token = await register(app, 'alice');
    const huge = {
      base: null,
      history: [],
      // Not a history field; it only exists to push the body past the limit.
      padding: 'x'.repeat(EIGHT_MB + 1024 * 1024),
    };
    const res = await request(app)
      .post('/api/rewrite')
      .set('Authorization', `Bearer ${token}`)
      .send(huge);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'history too large' });
  });

  it('accepts a legitimate history larger than the old 100 kb default', async () => {
    const app = makeApp();
    const token = await register(app, 'alice');
    const history: HistoryNode[] = Array.from({ length: 1200 }, (_, i) => ({ id: `entry-${i}`, op: add(i) }));
    const payload = { base: null, history };
    const size = Buffer.byteLength(JSON.stringify(payload));
    expect(size).toBeGreaterThan(100 * 1024);
    expect(size).toBeLessThan(EIGHT_MB);

    const res = await request(app)
      .post('/api/rewrite')
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const fetched = await request(app).get('/api/history').set('Authorization', `Bearer ${token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.nodes).toHaveLength(1200);
  });
});
