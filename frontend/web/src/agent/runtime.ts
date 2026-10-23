import { ProviderError } from '@worktree/agent';
import type { Translate } from '../i18n';

const MINUTE_MS = 60 * 1000;

/** The device's current UTC offset in ms, whole minutes (matches the client). */
export function deviceTzOffsetMs(): number {
  return Math.round((-new Date().getTimezoneOffset() * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
}

/** Abort is a user action, not a failure: the UI reports it as "stopped". */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError';
  return error instanceof Error && error.name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a provider/transport failure to an actionable message. Status codes are
 * the only reliable signal the OpenAI-compatible endpoint gives us; the HTTP
 * message is kept for the cases the catalogue has no wording for.
 */
export function agentErrorText(error: unknown, t: Translate): string {
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) return t('agent.error.unauthorized');
    if (error.status === 402) return t('agent.error.quota');
    if (error.status === 429) return t('agent.error.rateLimit');
    // A 400 that names an image/vision/modality problem means the configured
    // model is text-only, which the user can only fix by changing the model.
    if (error.status === 400 && /image|vision|modal/i.test(error.message)) {
      return t('agent.error.imageUnsupported');
    }
    if (error.status !== undefined) {
      return t('agent.error.status', { status: error.status, message: error.message });
    }
    return t('agent.error.generic', { message: error.message });
  }
  return t('agent.error.generic', { message: messageOf(error) });
}
