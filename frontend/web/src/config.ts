import {
  DEFAULT_CAPTURE_PATH,
  USER_RE,
  daysFromCivil,
  isRecord,
  isValidCivilDate,
  normalizeCapturePath,
  weekdayFromDays,
} from '@worktree/core';
import type { CivilDate, NodeFilter } from '@worktree/core';
import { DEFAULT_AUTO_REMINDER_PCT, clampAutoReminderPct } from '@worktree/client';
import type { Semester } from '@worktree/agent';
import { isThemePref } from './theme';
import type { ThemePref } from './theme';

export const DEFAULT_SERVER = 'https://worktree.fuyuzheju.cn';
export const LOCAL_USER = 'local';

/** Known remote servers, offered in Settings as one-click presets. */
export const SERVER_PRESETS = [DEFAULT_SERVER, 'https://wkt.raricy.com'];

export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = 'deepseek-flash';
const MAX_SEMESTER_WEEKS = 60;

/**
 * The browser-side model endpoint. The key is device-local: it is never sent
 * to the worktree server, only to `baseUrl` (see docs/agent.md).
 */
export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Teaching calendar for the timetable import; null until configured. */
  semester: Semester | null;
}

export const DEFAULT_AI: AiConfig = {
  baseUrl: DEFAULT_AI_BASE_URL,
  model: DEFAULT_AI_MODEL,
  apiKey: '',
  semester: null,
};

/** How an active filter renders: hide non-matching nodes, or highlight matches. */
export type FilterDisplayMode = 'hide' | 'highlight';

export interface DisplayPrefs {
  showId: boolean;
  showWeight: boolean;
  showReminders: boolean;
  filterMode: FilterDisplayMode;
}

/** Auto-reminder on the first deadline set; fires with pct of the window remaining. */
export interface AutoReminderSetting {
  enabled: boolean;
  pct: number;
}

export interface AppConfig {
  serverUrl: string;
  user: string;
  display: DisplayPrefs;
  /** Tree filter criteria, persisted so they survive reloads. */
  filter: NodeFilter;
  lang: string;
  /** Day columns shown in the calendar grid (3–9). */
  calendarDays: number;
  autoReminder: AutoReminderSetting;
  /** Where the capture overlay (⌘K / ?quick=1) adds nodes. */
  quickAddPath: string;
  /** Light, dark, or follow the OS. */
  theme: ThemePref;
  /** Chat endpoint and teaching calendar for the scheduling agent. */
  ai: AiConfig;
}

const CONFIG_KEY = 'worktree.config';

const defaultConfig: AppConfig = {
  serverUrl: DEFAULT_SERVER,
  user: LOCAL_USER,
  display: { showId: true, showWeight: true, showReminders: true, filterMode: 'hide' },
  filter: {},
  lang: 'en',
  calendarDays: 7,
  autoReminder: { enabled: true, pct: DEFAULT_AUTO_REMINDER_PCT },
  quickAddPath: DEFAULT_CAPTURE_PATH,
  theme: 'system',
  ai: DEFAULT_AI,
};

/** A fresh default config: callers may hold onto the result without sharing state. */
function defaultConfigCopy(): AppConfig {
  return { ...defaultConfig, ai: { ...DEFAULT_AI } };
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A stored semester is only usable when its anchor is a real Monday. */
function parseSemester(raw: unknown): Semester | null {
  if (!isRecord(raw) || !isRecord(raw.firstMonday)) return null;
  const { year, month, day } = raw.firstMonday;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null;
  const firstMonday: CivilDate = { year, month, day };
  if (!isValidCivilDate(firstMonday)) return null;
  if (weekdayFromDays(daysFromCivil(year, month, day)) !== 1) return null;
  const totalWeeks = raw.totalWeeks;
  if (
    typeof totalWeeks !== 'number' ||
    !Number.isInteger(totalWeeks) ||
    totalWeeks < 1 ||
    totalWeeks > MAX_SEMESTER_WEEKS
  ) {
    return null;
  }
  return { firstMonday, totalWeeks };
}

function parseAi(raw: unknown): AiConfig {
  if (!isRecord(raw)) return { ...DEFAULT_AI };
  const baseUrl =
    typeof raw.baseUrl === 'string' && validHttpUrl(raw.baseUrl.trim())
      ? raw.baseUrl.trim()
      : DEFAULT_AI_BASE_URL;
  const model =
    typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : DEFAULT_AI_MODEL;
  return {
    baseUrl,
    model,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    semester: parseSemester(raw.semester),
  };
}

function parseAutoReminder(raw: unknown): AutoReminderSetting {
  if (!isRecord(raw)) return defaultConfig.autoReminder;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : defaultConfig.autoReminder.enabled;
  const pct =
    typeof raw.pct === 'number' && Number.isFinite(raw.pct)
      ? clampAutoReminderPct(raw.pct)
      : defaultConfig.autoReminder.pct;
  return { enabled, pct };
}

function parseFilter(raw: unknown): NodeFilter {
  if (!isRecord(raw)) return {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    keyword: str(raw.keyword),
    nameContains: str(raw.nameContains),
    noteContains: str(raw.noteContains),
    deadlineBefore: num(raw.deadlineBefore),
    hasDeadline: bool(raw.hasDeadline),
    overdue: bool(raw.overdue),
    createdAfter: num(raw.createdAfter),
    createdBefore: num(raw.createdBefore),
    status: bool(raw.status),
  };
}

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfigCopy();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultConfigCopy();
    const display = isRecord(parsed.display) ? parsed.display : {};
    return {
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : defaultConfig.serverUrl,
      user: typeof parsed.user === 'string' ? parsed.user : defaultConfig.user,
      display: {
        showId: typeof display.showId === 'boolean' ? display.showId : defaultConfig.display.showId,
        showWeight: typeof display.showWeight === 'boolean' ? display.showWeight : defaultConfig.display.showWeight,
        showReminders: typeof display.showReminders === 'boolean' ? display.showReminders : defaultConfig.display.showReminders,
        filterMode:
          display.filterMode === 'highlight' || display.filterMode === 'hide'
            ? display.filterMode
            : defaultConfig.display.filterMode,
      },
      filter: parseFilter(parsed.filter),
      lang: typeof parsed.lang === 'string' ? parsed.lang : defaultConfig.lang,
      calendarDays: typeof parsed.calendarDays === 'number' ? parsed.calendarDays : defaultConfig.calendarDays,
      autoReminder: parseAutoReminder(parsed.autoReminder),
      quickAddPath: parseCapturePath(parsed.quickAddPath),
      theme: isThemePref(parsed.theme) ? parsed.theme : defaultConfig.theme,
      ai: parseAi(parsed.ai),
    };
  } catch {
    return defaultConfigCopy();
  }
}

/** The stored capture path when it is well-formed, the default otherwise. */
function parseCapturePath(raw: unknown): string {
  if (typeof raw !== 'string') return defaultConfig.quickAddPath;
  try {
    normalizeCapturePath(raw);
  } catch {
    return defaultConfig.quickAddPath;
  }
  return raw;
}

export function saveConfig(config: AppConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('failed to save config:', e);
  }
}

/**
 * The ClientStorage namespace, mirroring the CLI's per (server, user) state
 * layout: the reserved user `local` is device-local and server-independent.
 */
export function stateKey(serverUrl: string, user: string): string {
  if (user === LOCAL_USER) return 'worktree.state.local';
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const sanitized = user.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `worktree.state.${host}.${sanitized}`;
}

/** A device token as issued by register/login. */
export interface StoredToken {
  token: string;
  tokenId: number;
  label?: string;
}

export function tokenKey(serverUrl: string, user: string): string {
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const sanitized = user.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `worktree.token.${host}.${sanitized}`;
}

export function loadToken(serverUrl: string, user: string): StoredToken | null {
  try {
    const raw = localStorage.getItem(tokenKey(serverUrl, user));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0 || typeof parsed.tokenId !== 'number') {
      return null;
    }
    return {
      token: parsed.token,
      tokenId: parsed.tokenId,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
    };
  } catch {
    return null;
  }
}

export function saveToken(serverUrl: string, user: string, stored: StoredToken): void {
  try {
    localStorage.setItem(tokenKey(serverUrl, user), JSON.stringify(stored));
  } catch (e) {
    console.error('failed to save token:', e);
  }
}

export function clearToken(serverUrl: string, user: string): void {
  try {
    localStorage.removeItem(tokenKey(serverUrl, user));
  } catch (e) {
    console.error('failed to clear token:', e);
  }
}

/**
 * All users logged in on this device for the given server (i.e. with a
 * stored token). Usernames are USER_RE-valid, so the sanitized key suffix
 * is always the exact name.
 */
export function listLoggedInUsers(serverUrl: string): string[] {
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const prefix = `worktree.token.${host}.`;
  const users: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (USER_RE.test(name)) users.push(name);
    }
  } catch (e) {
    console.error('failed to list tokens:', e);
  }
  return users.sort();
}
