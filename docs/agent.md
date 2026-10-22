# Scheduling agent

The agent is a frontend feature: the user configures an OpenAI-compatible
chat endpoint (base URL, model, API key) in Settings, and the app talks to
that endpoint directly from the browser. No API key ever reaches the server.
The agent reads and writes worktree data through ordinary core operations, so
the history, replay, conflict resolution and undo machinery are unchanged.

```
user text ──► agent loop ──► tool calls ──► planners (pure, core) ──► ops
                  │                                                │
                  └── context snapshot (read-only, deterministic)  ├── dry-run on a clone
                                                                   └── applied by WorktreeClient
```

## Non-negotiables

1. **The model never writes an operation directly.** It selects a tool and
   fills parameters. Tools validate through core (`WorktreeState.apply` on a
   clone) and emit ordinary ops. A model output that does not validate is an
   error returned to the model, never a partially applied edit.
2. **No `Date.now()` inside pure planners.** `now`, `tzOffset` and id factories
   are injected. Replay determinism is a property of core, not of the agent.
3. **No epoch milliseconds from the model.** Tools take `YYYY-MM-DD` and
   `HH:mm`; integer timestamps are computed by the planners with core's civil
   arithmetic.
4. **Bulk imports are previewed and confirmed by the user.** A timetable image
   is parsed into editable rows; nothing is written until the user presses
   confirm. Single conversational edits apply immediately and stay undoable.
5. **All the model sees is a snapshot plus tool results.** Never send the raw
   history or the full tree when a compact snapshot is enough.

## Workspace

New npm workspace `agent` (`@worktree/agent`), depending on `@worktree/core`
and `zod`. It contains no React and no DOM access; the only I/O lives in
`provider.ts` (a `fetch` injected by the caller). Dependency direction:
`core ← agent ← web`.

| File | Responsibility |
| --- | --- |
| `src/types.ts` | shared types, tool contracts |
| `src/weeks.ts` | teaching-week specs: parse/format/group |
| `src/semester.ts` | 校历 week ↔ civil date arithmetic |
| `src/planners.ts` | event/task/recurring/complete/cancel planners (pure ops) |
| `src/read.ts` | tree/calendar queries used by tools and snapshot |
| `src/context.ts` | compact context snapshot for the system prompt |
| `src/recommend.ts` | deterministic "what should I do now" ranking |
| `src/tools.ts` | tool definitions + executors binding planners/queries |
| `src/timetable.ts` | vision extraction schema, rows, conflict analysis, rules |
| `src/prompt.ts` | system prompt + wire message building |
| `src/provider.ts` | OpenAI-compatible transport, endpoint normalisation, errors |
| `src/vision.ts` | timetable image → validated `TimetableDraft` |
| `src/agent.ts` | the tool-calling loop |
| `src/index.ts` | public exports |

## Types (frozen contract)

```ts
export type DateString = string;  // 'YYYY-MM-DD'
export type TimeString = string;  // 'HH:mm'
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;  // ISO, Monday = 1

export interface Semester {
  /** The Monday starting teaching week 1. */
  firstMonday: CivilDate;
  /** 1..60. */
  totalWeeks: number;
}

export interface TimetableSession {
  weekday: Weekday;
  start: TimeString;
  end: TimeString;
  /** Teaching-week spec, e.g. '1-16', '1-16单', '2-16双', '1-8,10-16'. */
  weeks: string;
}

export interface TimetableCourse {
  name: string;
  teacher?: string;
  location?: string;
  sessions: TimetableSession[];
}

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
  weeksList: number[];
  firstDate: DateString;
  lastDate: DateString;
  /** Human-readable problems (overlaps, out-of-range weeks); empty = fine. */
  conflicts: string[];
}

export interface TimetablePlan {
  ops: Operation[];
  /** Rows skipped because an identical rule already exists. */
  duplicates: TimetableRowView[];
  warnings: string[];
}
```

## Tools

A tool is a name, a JSON-schema parameter description for the model, and an
executor. Executors are synchronous; they mutate the dry-run state so a later
tool call in the same turn can see earlier writes.

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON schema, type: 'object'
}

export interface ToolContext {
  state: WorktreeState;
  now: Timestamp;
  tzOffset: number;
  semester: Semester | null;
  newId: () => string;
}

export interface ToolRunResult {
  /** Compact result for the model (one line per item). */
  summary: string;
  /** Ops the tool planned; the caller applies them to `state` after a dry run. */
  ops?: Operation[];
}

export interface Tool {
  definition: ToolDefinition;
  run(args: unknown, ctx: ToolContext): ToolRunResult;
}

export function createTools(): Tool[];
```

Tool result content sent back to the model is JSON:
`{"ok":true,"summary":"..."}` or `{"ok":false,"error":"..."}`.

Tool set (name → purpose):

- `get_agenda` `{from?: DateString, to?: DateString}` — blocks and rule
  occurrences overlapping the window; default today..today+7.
- `search_tasks` `{keyword?, include_completed?, overdue_only?,
  due_within_days?, path?, limit?}` — matching nodes with path, deadline,
  status and id.
- `get_task` `{task_id}` — a node with ancestors, children, reminders and its
  linked block.
- `find_free_slots` `{date, min_minutes?}` — free intervals inside 08:00–23:00.
- `suggest_tasks` `{date?, available_minutes?, limit?}` — ranked actionable
  leaves with reasons. There is no duration model, so `available_minutes` does
  not filter or re-score; it is accepted for forward compatibility.
- `create_event` `{title, date, start_time, end_time, note?, location?,
  remind_minutes_before?}` — node under `/events` + linked block + explicit
  reminder (default 15 minutes before). A start time without a duration means
  one hour: the assistant creates it and says so in the reply.
- `create_task` `{title, parent_path?, note?, due_date?, due_time?,
  remind_minutes_before?}` — node (default `/tmp`), optional deadline and
  reminder.
- `create_recurring` `{title, weekdays, start_time, end_time, start_date,
  until_date?, note?}` — one weekly block rule.
- `update_event` `{event_id, title?, date?, start_time?, end_time?,
  remind_minutes_before?}` — patch a block (and its node name/reminder).
- `complete_task` `{task_id, completed?}` — complete/uncomplete a node.
- `cancel_event` `{event_id}` — remove a block and its empty helper node.

Planner rules:

- `create_event` / `create_task` create their nodes through core's
  `planCapture` (path segments auto-created, sibling-name suffixes, node on
  top) — the same semantics as quick capture, so the server sees ordinary
  `add`/`add_reminder`/`add_block` ops.
- Event nodes carry no deadline; the block is the time. A reminder at
  `start - remindMinutes` is an explicit `add_reminder` (never the percentage
  auto-reminder).
- A task with a deadline gets `edit_node {deadline}` (not an `add` field,
  because nodes are planned by `planCapture`) plus an optional explicit
  reminder.
- Recurring rules use `freq: 'weekly'`, `interval: 1`, `byDay` (ISO weekday
  converted to core's 0=Sunday), `timeOfDay`, `duration`, and `until` =
  end of `until_date` when given.
- `cancel_event` refuses (throws) when the linked node has children; it must
  not silently delete user data.

## Week and semester arithmetic

- `parseWeeksSpec('1-16单')` → `[1,3,5,7,9,11,13,15]`; full-width digits and
  `周`/`週` suffixes are accepted; an empty or malformed spec throws.
- `groupWeekRuns(weeks)` → maximal runs with a constant step 1 or 2:
  `[1,3,5,6,7]` → `[{start:1,end:5,step:2},{start:6,end:7,step:1}]`.
- `validateSemester` requires `firstMonday` to be a Monday, `totalWeeks`
  1..60 and a real civil date; it throws otherwise.
- Week `n` weekday `w` → civil date `firstMonday + (n-1)*7 + (w-1)` days.
- A timetable row becomes one weekly rule per week run: anchor
  `startDate = dateOfWeek(run.start, weekday)`, `interval = run.step`,
  `until = start timestamp of the last run week` (the `until` field bounds the
  occurrence start inclusively).

## Provider

`createChatTransport(config, fetchImpl?)` returns an `LlmTransport` that POSTs
an OpenAI-compatible chat completion. `config.baseUrl` may be
`https://api.deepseek.com`, `https://api.deepseek.com/v1` or a full
`.../chat/completions` URL; the endpoint is normalised, never guessed twice.
HTTP failures throw `ProviderError` with `status` and the API's message so the
UI can explain 401/402/429 and unsupported input modalities.

The endpoint must support browser CORS (DeepSeek does). The transport uses the
browser's `fetch` directly; there is no server proxy, so the key travels only
to the configured origin. `verifyProvider` (Settings → "test connection")
succeeds on any valid completion response — reasoning models may spend the
whole small token budget on `reasoning_content` and return empty `content`.

Vision extraction sends the image as `image_url` content parts and asks for a
strict JSON object; the reply is validated with Zod and retried once with the
validation error when the model returns malformed JSON.

## WorktreeClient additions

Two methods are added to the kernel for the agent (both general-purpose):

- `planningState(): WorktreeState` — a clone of the rendered state, so
  planners can dry-run ops without touching live state (mirrors
  `ClientStore.planningState`).
- `applyMany(ops: Operation[]): void` — validate the whole batch on a clone
  first, then apply it with one rebuild/resync; used by timetable import and by
  `runAgentTurn` results. Each op still becomes its own pending history entry,
  so undo semantics per op are unchanged.

## Web UI

- `AppConfig.ai = { baseUrl, model, apiKey, semester: Semester | null }`,
  persisted in localStorage with the rest of the device config. Defaults:
  `https://api.deepseek.com`, `deepseek-flash`, empty key, no semester.
- Settings gets an "AI assistant" card (base URL, model, key, test connection)
  and a "Semester" card (first Monday, total weeks).
- A new tab `agent` (5 segments) renders the chat page. Without an API key the
  page explains how to configure it; with one, messages, quick prompts,
  tool-step summaries, stop and clear.
- The chat is persisted per (server, user) in localStorage, capped at 60
  messages; only the last 20 messages and the snapshot are sent to the model.
- Timetable import is a dedicated panel: semester setup → image upload →
  parse → editable preview table (course/weekday/time/weeks, with first/last
  date and conflicts) → confirm. Duplicate identical rules are reported and
  skipped, never silently duplicated.
- All new UI strings exist in both catalogues (`en`, `zh`), the page uses the
  semantic classes from `docs/ui.md` and does not restyle from scratch.

## Testing

- `agent/tests/` covers week/semester arithmetic, every planner, read queries,
  recommendation ranking, tool argument validation, prompt/snapshot stability,
  provider request/response/error mapping, the loop with fake transports
  (multi-step tool calls, malformed arguments, step limit, abort), and
  timetable rows → rules → duplicate detection.
- A live test is skipped unless `DEEPSEEK_API_KEY` is set; it exercises tool
  calling against the real endpoint and, when `DEEPSEEK_TIMETABLE_IMAGE` points
  at an image, vision extraction. It is never part of the default `npm test`.
  `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` override the defaults. Verified with
  `deepseek-flash` (text + image, function calling): one Chinese meeting
  request produced a linked block and a 15-minute reminder; the timetable
  fixture yielded 10 courses.
- `frontend/web/tests/` covers the API-key gate, a chat turn with an injected
  transport (tool ops reach the client), and timetable preview editing.
