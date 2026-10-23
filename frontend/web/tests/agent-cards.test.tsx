import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { WorktreeClient } from '@worktree/client';
import type { AgentStep, Semester, TimetableRow } from '@worktree/agent';
import { I18nProvider } from '../src/i18n';
import type { Translate } from '../src/i18n';
import { messages } from '../src/i18n/messages';
import type { StringMap } from '../src/i18n/messages';
import { LOCAL_USER } from '../src/config';
import { LocalStorageClientStorage } from '../src/storage';
import type { ChatArtifact, ChatMessage } from '../src/agent/conversations';
import { MarkdownText } from '../src/components/agent/MarkdownText';
import { ToolSteps } from '../src/components/agent/ToolSteps';
import { AskCard } from '../src/components/agent/AskCard';
import { TimetableCard, localizeConflict } from '../src/components/agent/TimetableCard';
import { MessageBubble } from '../src/components/agent/MessageBubble';
import {
  Alert,
  ArrowDown,
  ArrowUp,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Grid,
  ImagePlus,
  ListTodo,
  Loader,
  Menu,
  Pencil,
  Plus,
  Send,
  Sidebar,
  Sliders,
  Sparkles,
  Stop,
  Trash,
  X,
  toolIcon,
} from '../src/components/agent/icons';

const SEMESTER: Semester = { firstMonday: { year: 2026, month: 9, day: 7 }, totalWeeks: 16 };

function withI18n(node: ReactElement): ReactElement {
  return <I18nProvider lang="en">{node}</I18nProvider>;
}

function makeClient(key = 'test.cards.state'): WorktreeClient {
  const client = new WorktreeClient({
    serverUrl: 'http://localhost:1',
    user: LOCAL_USER,
    local: true,
    storage: new LocalStorageClientStorage(key),
  });
  client.connect();
  return client;
}

function row(overrides: Partial<TimetableRow> = {}): TimetableRow {
  return {
    id: 'row-1',
    course: 'Calculus',
    weekday: 1,
    start: '08:00',
    end: '09:40',
    weeks: '1-4',
    ...overrides,
  };
}

function artifact(overrides: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    kind: 'timetable',
    rows: [row()],
    warnings: [],
    state: 'pending',
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    text: 'Here is the plan.',
    createdAt: 1,
    steps: [],
    images: [],
    asks: [],
    ...overrides,
  };
}

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return { tool: 'create_task', args: {}, summary: 'Created task “Essay”', ok: true, ...overrides };
}

beforeEach(() => {
  localStorage.clear();
});

describe('MarkdownText', () => {
  it('renders bold, inline code, bullets and numbered items', () => {
    const { container } = render(
      withI18n(<MarkdownText text={'A **bold** word and `code`.\n\n- first\n- second\n\n1. one\n2. two'} />),
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect([...container.querySelectorAll('ul > li')].map((item) => item.textContent)).toEqual(['first', 'second']);
    expect([...container.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual(['one', 'two']);
  });

  it('keeps line breaks inside a paragraph', () => {
    const { container } = render(withI18n(<MarkdownText text={'first line\nsecond line'} />));
    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('first linesecond line');
    expect(paragraph?.querySelectorAll('br')).toHaveLength(1);
  });

  it('renders http(s) links as new-tab anchors', () => {
    const { container } = render(withI18n(<MarkdownText text={'See [the docs](https://example.com/a).'} />));
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  it('never converts HTML or non-http links into markup', () => {
    const { container } = render(
      withI18n(<MarkdownText text={'<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))'} />),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
    expect(container.textContent).toContain('javascript:alert(1)');
  });
});

describe('ToolSteps', () => {
  it('starts collapsed and expands on click', () => {
    render(withI18n(<ToolSteps steps={[step(), step({ tool: 'get_agenda', ok: false, summary: 'Failed' })]} />));
    const toggle = screen.getByTestId('agent-steps-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByTestId('agent-step')).toHaveLength(2);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks failed steps with the danger tint and shows the running row', () => {
    render(withI18n(<ToolSteps steps={[step({ ok: false, summary: 'Invalid date' })]} runningTool="create_task" />));
    const rowElement = screen.getByTestId('agent-step');
    expect(rowElement.dataset.ok).toBe('false');
    expect(rowElement.textContent).toContain('Invalid date');
    expect(screen.getByTestId('agent-step-running')).toBeDefined();
  });

  it('shows the running row alone before the first step completes', () => {
    render(withI18n(<ToolSteps steps={[]} runningTool="import_timetable" />));
    expect(screen.getByTestId('agent-step-running')).toBeDefined();
    expect(screen.queryByTestId('agent-steps-toggle')).toBeNull();
    expect(screen.queryByTestId('agent-step')).toBeNull();
  });

  it('falls back to the wire name for an unknown tool', () => {
    render(withI18n(<ToolSteps steps={[step({ tool: 'mystery_tool', summary: 'did something' })]} />));
    expect(screen.getByTestId('agent-step').textContent).toContain('mystery_tool');
  });
});

describe('AskCard', () => {
  it('renders the question and answers with the clicked option', () => {
    const onAnswer = vi.fn();
    render(withI18n(<AskCard request={{ question: 'How long?', options: ['30 min', '1 hour'] }} onAnswer={onAnswer} />));
    expect(screen.getByTestId('agent-ask').textContent).toContain('How long?');

    fireEvent.click(screen.getAllByTestId('agent-ask-option')[1]);
    expect(onAnswer).toHaveBeenCalledWith('1 hour');
  });

  it('offers a free-text other answer', () => {
    const onAnswer = vi.fn();
    render(withI18n(<AskCard request={{ question: 'How long?', options: ['30 min', '1 hour'] }} onAnswer={onAnswer} />));

    fireEvent.click(screen.getByTestId('agent-ask-other'));
    fireEvent.change(screen.getByTestId('agent-ask-input'), { target: { value: '90 minutes' } });
    fireEvent.click(screen.getByTestId('agent-ask-submit'));

    expect(onAnswer).toHaveBeenCalledWith('90 minutes');
  });

  it('does not answer while disabled', () => {
    const onAnswer = vi.fn();
    render(withI18n(<AskCard request={{ question: 'Pick', options: ['A', 'B'] }} disabled onAnswer={onAnswer} />));
    fireEvent.click(screen.getAllByTestId('agent-ask-option')[0]);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('TimetableCard', () => {
  it('shows the first and last dates and edits rows without writing', async () => {
    const client = makeClient('test.cards.edit');
    const onConfirm = vi.fn();
    render(
      withI18n(
        <TimetableCard
          artifact={artifact()}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
          client={client}
        />,
      ),
    );

    expect(screen.getByTestId('agent-timetable-course-0')).toHaveValue('Calculus');
    expect(screen.getByTestId('agent-timetable-dates-0').textContent).toContain('2026-09-07');
    expect(screen.getByTestId('agent-timetable-dates-0').textContent).toContain('2026-09-28');

    fireEvent.change(screen.getByTestId('agent-timetable-course-0'), { target: { value: 'Calculus II' } });
    fireEvent.change(screen.getByTestId('agent-timetable-weeks-0'), { target: { value: '1-4,6-8' } });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(client.getRules()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('agent-timetable-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const confirmed = onConfirm.mock.calls[0][0];
    expect(confirmed[0].course).toBe('Calculus II');
    expect(confirmed[0].weeks).toBe('1-4,6-8');
  });

  it('adds and removes rows', () => {
    render(
      withI18n(
        <TimetableCard
          artifact={artifact()}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          client={makeClient('test.cards.rows')}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId('agent-timetable-add-row'));
    expect(screen.getAllByTestId('agent-timetable-row')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('agent-timetable-remove-1'));
    expect(screen.getAllByTestId('agent-timetable-row')).toHaveLength(1);
  });

  it('cancels without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      withI18n(
        <TimetableCard
          artifact={artifact()}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={onConfirm}
          onCancel={onCancel}
          client={makeClient('test.cards.cancel')}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId('agent-timetable-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('gates confirm behind the semester fields', () => {
    const onSemesterChange = vi.fn();
    render(
      withI18n(
        <TimetableCard
          artifact={artifact()}
          semester={null}
          onSemesterChange={onSemesterChange}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          client={makeClient('test.cards.semester')}
        />,
      ),
    );

    expect(screen.getByTestId('agent-timetable-confirm')).toBeDisabled();
    const dateInput = screen.getByTestId('agent-timetable-semester-first-monday');
    expect(dateInput).toHaveValue('');

    fireEvent.change(dateInput, { target: { value: '2026-09-08' } });
    fireEvent.click(screen.getByTestId('agent-timetable-semester-save'));
    expect(onSemesterChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-timetable-semester-error').textContent).toContain('Monday');

    fireEvent.change(dateInput, { target: { value: '2026-09-07' } });
    fireEvent.click(screen.getByTestId('agent-timetable-semester-save'));
    expect(onSemesterChange).toHaveBeenCalledWith(SEMESTER);
  });

  it('reports a rejected confirm inline and stays editable', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('week 20 is outside the semester'));
    render(
      withI18n(
        <TimetableCard
          artifact={artifact()}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
          client={makeClient('test.cards.error')}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId('agent-timetable-confirm'));
    const error = await screen.findByTestId('agent-timetable-error');
    expect(error.textContent).toContain('week 20 is outside the semester');
    expect(screen.getByTestId('agent-timetable-course-0')).toBeDefined();
  });

  it('renders the applied state without inputs', () => {
    render(
      withI18n(
        <TimetableCard
          artifact={artifact({ state: 'applied', ruleIds: ['rule-1', 'rule-2'] })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          client={makeClient('test.cards.applied')}
        />,
      ),
    );

    expect(screen.getByTestId('agent-timetable-result').textContent).toContain('2');
    expect(screen.queryByTestId('agent-timetable-course-0')).toBeNull();
    expect(screen.queryByTestId('agent-timetable-confirm')).toBeNull();
  });

  it('renders the cancelled state', () => {
    render(
      withI18n(
        <TimetableCard
          artifact={artifact({ state: 'cancelled' })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          client={makeClient('test.cards.cancelled')}
        />,
      ),
    );

    expect(screen.getByTestId('agent-timetable-result')).toBeDefined();
    expect(screen.queryByTestId('agent-timetable-course-0')).toBeNull();
  });
});

describe('MessageBubble', () => {
  it('renders user and assistant layouts and the live text marker', () => {
    const client = makeClient('test.cards.bubble');
    const { rerender } = render(
      withI18n(
        <MessageBubble
          message={message({ role: 'user', text: 'Hello' })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          client={client}
        />,
      ),
    );
    const userBubble = screen.getByTestId('agent-message-user');
    expect(userBubble.querySelector('.agent-bubble__avatar')).toBeNull();

    rerender(
      withI18n(
        <MessageBubble
          message={message({ text: 'Streaming' })}
          live
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          client={client}
        />,
      ),
    );
    const assistantBubble = screen.getByTestId('agent-message-assistant');
    expect(assistantBubble.querySelector('.agent-bubble__avatar')).not.toBeNull();
    expect(screen.getByTestId('agent-live-text').textContent).toContain('Streaming');
  });

  it('renders answered asks and image thumbnails', () => {
    render(
      withI18n(
        <MessageBubble
          message={message({
            asks: [{ question: 'How long?', options: ['30 min'], answer: '30 min' }],
            images: [
              {
                id: 'img-1',
                name: 'notice.png',
                dataUrl: 'data:image/png;base64,AAAA',
                width: 10,
                height: 10,
              },
            ],
          })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          client={makeClient('test.cards.bubble-media')}
        />,
      ),
    );

    expect(screen.getByText('How long?')).toBeDefined();
    expect(screen.getByText('30 min')).toBeDefined();
    expect(screen.getByTestId('agent-message-image').getAttribute('alt')).toBe('notice.png');
  });

  it('wires the timetable card callbacks to the message id', async () => {
    const client = makeClient('test.cards.bubble-artifact');
    const onConfirmTimetable = vi.fn();
    const onCancelTimetable = vi.fn();
    render(
      withI18n(
        <MessageBubble
          message={message({ id: 'artifact-msg', text: '', artifact: artifact() })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          onConfirmTimetable={onConfirmTimetable}
          onCancelTimetable={onCancelTimetable}
          client={client}
        />,
      ),
    );

    expect(screen.getByTestId('agent-timetable-card')).toBeDefined();
    fireEvent.click(screen.getByTestId('agent-timetable-confirm'));
    await waitFor(() => expect(onConfirmTimetable).toHaveBeenCalledTimes(1));
    expect(onConfirmTimetable.mock.calls[0][0]).toBe('artifact-msg');
    expect(onConfirmTimetable.mock.calls[0][1][0].course).toBe('Calculus');

    fireEvent.click(screen.getByTestId('agent-timetable-cancel'));
    expect(onCancelTimetable).toHaveBeenCalledWith('artifact-msg');
  });

  it('renders note messages as a status line', () => {
    render(
      withI18n(
        <MessageBubble
          message={message({ role: 'note', text: 'Added 3 recurring rules.' })}
          semester={SEMESTER}
          onSemesterChange={vi.fn()}
          client={makeClient('test.cards.note')}
        />,
      ),
    );

    expect(screen.getByTestId('agent-message-note').textContent).toBe('Added 3 recurring rules.');
    expect(screen.queryByTestId('agent-message-assistant')).toBeNull();
  });
});

describe('icons', () => {
  const icons = [
    Sparkles,
    Plus,
    Send,
    Stop,
    ImagePlus,
    Trash,
    Pencil,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Menu,
    Calendar,
    ListTodo,
    Clock,
    Alert,
    Loader,
    Copy,
    X,
    ArrowUp,
    ArrowDown,
    Sidebar,
    Grid,
    Sliders,
  ];

  it('render as decorative currentColor SVGs', () => {
    for (const Icon of icons) {
      const { container, unmount } = render(<Icon size={20} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(svg?.getAttribute('width')).toBe('20');
      unmount();
    }
  });

  it('map tool names to the right icon', () => {
    expect(toolIcon('create_event')).toBe(Calendar);
    expect(toolIcon('cancel_recurring')).toBe(Calendar);
    expect(toolIcon('create_task')).toBe(ListTodo);
    expect(toolIcon('delete_node')).toBe(ListTodo);
    expect(toolIcon('ask_user')).toBe(Sparkles);
    expect(toolIcon('import_timetable')).toBe(Sparkles);
    expect(toolIcon('list_rules')).toBe(Sliders);
    expect(toolIcon('a_tool_without_an_icon')).toBe(Grid);
  });
});

/** A minimal catalogue lookup, so the conflict formatter can be tested per language. */
function translateFor(lang: string): Translate {
  return (key, params) => {
    const parts = key.split('.');
    let node: string | StringMap | undefined = messages[lang];
    for (const part of parts) {
      if (typeof node !== 'object' || node === undefined) return key;
      node = node[part];
    }
    if (typeof node !== 'string') return key;
    let text = node;
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}

describe('timetable conflict localization', () => {
  it('translates every conflict shape the analyser emits', () => {
    const en = translateFor('en');
    const zh = translateFor('zh');

    expect(
      localizeConflict('overlaps existing block "Standup" on 2026-10-23 10:00-11:00', en),
    ).toBe('Overlaps "Standup" on 2026-10-23 10:00-11:00');
    expect(
      localizeConflict('overlaps existing rule "Math" on 2026-09-11 10:00-11:50', zh),
    ).toBe('与重复日程「Math」（2026-09-11 10:00-11:50）冲突');
    expect(localizeConflict('overlaps "Physics" 13:00-14:50 (weeks 1-8,10-16)', zh)).toBe(
      '与「Physics」13:00-14:50（1-8,10-16 周）冲突',
    );
    expect(localizeConflict('week 17 is outside the semester (1..16)', en)).toBe(
      'Week 17 is outside the semester (1–16)',
    );
    expect(localizeConflict('weeks 17-18 are outside the semester (1..16)', zh)).toBe(
      '第 17-18 周超出校历范围（1–16）',
    );
    expect(localizeConflict('invalid weeks "x-y": bad range', en)).toBe('Cannot read the weeks "x-y"');
    expect(localizeConflict('invalid start time "25:00" (expected HH:mm)', zh)).toBe(
      '开始时间「25:00」格式不正确',
    );
    expect(localizeConflict('invalid semester: not a Monday', en)).toBe('The semester setting is invalid');
  });

  it('keeps an unknown sentence instead of hiding it', () => {
    const en = translateFor('en');
    expect(localizeConflict('something new happened', en)).toBe('something new happened');
  });
});
