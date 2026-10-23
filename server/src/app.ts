import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { isRecord } from '@worktree/core';
import { config } from './config';
import { createRegistrationGate } from './registration';
import { offlineGuard } from './state';
import type { HistoryStore } from './store';
import type { WsHub } from './ws';
import { submitRouter } from './routes/submit';
import { captureRouter } from './routes/capture';
import { historyRouter } from './routes/history';
import { rewriteRouter } from './routes/rewrite';
import { authedAuthRouter, publicAuthRouter } from './routes/auth';
import { pushRouter } from './routes/push';
import { userMiddleware } from './user';

/** Importing a backup rewrites the whole history, so requests can be megabytes. */
const JSON_BODY_LIMIT = '8mb';

/** A body-parser "request entity too large" error (the 413 it raises by itself). */
function isEntityTooLarge(err: unknown): boolean {
  return isRecord(err) && err.type === 'entity.too.large';
}

export interface AppContext {
  store: HistoryStore;
  hub: WsHub;
}

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // register/login are the only unauthenticated endpoints; they run before
  // the auth middleware. Everything below requires a valid bearer token.
  app.use('/api', publicAuthRouter(createRegistrationGate(config.registrationMode)));
  app.use(userMiddleware);

  // /api/rewrite is mounted before the offline guard: it triggers offline mode
  // itself while it edits the database.
  app.use('/api/rewrite', rewriteRouter(ctx.store));
  // Push subscription management also works while the user is offline.
  app.use('/api/push', pushRouter());

  app.use(offlineGuard);
  app.use('/api', authedAuthRouter());
  app.use('/api/submit', submitRouter(ctx.store, ctx.hub));
  app.use('/api/capture', captureRouter(ctx.store, ctx.hub));
  app.use('/api/history', historyRouter(ctx.store));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    // A history import larger than the limit is the user's data, not an
    // internal failure: answer with a deliberate 413 instead of a 500.
    if (isEntityTooLarge(err)) {
      res.status(413).json({ error: 'history too large' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  };
  app.use(errorHandler);

  return app;
}
