import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT_ID } from '@worktree/core';
import type { HistoryNode, TreeOperation } from '@worktree/core';
import {
  buildHistoryBackup,
  downloadHistoryBackup,
  historyBackupFilename,
  parseHistoryBackup,
  readFileText,
} from '../src/data-transfer';

const add = (id: string, parentId = ROOT_ID): TreeOperation => ({
  kind: 'add',
  parentId,
  id,
  name: id,
  weight: 1,
});

const entries: HistoryNode[] = [
  { id: 'h1', op: add('a') },
  { id: 'h2', op: add('b', 'a') },
];

/** A local-time date, because the filename is dated in the device's time zone. */
const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime();

function backupText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'worktree-history',
    version: 1,
    exportedAt: NOW,
    user: 'alice',
    server: 'https://s.example',
    entries,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildHistoryBackup', () => {
  it('builds the versioned payload from confirmed history', () => {
    const backup = buildHistoryBackup('alice', 'https://s.example', entries, NOW);
    expect(backup).toEqual({
      format: 'worktree-history',
      version: 1,
      exportedAt: NOW,
      user: 'alice',
      server: 'https://s.example',
      entries,
    });
  });

  it('does not alias the caller’s entry array', () => {
    const source = [...entries];
    const backup = buildHistoryBackup('alice', 'https://s.example', source, NOW);
    source.push({ id: 'h3', op: add('c') });
    expect(backup.entries).toHaveLength(2);
  });
});

describe('parseHistoryBackup', () => {
  it('round-trips a built backup', () => {
    const built = buildHistoryBackup('alice', 'https://s.example', entries, NOW);
    expect(parseHistoryBackup(JSON.stringify(built))).toEqual(built);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseHistoryBackup('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON value that is not an object', () => {
    expect(() => parseHistoryBackup('[]')).toThrow(/must contain an object/);
  });

  it('rejects another format marker', () => {
    expect(() => parseHistoryBackup(backupText({ format: 'something-else' }))).toThrow(/format marker/);
  });

  it('rejects an unknown version', () => {
    expect(() => parseHistoryBackup(backupText({ version: 2 }))).toThrow(/unsupported backup version: 2/);
  });

  it('rejects a missing or invalid export timestamp', () => {
    expect(() => parseHistoryBackup(backupText({ exportedAt: 'yesterday' }))).toThrow(/export timestamp/);
    expect(() => parseHistoryBackup(backupText({ exportedAt: -1 }))).toThrow(/export timestamp/);
  });

  it('rejects a missing user or server', () => {
    expect(() => parseHistoryBackup(backupText({ user: '' }))).toThrow(/missing user/);
    expect(() => parseHistoryBackup(backupText({ server: 42 }))).toThrow(/missing server/);
  });

  it('rejects malformed entries', () => {
    expect(() => parseHistoryBackup(backupText({ entries: {} }))).toThrow(/entries must be an array/);
    expect(() => parseHistoryBackup(backupText({ entries: [{ id: 'h1' }] }))).toThrow(/not a history node/);
  });

  it('rejects duplicate entry ids', () => {
    const duplicated = [entries[0], { ...entries[1], id: 'h1' }];
    expect(() => parseHistoryBackup(backupText({ entries: duplicated }))).toThrow(/duplicate entry id h1/);
  });
});

describe('historyBackupFilename', () => {
  it('dates the file in local time', () => {
    expect(historyBackupFilename('alice', NOW)).toBe('worktree-alice-2026-10-23.json');
  });
});

describe('downloadHistoryBackup', () => {
  it('downloads the backup through a blob URL and revokes it', () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:history';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let downloaded: string | null = null;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });

    downloadHistoryBackup('worktree-alice-2026-10-23.json', buildHistoryBackup('alice', 'https://s.example', entries, NOW));

    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/json');
    expect(blobs[0].size).toBeGreaterThan(0);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(downloaded).toBe('worktree-alice-2026-10-23.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:history');
    expect(document.body.querySelector('a')).toBeNull();
  });

  it('revokes the URL even when the click throws', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:history'), revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() =>
      downloadHistoryBackup('backup.json', buildHistoryBackup('alice', 'https://s.example', entries, NOW)),
    ).toThrow(/blocked/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:history');
  });
});

describe('readFileText', () => {
  it('reads a picked file as text', async () => {
    const text = backupText();
    await expect(readFileText(new File([text], 'backup.json', { type: 'application/json' }))).resolves.toBe(text);
  });
});
