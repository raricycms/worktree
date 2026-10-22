import type { CivilDate, Operation, Timestamp, WorktreeState } from '@worktree/core';

/** `YYYY-MM-DD`, the date format the model and the tools exchange. */
export type DateString = string;

/** `HH:mm`, 24-hour; the time format the model and the tools exchange. */
export type TimeString = string;

/** ISO weekday: Monday = 1 .. Sunday = 7 (core's byDay is 0 = Sunday). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/** A teaching calendar: week 1 starts on `firstMonday`. */
export interface Semester {
  firstMonday: CivilDate;
  /** Number of teaching weeks, 1..60. */
  totalWeeks: number;
}

export interface TimetableSession {
  weekday: Weekday;
  start: TimeString;
  end: TimeString;
  /** Teaching-week spec, e.g. `1-16`, `1-16单`, `2-16双`, `1-8,10-16`. */
  weeks: string;
}

export interface TimetableCourse {
  name: string;
  teacher?: string;
  location?: string;
  sessions: TimetableSession[];
}

/** A vision extraction result, before the user edits it. */
export interface TimetableDraft {
  courses: TimetableCourse[];
  warnings: string[];
}

/** One editable row of the import preview. `id` is a UI key, never persisted. */
export interface TimetableRow {
  id: string;
  course: string;
  weekday: Weekday;
  start: TimeString;
  end: TimeString;
  weeks: string;
  teacher?: string;
  location?: string;
}

export interface TimetableRowView {
  row: TimetableRow;
  /** Resolved teaching weeks, ascending. */
  weeksList: number[];
  /** `YYYY-MM-DD` of the first and last occurrence. */
  firstDate: DateString;
  lastDate: DateString;
  /** Human-readable problems (overlaps, weeks out of range); empty = fine. */
  conflicts: string[];
}

export interface TimetablePlan {
  ops: Operation[];
  /** Rows skipped because an identical rule already exists. */
  duplicates: TimetableRowView[];
  warnings: string[];
}

/** A tool's JSON-schema parameter description, shown to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The state a tool runs against. `state` is a dry-run clone: write tools apply
 * their ops to it so later tool calls in the same turn observe earlier writes.
 * The caller applies the returned ops to the real client afterwards.
 */
export interface ToolContext {
  state: WorktreeState;
  now: Timestamp;
  tzOffset: number;
  semester: Semester | null;
  newId: () => string;
}

export interface ToolRunResult {
  /** Compact, one-line-per-item result for the model. */
  summary: string;
  /** Ops the tool planned; the caller applies them after validation. */
  ops?: Operation[];
}

export interface Tool {
  definition: ToolDefinition;
  run(args: unknown, ctx: ToolContext): ToolRunResult;
}

/** Injected clock/offset/id factory for the planners (no ambient time). */
export interface PlanContext {
  now: Timestamp;
  tzOffset: number;
  newId: () => string;
}

export interface PlannedEvent {
  ops: Operation[];
  nodeId: string;
  blockId: string;
  reminderId?: string;
  start: Timestamp;
  end: Timestamp;
  displayPath: string;
}

export interface PlannedTask {
  ops: Operation[];
  nodeId: string;
  reminderId?: string;
  deadline?: Timestamp;
  displayPath: string;
}

export interface PlannedRecurring {
  ops: Operation[];
  ruleIds: string[];
}

export interface PlannedUpdate {
  ops: Operation[];
  blockId: string;
  start: Timestamp;
  end: Timestamp;
}

export interface PlannedComplete {
  ops: Operation[];
  nodeId: string;
  completed: boolean;
}

export interface PlannedCancel {
  ops: Operation[];
  blockId: string;
  nodeId?: string;
}

export interface CreateEventInput {
  title: string;
  date: DateString;
  start: TimeString;
  end: TimeString;
  note?: string;
  location?: string;
  /** Default 15; 0 disables the reminder. */
  remindMinutesBefore?: number;
}

export interface CreateTaskInput {
  title: string;
  /** Capture path of the new node; default `/tmp`. */
  parentPath?: string;
  note?: string;
  dueDate?: DateString;
  dueTime?: TimeString;
  /** Reminder this many minutes before the deadline; 0 disables it. */
  remindMinutesBefore?: number;
}

export interface CreateRecurringInput {
  title: string;
  weekdays: Weekday[];
  startTime: TimeString;
  endTime: TimeString;
  startDate: DateString;
  /** Inclusive last date; absent = open-ended. */
  untilDate?: DateString;
  note?: string;
}

export interface UpdateEventInput {
  eventId: string;
  title?: string;
  date?: DateString;
  startTime?: TimeString;
  endTime?: TimeString;
  remindMinutesBefore?: number;
}

export interface CompleteTaskInput {
  taskId: string;
  completed?: boolean;
}

export interface CancelEventInput {
  eventId: string;
}

/** One agenda entry: a standalone block or a recurring rule's occurrence. */
export interface AgendaItem {
  kind: 'block' | 'occurrence';
  id: string;
  name: string;
  start: Timestamp;
  end: Timestamp;
  status: boolean;
  note: string;
  nodeId?: string;
  ruleId?: string;
}

export interface TaskSummary {
  id: string;
  name: string;
  path: string;
  status: boolean;
  note: string;
  deadline?: Timestamp;
  reminders: number;
  /** Direct children that are still open. */
  openChildren: number;
}

export interface TaskDetail {
  task: TaskSummary;
  ancestors: { id: string; name: string }[];
  children: TaskSummary[];
  reminders: { id: string; deadline: Timestamp; active: boolean; auto: boolean }[];
  block?: { id: string; name: string; start: Timestamp; end: Timestamp };
}

export interface FreeSlot {
  start: Timestamp;
  end: Timestamp;
  minutes: number;
}

export interface Suggestion {
  taskId: string;
  name: string;
  path: string;
  deadline?: Timestamp;
  score: number;
  reason: string;
}

/** A model message as the app stores it (text only; tools are not history). */
export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  ok: boolean;
}

export interface AgentTurnResult {
  /** The assistant's final text; empty when the loop produced none. */
  text: string;
  /** Planned ops in tool execution order; the caller applies them. */
  ops: Operation[];
  steps: AgentStep[];
  /** True when the step budget ran out before the model stopped calling tools. */
  stoppedByLimit: boolean;
}

export interface AgentTurnOptions {
  transport: LlmTransport;
  systemPrompt: string;
  history: AgentHistoryMessage[];
  userText: string;
  context: ToolContext;
  tools?: Tool[];
  /** Default 6. */
  maxSteps?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderConfig {
  /** Base URL or a full `/chat/completions` endpoint. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The subset of `fetch` the transport needs (works with browser and Node fetch). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmWireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentPart[] | null;
  tool_calls?: LlmWireToolCall[];
  tool_call_id?: string;
  /** DeepSeek-style reasoning trace; echoed back unchanged with tool calls. */
  reasoning_content?: string;
}

export interface LlmRequest {
  messages: LlmWireMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  arguments: string;
}

export interface LlmResponse {
  content: string;
  reasoning: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmTransport {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
