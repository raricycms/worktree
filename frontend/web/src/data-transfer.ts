import { isHistoryNode, isRecord } from '@worktree/core';
import type { HistoryNode } from '@worktree/core';

/**
 * The versioned on-disk backup of one user's confirmed history. The history is
 * the only source of truth (the tree is derived from it), so exporting the
 * entries makes the whole workspace portable between devices and users.
 *
 * A backup is imported only into an empty workspace: it is a whole-history
 * replacement, not a merge (see WorktreeClient.importHistory).
 */
export interface HistoryBackup {
  format: 'worktree-history';
  version: 1;
  /** Epoch milliseconds when the backup was written. */
  exportedAt: number;
  /** The username the entries belong to (identity is not in the ops). */
  user: string;
  /** The server URL the entries came from; `local` backups never left the device. */
  server: string;
  entries: HistoryNode[];
}

/** Snapshot the given confirmed history as a backup payload. */
export function buildHistoryBackup(
  user: string,
  server: string,
  entries: HistoryNode[],
  nowMs: number,
): HistoryBackup {
  return {
    format: 'worktree-history',
    version: 1,
    exportedAt: nowMs,
    user,
    server,
    entries: [...entries],
  };
}

/**
 * Validate untrusted backup JSON and narrow it to HistoryBackup. Every field is
 * checked, entry ids must be unique, and the entries must be shaped like
 * history nodes; whether the ops actually replay is checked separately by the
 * caller (WorktreeState.fromOps), because that is semantic, not structural.
 *
 * Throws an Error with a user-facing message: the file picker turns it into
 * "This file is not a Worktree backup."
 */
export function parseHistoryBackup(text: string): HistoryBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not a Worktree backup: the file is not valid JSON');
  }
  if (!isRecord(raw)) {
    throw new Error('not a Worktree backup: the file must contain an object');
  }
  if (raw.format !== 'worktree-history') {
    throw new Error('not a Worktree backup: unexpected format marker');
  }
  if (raw.version !== 1) {
    throw new Error(`unsupported backup version: ${String(raw.version)}`);
  }
  if (typeof raw.exportedAt !== 'number' || !Number.isFinite(raw.exportedAt) || raw.exportedAt < 0) {
    throw new Error('not a Worktree backup: invalid export timestamp');
  }
  if (typeof raw.user !== 'string' || raw.user === '') {
    throw new Error('not a Worktree backup: missing user');
  }
  if (typeof raw.server !== 'string' || raw.server === '') {
    throw new Error('not a Worktree backup: missing server');
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error('not a Worktree backup: entries must be an array');
  }
  const entries: HistoryNode[] = [];
  const ids = new Set<string>();
  for (const entry of raw.entries) {
    if (!isHistoryNode(entry)) {
      throw new Error('not a Worktree backup: an entry is not a history node');
    }
    if (ids.has(entry.id)) {
      throw new Error(`not a Worktree backup: duplicate entry id ${entry.id}`);
    }
    ids.add(entry.id);
    entries.push({ id: entry.id, op: entry.op });
  }
  return {
    format: 'worktree-history',
    version: 1,
    exportedAt: raw.exportedAt,
    user: raw.user,
    server: raw.server,
    entries,
  };
}

/** `worktree-<user>-<YYYY-MM-DD>.json`, dated in the device's local time. */
export function historyBackupFilename(user: string, nowMs: number): string {
  const date = new Date(nowMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `worktree-${user}-${date.getFullYear()}-${month}-${day}.json`;
}

/**
 * Download the backup as a JSON file. A Blob + object URL + a programmatic
 * click keeps this working without a server; the URL is revoked even when the
 * click throws, so repeated exports cannot leak blob handles.
 */
export function downloadHistoryBackup(filename: string, backup: HistoryBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Read a picked file as text. FileReader is used instead of Blob.text() because
 * jsdom (the test environment) does not implement Blob.text(), and every
 * browser that runs the PWA supports FileReader.
 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`could not read ${file.name} as text`));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsText(file);
  });
}
