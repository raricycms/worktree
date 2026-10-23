import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 9997),
  /** Interface to bind. Defaults to all interfaces for self-hosters; behind a
   *  reverse proxy, set HOST=127.0.0.1 so the port is not exposed directly. */
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  /** Only `open` today; `invite` (invite-code mode) is the reserved future value. */
  registrationMode: process.env.REGISTRATION_MODE ?? 'open',
  /** Web Push VAPID keys. Push is disabled until all three are set. */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:worktree@localhost',
  /** Reminder sweep interval in ms. */
  reminderSweepMs: Number(process.env.REMINDER_SWEEP_MS ?? 30_000),
};

export const pushEnabled =
  config.vapidPublicKey !== undefined && config.vapidPrivateKey !== undefined;
