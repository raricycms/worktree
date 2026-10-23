# Scheduling agent

The assistant is a chat surface for the whole app: one conversation can create
events and tasks, import a class timetable from a photo, turn a chat screenshot
into todos, answer schedule questions, plan a day, move or cancel things, and
edit the tree. The model never writes an operation itself — it calls tools,
tools validate on a clone and emit ordinary core ops, and the client applies
them through the normal history/undo path.

```
user turn (text + images)
    │
    ▼
system prompt ──► agent loop ──► tool calls ──► planners (pure, core) ──► ops
    ▲                │  ▲                                            │
    │                │  └─ ask_user (suspends for the human)         ├─ dry-run on a clone
    │                │                                              └─ applied once by WorktreeClient
    └─ snapshot ─────┘
```

## Non-negotiables

1. **The model never writes an operation directly.** It selects a tool and
   fills parameters. Tools parse with Zod, validate through core
   (`WorktreeState.apply` on a clone) and return ops; a model output that does
   not validate becomes a tool error the model can correct, never a partial
   write.
2. **No ambient time in pure code.** `now`, `tzOffset` and id factories are
   injected into the loop and the planners, so replay stays deterministic.
3. **No epoch milliseconds from the model.** Tools take `YYYY-MM-DD` and
   `HH:mm`; timestamps come from core's civil arithmetic.
4. **Bulk imports are previewed and confirmed.** A timetable image becomes an
   artifact card with editable rows; nothing is written until the user presses
   confirm. Single conversational edits apply immediately and stay undoable.
5. **The model sees a snapshot plus tool results**, never the raw tree.
6. **Streaming is presentation only.** Deltas update the live bubble; the
   committed transcript and the ops are built exactly as in the non-streaming
   path.

## Workspace

New npm workspace `agent` (`@worktree/agent`), depending on `@worktree/core`
and `zod`. No React, no DOM; the only I/O is an injected `fetch`.
Dependency direction: `core ← agent ← web`.

| File | Responsibility |
| --- | --- |
| `src/types.ts` | shared types: turns, events, artifacts, tools, provider wire |
| `src/weeks.ts` | teaching-week specs: parse/format/group |
| `src/semester.ts` | 校历 week ↔ civil date arithmetic |
| `src/planners.ts` | event/task/recurring/update/complete/cancel planners |
| `src/read.ts` | tree/calendar queries used by tools and snapshot |
| `src/context.ts` | compact context snapshot for the system prompt |
| `src/recommend.ts` | deterministic "what should I do now" ranking |
| `src/tools.ts` | 20 tool definitions + executors |
| `src/timetable.ts` | rows ↔ draft, conflict analysis, rows → weekly rules |
| `src/prompt.ts` | system prompt, history and user wire messages |
| `src/provider.ts` | OpenAI-compatible transport: `complete` + `stream` (SSE) |
| `src/vision.ts` | strict timetable-image extraction (library API) |
| `src/agent.ts` | the streaming tool-calling loop |
| `src/index.ts` | public exports |

Web side:

| Path | Responsibility |
| --- | --- |
| `frontend/web/src/agent/conversations.ts` | local conversation store (v2, caps, migration, quota) |
| `frontend/web/src/agent/attachments.ts` | image validation + downscale (`prepareAttachment`) |
| `frontend/web/src/agent/runtime.ts` | abort detection, tz offset, provider error → i18n text |
| `frontend/web/src/pages/AgentPage.tsx` | shell, turn orchestration, live streaming, artifact confirm |
| `frontend/web/src/components/agent/` | sidebar, composer, empty state, bubbles, markdown, tool steps, ask card, timetable card, icons |
| `frontend/web/src/styles/views-agent.css` | page shell and motion |
| `frontend/web/src/styles/agent-cards.css` | card styles and keyframes |

## Turn lifecycle

1. `AgentPage` appends the user message (text + up to 3 attachments) and
   persists it locally.
2. It builds the context: `client.planningState()`, `buildContextSnapshot`,
   `buildSystemPrompt`, `modelHistory` of the conversation and the
   `askUser` callback.
3. `runAgentTurn` sends system + history + user turn (text and `image_url`
   parts) to the transport and consumes the stream.
4. Tool calls are executed sequentially, awaiting each one. Write tools plan on
   a clone, apply to the dry-run state so later calls see earlier writes, and
   return `{summary, ops, artifacts}`. A failing tool returns
   `{ok:false,error}` to the model instead of breaking the turn.
5. `ask_user` suspends the turn through `ToolContext.askUser`: the UI renders an
   `AskCard` with option buttons and a free-text field, and the answer becomes
   the tool result. Stopping the turn rejects with an `AbortError`.
6. At the end the loop returns `{text, ops, steps, artifacts, asks,
   stoppedByLimit}`. The page applies `ops` once with `client.applyMany`, stores
   one assistant message (text, steps, answered asks) and one message per
   artifact, and the card stays pending until the user confirms.
7. Streaming progress goes through `onEvent` (`reasoning`/`text` deltas,
   `tool_start`/`tool_end`). The page batches those into one React update per
   animation frame and shows the thinking dots until the first token.

`maxSteps` defaults to 8; when the budget runs out the loop makes one final
tool-free request so the user still gets a text answer (`stoppedByLimit`).

## Public API (summary)

```ts
export interface AgentImage { id: string; dataUrl: string; name?: string }
export interface AskUserRequest { question: string; options: string[] }
export interface AgentAsk extends AskUserRequest { answer: string }
export type AgentArtifact = { kind: 'timetable'; rows: TimetableRow[]; warnings: string[] };

export type AgentEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string };

export interface AgentTurnOptions {
  transport: LlmTransport;
  systemPrompt: string;
  history: AgentHistoryMessage[];
  userText: string;
  images?: AgentImage[];
  context: ToolContext;
  tools?: Tool[];
  maxSteps?: number;
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onAskUser?: (request: AskUserRequest) => Promise<string>;
}

export interface AgentTurnResult {
  text: string;
  ops: Operation[];
  steps: AgentStep[];
  artifacts: AgentArtifact[];
  asks: AgentAsk[];
  stoppedByLimit: boolean;
}

export interface ToolContext {
  state: WorktreeState;
  now: Timestamp;
  tzOffset: number;
  semester: Semester | null;
  newId: () => string;
  askUser?: (request: AskUserRequest) => Promise<string>;
}

export interface Tool {
  definition: ToolDefinition;
  run(args: unknown, ctx: ToolContext): ToolRunResult | Promise<ToolRunResult>;
}

export interface LlmTransport {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream?(request: LlmRequest, handlers: LlmStreamHandlers): Promise<LlmResponse>;
}
```

Tool results sent back to the model are JSON: `{"ok":true,"summary":"..."}` or
`{"ok":false,"error":"..."}`.

## Tools

Read: `get_agenda`, `search_tasks`, `get_task`, `get_tree`, `list_rules`,
`find_free_slots`, `suggest_tasks`.
Write: `create_event`, `create_task`, `create_tasks`, `create_recurring`,
`update_event`, `update_task`, `complete_task`, `cancel_event`,
`cancel_recurring`, `move_node`, `delete_node`.
Workflow: `import_timetable` (preview artifact, writes nothing), `ask_user`.

Notable contracts:

- `create_event` makes a node under `/events`, a linked block and an explicit
  reminder (default 15 minutes before; `0` disables). A start time without a
  duration is one hour and the reply says so.
- `create_task`/`create_tasks` create nodes under `/tmp` by default, optionally
  with a deadline and reminder. The batch variant validates every item on one
  clone, so one bad item rejects the whole batch (atomic), capped at 30.
- `update_task` patches name/note/deadline/reminder; it shifts or removes the
  reminders the planner owns, and refuses when the reminder set is ambiguous.
- `get_tree` returns an indented tree with ids (depth default 3, 300-node cap);
  `list_rules`/`cancel_recurring` cover weekly rules.
- `move_node` uses core's `move`; `delete_node` refuses a subtree unless
  `with_children` is true and refuses a node that still has a calendar block
  (the model must cancel the event first).
- `import_timetable` validates each row (course, ISO weekday, `HH:mm`,
  week spec) and fails with the 1-based row index and field so the model can
  retry. It returns an artifact and no ops; `weeks` defaults to the semester
  length only when a semester is configured.
- `ask_user` asks 2–5 short options (or none for free text). It is the only way
  the model may block on the human; asking in prose is against the prompt.

## System prompt and skills

`buildSystemPrompt` contains: hard rules, the current clock/weekday/UTC offset,
the semester line, the workspace snapshot, conversation rules (brief, concrete,
`**bold**`/`-` bullets only, no HTML/tables/headings, UI language), the
ask-don't-guess policy, seven named playbooks and image rules.

Playbooks (each lists the exact tool sequence):

| Skill | Trigger | Tools |
| --- | --- | --- |
| `capture_from_text` | event/task in plain language | `get_agenda` (conflict check) → `create_event`/`create_task`/`create_tasks` |
| `timetable_import` | photo of a weekly class grid | `import_timetable` → user confirms the card |
| `screenshot_to_todos` | chat/notice/email screenshot | `ask_user` if vague → `create_event` for timed appointments / `create_task(s)` for deadlines |
| `day_planning` | "plan my day", "what should I do" | `get_agenda` + `find_free_slots` + `suggest_tasks` → one recommendation |
| `reschedule` | move/shift existing items | `get_agenda`/`search_tasks` → `update_event`/`update_task` |
| `timetable_qa` | week/day questions | semester line + `get_agenda` (never week math from memory) |
| `cleanup` | complete/cancel/delete | `complete_task`/`cancel_event`/`cancel_recurring`/`delete_node` with explicit confirmation for destructive deletes |

Image handling is explicit: an attachment is classified first (class grid,
chat/notice screenshot, something else), unreadable or unclear input goes
through `ask_user`, and a request that mentions an image without one attached
asks the user to attach it.

## Timetable import

1. The image is sent to the multimodal model with the user turn; the model
   calls `import_timetable` with rows extracted from the image.
2. The tool validates and returns `{kind:'timetable', rows, warnings}`. Nothing
   is written.
3. The UI renders an editable card: course, weekday, start/end, week spec,
   teacher, location, resolved first/last dates, and conflicts against the
   preview and the existing calendar (`analyzeTimetableRows`). Conflicts are
   localized in the card.
4. On confirm the page runs `rowsToRules(rows, {semester, tzOffset, newId,
   existingRules})` and `client.applyMany(ops)`; duplicate identical rules are
   skipped and reported, invalid rows throw and keep the card editable.

Each row becomes one weekly rule per constant-step run of its week spec
(`interval` 1 or 2), anchored at the first week's date and bounded by the last
occurrence start. The card requires a semester (first Monday + total weeks)
and offers the semester fields inline when none is configured.

## Conversations (device-local)

`frontend/web/src/agent/conversations.ts` stores a versioned state
(`worktree.agent.v2.<scope>`) with up to 30 conversations and 200 messages
each, ordered by `updatedAt`, with a repaired `activeId`. The v1 single-chat key
is migrated into one conversation. Saves prune old conversations and, on a
quota error, first drop image data URLs from older messages and then drop the
oldest conversations; they never throw into the UI.

`modelHistory` sends the last 24 messages, skips `note` rows and empty texts,
and replaces older image attachments with a ` [image]` marker (the current
turn's images are sent separately as `AgentImage[]`). Attachments are
downscaled to a 1600 px long edge as JPEG before they are stored or sent.

## Provider

`createChatTransport(config, fetchImpl?)` returns `{complete, stream}` for an
OpenAI-compatible endpoint. `baseUrl` may be `https://api.deepseek.com`,
`.../v1` or a full `.../chat/completions` URL; it is normalised once.

`stream` sends `stream: true` and parses SSE: `delta.content`,
`delta.reasoning_content`, tool calls fragmented by index, `[DONE]`, comment
lines and chunk-boundary buffering. A non-SSE response falls back to the JSON
parser. HTTP failures throw `ProviderError` with the status and the API's
message, which the UI maps to 401/402/429/vision-unsupported wording. Reasoning
content is echoed back on assistant tool-call messages, as DeepSeek requires.

`verifyProvider` (Settings → test connection) accepts any valid completion — a
reasoning model may spend a small token budget on reasoning and return empty
text. Browser CORS is required (DeepSeek supports it); the key goes only to the
configured origin, never to the worktree server.

## Web UI

- Full-height shell under the topbar: a 272 px conversation rail (new chat,
  conversations grouped by day, inline rename, delete with confirmation, model
  and Settings footer) and a centered 780 px thread with a sticky composer.
  Below 900 px the rail becomes a drawer with a scrim and a header menu button.
- Composer: auto-growing textarea, Enter sends / Shift+Enter newline (IME-safe),
  attach button for up to three images with thumbnail chips, paste and
  drag-and-drop, one circular send/stop button, and a disclaimer line.
- Empty state: greeting by local time, four suggestion cards (agenda, timetable,
  screenshot todos, plan) that start a turn immediately.
- Live turn: reasoning and text stream into a caret-marked bubble, tool steps
  slide in with icons, and a thinking row with three pulsing dots shows while
  the model works. Answered `ask_user` questions render as Q/A rows above the
  reply. A timetable artifact renders as the editable card described above.
- Motion uses the existing duration/easing tokens (message entrance, thinking
  dots, spinner, caret, hover lifts) and is disabled under
  `prefers-reduced-motion`. All strings exist in `en` and `zh`; the page uses
  the shared tokens, not ad-hoc colors or radii.
- Stopping a turn keeps the partial reply as a message plus a `note` line; a
  provider error keeps the user message and shows an actionable notice.

## Semester arithmetic

- `parseWeeksSpec('1-16单')` → `[1,3,…,15]`; full-width digits and `周`/`週` are
  accepted, malformed specs throw.
- `groupWeekRuns` splits a week list into constant-step runs (`1,3,5,6,7` →
  step 2 then step 1), which is what makes 单/双周 import as `interval` 2.
- Week `n` weekday `w` → `firstMonday + (n-1)*7 + (w-1)` days.
- `validateSemester` requires a real Monday and 1..60 weeks.

## Testing

- `agent/`: 242 tests, plus 2 live tests skipped unless the environment opts in.
  Coverage: week/semester arithmetic, planners, read queries, ranking, snapshot,
  tool validation (including the batch atomicity and destructive safeguards),
  prompt contents, provider request/response/error mapping, SSE parsing
  (fragmented text, reasoning and tool calls, `[DONE]`, JSON fallback, in-stream
  errors, abort), the loop (tool order, ask_user pause/resume, artifacts, step
  limit, abort) and timetable rows → rules → occurrences.
- `frontend/web/`: conversation store (caps, migration, quota), attachments,
  markdown/tool steps/ask/timetable cards, the page (streaming and plain turns,
  conversation CRUD and reload, ask flow, timetable confirm/cancel, abort,
  provider error) and the settings/i18n catalogues.
- Live test: `DEEPSEEK_API_KEY=… npx vitest run tests/live.test.ts` in `agent/`;
  `DEEPSEEK_TIMETABLE_IMAGE` adds the vision case. `DEEPSEEK_BASE_URL` and
  `DEEPSEEK_MODEL` override the defaults.
- Manual browser check: a local build served with `vite preview` and driven
  through Chrome DevTools Protocol was used to verify the real endpoint: a
  Chinese meeting request created a 15:00–16:00 block with a 14:45 reminder,
  an incomplete request paused on the ask card and finished after two answers,
  a timetable photo produced a 10-row card with resolved dates and a conflict
  warning, confirming it wrote 10 weekly rules, a WeChat screenshot produced
  three dated todos after one clarification, and the conversation survived a
  reload.

## Limits

- There is no duration model: `suggest_tasks` ranks by deadline only, and
  `available_minutes` is accepted but unused.
- `import_timetable` caps at 200 rows and `get_tree` at 300 nodes; larger trees
  are summarized.
- The model still fills the structured tool arguments (rows, titles, times), so
  its extraction quality is the ceiling for image import; the preview is the
  safety net.
- `update_task` only moves/removes reminders it can attribute to the task's
  deadline; user-created reminders with unrelated names are left alone.
- Images in older history are replaced by a marker, so a follow-up turn about a
  very old image needs the image attached again.
