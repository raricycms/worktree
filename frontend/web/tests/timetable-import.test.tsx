import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeClient } from '@worktree/client';
import type { LlmResponse, LlmTransport, Semester, TimetableRow } from '@worktree/agent';
import { I18nProvider } from '../src/i18n';
import { LOCAL_USER } from '../src/config';
import { LocalStorageClientStorage } from '../src/storage';
import { TimetableImport } from '../src/components/TimetableImport';
import type { TimetableExtract } from '../src/components/TimetableImport';

// Canvas is unavailable in jsdom; the helper's own contract is not under test here.
vi.mock('../src/image', () => ({
  MAX_IMAGE_MB: 10,
  imageFileProblem: (file: File) => (file.type.startsWith('image/') ? null : 'type'),
  imageFileToJpegDataUrl: async () => 'data:image/jpeg;base64,AAAA',
}));

const SEMESTER: Semester = { firstMonday: { year: 2026, month: 9, day: 7 }, totalWeeks: 16 };

function makeClient(): WorktreeClient {
  const client = new WorktreeClient({
    serverUrl: 'http://localhost:1',
    user: LOCAL_USER,
    local: true,
    storage: new LocalStorageClientStorage('test.timetable.state'),
  });
  client.connect();
  return client;
}

/** Only reached when the injected extractor is missing: fail loudly. */
const unusedTransport: LlmTransport = {
  complete: async (): Promise<LlmResponse> => {
    throw new Error('the transport must not be used by this test');
  },
};

function makeExtract(rows: TimetableRow[]): TimetableExtract {
  return async () => ({ rows, warnings: [] });
}

function row(overrides: Partial<TimetableRow> = {}): TimetableRow {
  return { id: 'row-1', course: 'Calculus', weekday: 1, start: '08:00', end: '09:40', weeks: '1-4', ...overrides };
}

function renderImport(options: { semester?: Semester | null; extract: TimetableExtract; client?: WorktreeClient }) {
  const client = options.client ?? makeClient();
  const onSemesterChange = vi.fn();
  render(
    <I18nProvider lang="en">
      <TimetableImport
        client={client}
        semester={options.semester === undefined ? SEMESTER : options.semester}
        onSemesterChange={onSemesterChange}
        transport={unusedTransport}
        extract={options.extract}
      />
    </I18nProvider>,
  );
  return { client, onSemesterChange };
}

async function chooseImage(name = 'timetable.jpg', type = 'image/jpeg'): Promise<void> {
  const file = new File(['pixels'], name, { type });
  fireEvent.change(screen.getByTestId('timetable-file'), { target: { files: [file] } });
}

async function parseTimetable(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('timetable-parse')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('timetable-parse'));
  await waitFor(() => expect(screen.getAllByTestId('timetable-row').length).toBeGreaterThan(0));
}

beforeEach(() => {
  localStorage.clear();
});

describe('TimetableImport preview', () => {
  it('shows first/last dates for a parsed row', async () => {
    renderImport({ extract: makeExtract([row()]) });
    await chooseImage();
    await parseTimetable();

    expect(screen.getByTestId('timetable-course-0')).toHaveValue('Calculus');
    expect(screen.getByTestId('timetable-weekday-0')).toHaveValue('1');
    // Week 1 Monday is 2026-09-07, week 4 Monday is 2026-09-28.
    expect(screen.getByText('2026-09-07 – 2026-09-28')).toBeDefined();
  });

  it('edits a row and writes nothing before confirm', async () => {
    const extract = makeExtract([row()]);
    const { client } = renderImport({ extract });
    await chooseImage();
    await parseTimetable();

    fireEvent.change(screen.getByTestId('timetable-course-0'), { target: { value: 'Calculus II' } });
    fireEvent.change(screen.getByTestId('timetable-weeks-0'), { target: { value: '1-4,6-8' } });
    expect(screen.getByTestId('timetable-course-0')).toHaveValue('Calculus II');

    // Still nothing written: parse/editing only fill the preview.
    expect(client.getRules()).toHaveLength(0);
    expect(client.getConfirmed()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('timetable-confirm'));

    const result = await screen.findByTestId('timetable-result');
    expect(result.textContent).toContain('Imported 2 rules');
    const rules = client.getRules();
    expect(rules.map((rule) => rule.name)).toEqual(['Calculus II', 'Calculus II']);
    // 1-4 is one run, 6-8 a second run: one weekly rule per run.
    expect(rules[0].freq).toBe('weekly');
    expect(rules[0].byDay).toEqual([1]);
    // The preview is consumed once written.
    expect(screen.queryByTestId('timetable-row')).toBeNull();
  });

  it('removes and adds preview rows', async () => {
    renderImport({ extract: makeExtract([row()]) });
    await chooseImage();
    await parseTimetable();

    fireEvent.click(screen.getByTestId('timetable-add-row'));
    expect(screen.getAllByTestId('timetable-row')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('timetable-remove-1'));
    expect(screen.getAllByTestId('timetable-row')).toHaveLength(1);
  });

  it('reports duplicates instead of writing them twice', async () => {
    const duplicate = row({ id: 'row-2' });
    const { client } = renderImport({ extract: makeExtract([row(), duplicate]) });
    await chooseImage();
    await parseTimetable();

    expect(screen.getAllByTestId('timetable-row')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('timetable-confirm'));

    const result = await screen.findByTestId('timetable-result');
    expect(result.textContent).toContain('Imported 1 rules; 1 duplicates skipped.');
    expect(client.getRules()).toHaveLength(1);
  });
});

describe('TimetableImport validation', () => {
  it('rejects a non-image file', async () => {
    renderImport({ extract: makeExtract([row()]) });
    await chooseImage('notes.txt', 'text/plain');
    expect(screen.getByTestId('timetable-error').textContent).toContain('Choose an image file');
  });

  it('requires the semester before parsing', async () => {
    renderImport({ extract: makeExtract([row()]), semester: null });
    await chooseImage();
    await waitFor(() => expect(screen.getByTestId('timetable-image-preview')).toBeDefined());
    expect(screen.getByTestId('timetable-parse')).toBeDisabled();
    expect(screen.getByTestId('timetable-semester-first-monday')).toHaveValue('');
  });

  it('saves a Monday semester and rejects a Tuesday anchor', () => {
    const { onSemesterChange } = renderImport({ extract: makeExtract([row()]), semester: null });

    fireEvent.change(screen.getByTestId('timetable-semester-first-monday'), {
      target: { value: '2026-09-08' },
    });
    fireEvent.click(screen.getByTestId('timetable-semester-save'));
    expect(onSemesterChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('timetable-semester-error').textContent).toContain('must be a Monday');

    fireEvent.change(screen.getByTestId('timetable-semester-first-monday'), {
      target: { value: '2026-09-07' },
    });
    fireEvent.click(screen.getByTestId('timetable-semester-save'));
    expect(onSemesterChange).toHaveBeenCalledWith(SEMESTER);
  });
});
