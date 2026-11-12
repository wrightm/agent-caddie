---
title: Harness lifecycles
status: living
last-verified: 2026-11-11
owner: maintainers
depends-on-adrs: [0002, 0017, 0019, 0025]
---

# Harness lifecycles

Caddie coaches across coding-agent harnesses that expose very different
hooks, logs and UI surfaces. This document defines the **canonical
lifecycle** every adapter maps to, explains what each event means and how it
connects to the next, records the **verified native mapping** for seven
harnesses, states the packaging standard each adapter follows, and walks two
deliberately different hypothetical adapters through the design to prove the
ports hold (the fitness exercise). Native names below were checked against
each harness's official documentation or source on 2026-11-11; sources are
listed per harness. `[ADR-0019, ADR-0025 proposed]`

## 1. The canonical lifecycle

### 1.1 State machine

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                         SESSION                          │
                 │                                                          │
 session.start ─▶│  idle ──prompt.submitted──▶ turn ──turn.end──▶ idle     │──session.end──▶ (final)
 session.resume ─▶│   ▲                                                      │
 session.clear ──▶│   │  (compaction and subagents happen inside a turn)      │        or no event:
                 │   │                                                      │        orphan catch-up
                 └───┼──────────────────────────────────────────────────────┘
                     │
   turn := prompt.submitted
           ─▶ model.request ─▶ ( tool.before ─▶ tool.after )* ─▶ model.response   ─┐ repeats while the
           ─▶ turn.end                                                             ◀┘ model keeps calling tools

   inside a turn, optionally:
     context.compact.before ─▶ context.compact.after        (harness summarises history)
     subagent.start ─▶ [ model.request … model.response ]* ─▶ subagent.stop   (nested; own usage)
   at any time:
     model.switch · notification · harness_event (anything else, kept raw)
```

A **session** is one context window's life: from a start event to an end
event. A **turn** is one human prompt and everything the harness does until
it hands control back. A turn contains one or more **requests** to a model;
each request is where tokens are spent and is the unit of cost. Tools run
between requests. Compaction rewrites the history inside the same session.
Subagents are nested sessions with their own requests, started by a tool
call and ended before the parent turn ends.

### 1.2 Event semantics

For each event: what it means, what triggers it, what precedes and follows
it, whether it is required, and what Caddie does when a harness never emits
it. "Required" means Caddie cannot produce a session report without it being
observed or derived.

| Event | Meaning | Triggered by | Precedes / follows | Required? | If never emitted |
|---|---|---|---|---|---|
| `session.start` | A new context window exists | harness start-up | first event of a session; followed by idle | yes (derived if needed) | derived from the first transcript entry or first hook of an unknown session id |
| `session.resume` | An earlier session's context is loaded into a new process | `--resume`, picker | behaves as `session.start` with `resumedFrom` | no | a resumed session looks like a new one; prefix cost may double-count, record flagged `resumeUnknown` |
| `session.clear` | The context was reset but the process continues | `/clear` | ends the previous segment, starts a new one with the same process id | no | segments after a clear are counted in one session; standing-prefix estimate marked `approximate` |
| `prompt.submitted` | The human asked for something | user input, scheduled task, cross-session message | follows idle; starts a turn; followed by `model.request` | yes (derived from user messages in the transcript if no hook) | prompt heuristics and `prompting.*` rules disabled; turns segmented by `turn.end` or by gaps |
| `model.request` | A request was sent to a model | the agent loop | follows `prompt.submitted` or `tool.after`; followed by `model.response` | yes (derived is normal) | **no cost at all**; Caddie reports cost unavailable and disables cost-based rules |
| `model.response` | The model answered; carries usage, model id, stop reason | the API | follows `model.request`; followed by `tool.before` or `turn.end` | yes (derived is normal) | as above |
| `tool.before` | The agent is about to run a tool | tool call | follows `model.response`; followed by `tool.after` | no | tool-based rules (`tools.output-bloat`, `mcp.unused-servers`) rely on `tool.after` only or are disabled |
| `tool.after` | A tool finished; carries result size and error | tool completion | followed by `model.request` or `turn.end` | no | as above |
| `turn.end` | The harness handed control back to the human | agent loop completion, API error | ends the turn; followed by idle | no | turns are derived from the next `prompt.submitted`; live stats refresh only at `session.end` |
| `context.compact.before` | History is about to be summarised | auto threshold, `/compact`, idle | inside a turn or idle; followed by `context.compact.after` | no | compaction derived from transcript markers if present; else `cache.cold-compaction` disabled |
| `context.compact.after` | History was replaced by a summary; the standing prefix is rebuilt | compaction completion | followed by the next `model.request` with a large cache write | no | derived from the first request after `compact.before` |
| `subagent.start` | A nested agent began with its own context | Agent/Task tool | inside a turn; followed by the subagent's requests | no | subagent requests are attributed to the parent if visible, else invisible; `subagents.*` rules disabled |
| `subagent.stop` | The nested agent finished; carries its transcript or usage | subagent completion | followed by `tool.after` of the spawning call | no | as above |
| `model.switch` | The model in use changed | `/model`, fallback | any time | no | derived from a change of model id between requests |
| `notification` | The harness told the human something (permission, idle) | harness UI | any time | no | ignored |
| `session.end` | The context window is gone | exit, `/clear`, logout, `-p` completion | last event; triggers finalize | no | **orphan catch-up**: the session is finalized when its observation source has been idle for `orphanAfterMinutes` |
| `harness_event` | Anything native Caddie does not model | any native event | any time | no | nothing; kept raw for adapter debugging and bundles |

### 1.3 Observed and derived

Every `CaddieEvent` carries `source: 'observed' | 'derived'`:

- **observed**: a native hook or event fired and the adapter mapped it.
- **derived**: the adapter reconstructed the event from an observation
  source (a transcript, a rollout log, a telemetry file) because the harness
  has no hook for it, or the hook fired without the data the event needs.

Rules never test `source`. The rule engine lowers `confidence` on a finding
whose evidence is derived (by a per-rule factor, default 0.85), and reports
say "reconstructed from the transcript" next to such findings. This keeps
the kernel honest without forking logic per harness.

### 1.4 Bleed: when harnesses collapse or split events

Harness events do not line up one-to-one with the canonical ones. Known
patterns and how adapters handle them:

| Pattern | Example | Adapter rule |
|---|---|---|
| One native event is two canonical events | Claude Code `SessionStart source: clear` after `SessionEnd reason: clear` | emit `session.clear` once, from the `SessionStart`; drop the paired `SessionEnd` |
| One native event covers several canonical ones | Cursor `stop` is `turn.end` and, when the process exits, also `session.end` | emit `turn.end`; let orphan catch-up produce `session.end` |
| A canonical event has no native event but the log shows it | Codex rollouts record every request | emit `model.request`/`model.response` as `derived` |
| A hook fires without the data the event needs | Claude Code `Stop` has no usage | emit `turn.end` observed, read usage from the transcript as derived requests |
| A native event fires more than once per logical event | Gemini `AfterModel` fires per streaming chunk; Claude Code writes one JSONL line per content block with the same `requestId` and usage | coalesce by request id (Claude Code `requestId`; Gemini by message record) |
| Nested lifecycle fires the parent's hooks | subagent frontmatter hooks turn `Stop` into `SubagentStop` in Claude Code | adapters carry `agentId`; the aggregator attributes by `agentId`, not by hook name |
| Hooks only fire for trusted or interactive sessions | Claude Code `-p` and untrusted folders | `hasSessionEnd` and `hasTurnBoundary` may be true in config but false at runtime; the adapter reports `capabilitiesObserved` from what actually fired, and the pipeline uses the observed set |

### 1.5 Ignoring, adding and deprecating mappings

- An adapter maps only what the canonical lifecycle needs. Every other native
  event is either not subscribed to or passed through as `harness_event`
  with the native name and a truncated payload. Caddie subscribes to the
  minimum hooks needed for the capabilities it declares, because every hook
  costs the user latency.
- Adding a canonical event requires: a row in §1.2, the capability flag it
  depends on in [capability-matrix.md](capability-matrix.md), the feature
  that needs it, and the fixture that proves at least one adapter emits it.
- When a harness renames or removes a native event, the adapter keeps the
  old mapping behind a version check for two harness minor versions,
  journals `adapter_mapping_deprecated` once per session, and the conformance
  fixture for the old shape stays until the mapping is removed.

## 2. Verified native mappings

Each harness section lists: the mapping table, the capabilities the adapter
declares, how it is packaged, where it observes, and documented gaps. Legend:
**O** observed from a native event, **D** derived from the observation
source, **—** not available.

### 2.1 Claude Code

Sources: code.claude.com/docs/en/hooks, hooks-guide, plugins,
plugins/manifest-reference, statusline, claude-directory,
plugins/mods/events (all fetched 2026-11-11); a local transcript inspected
the same day for the usage fields.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `SessionStart` (`source: startup`) | O | input carries `session_id`, `transcript_path`, `cwd`, `effort.level`; output `hookSpecificOutput.additionalContext` |
| session.resume | `SessionStart` (`source: resume|fork`) | O | input adds `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (v2.1.251+): a direct cold-cache signal |
| session.clear | `SessionStart` (`source: clear`), paired `SessionEnd` (`reason: clear`) | O | |
| prompt.submitted | `UserPromptSubmit` | O | `prompt` text available; Caddie keeps heuristics only; 30 s timeout |
| model.request | none as a settings hook | D | from transcript `assistant` entries; mods API `turn.step` exists but Caddie does not use mods in M1 |
| model.response | none as a settings hook | D | transcript `assistant` entry: `requestId`, `message.model`, `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`; plus `effort`, `perTurnEffort`, `isSidechain`, `agentId` on the entry; one line per content block (`apiBlockIndex`) with the usage repeated, so dedupe by `requestId` |
| tool.before | `PreToolUse` | O | not subscribed in M1 (cost without benefit); tool calls are derived from transcript `tool_use` blocks |
| tool.after | `PostToolUse` / `PostToolUseFailure` | O | not subscribed in M1; `tool_result` sizes derived from the transcript |
| turn.end | `Stop`; `StopFailure` on API error | O | async-capable; Caddie reads the transcript delta here |
| context.compact.before | `PreCompact` (`trigger: manual|auto`) | O | `systemMessage` is discarded on this event, so the cold-compaction warning is delivered on the next `UserPromptSubmit` or via the status line |
| context.compact.after | `PostCompact` (+ `SessionStart source: compact`) | O | carries `compact_summary`; Caddie records length only |
| subagent.start | `SubagentStart` (`agent_id`, `agent_type`) | O | |
| subagent.stop | `SubagentStop` (`agent_transcript_path`) | O | nested transcript at `<session>/subagents/agent-<id>.jsonl` |
| model.switch | `PostModelSwitch` (`from_model`, `to_model`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`) | O | M2; derived from model id changes in M1 |
| session.end | `SessionEnd` (`reason`) | O | 1.5 s budget: spawn the detached finalizer and return |
| notification | `Notification` | O | not subscribed |

Capabilities declared: `hasTranscript`, `canInjectContext`, `canNotifyHuman`
(`systemMessage`, except on `PreCompact`/`PostCompact`/`Notification`/`SessionEnd`
where it is discarded), `hasStatusLine`, `hasCompaction`, `hasSubagents`,
`hasClear`, `hasTurnBoundary`, `hasSessionEnd`, `hasPromptEvent`,
`hasModelInEvents`. `hasUsageInHooks` is false: no settings hook carries
usage. The status-line input does carry `prompt_cache.*` (hit ratio, misses,
`expires_at`, `recache_tokens_if_cold`) and `cost.total_cost_usd`, which the
status-line reporter uses for calibration of Caddie's own estimate.

Packaging: plugin directory with `.claude-plugin/plugin.json` (`name`
required), `hooks/hooks.json` wrapped in a top-level `hooks` key, `skills/`,
optional `settings.json` defaults. `${CLAUDE_PLUGIN_ROOT}` is the installed
version path (changes on update, never store state there);
`${CLAUDE_PLUGIN_DATA}` persists across updates. Hook commands use exec form
(`command` + `args`) so no shell is involved; `async: true` on `Stop`,
`SubagentStop` and `PostCompact` so they never block. Plugin hooks are
deduplicated against identical settings-file hooks.

Observation source: `~/.claude/projects/<cwd with non-alphanumerics as
dashes>/<sessionId>.jsonl` (16-char hash on Windows), subagents under
`<sessionId>/subagents/`, large tool outputs under `<sessionId>/tool-results/`.
`CLAUDE_CONFIG_DIR` relocates the root. Retention `cleanupPeriodDays` default
30, so Caddie's own `sessions/<id>.json` is the durable record.
`transcript_path` is written asynchronously and may lag the hook; the
finalizer waits for size stability.

Gaps: the mods API (`turn.step` with per-request usage, `turn.complete`)
would give observed `model.response` events and is the natural M3 upgrade;
whether a plugin can ship a default main `statusLine` is not documented
(users wire `caddie statusline` themselves, or `--wrap` their existing
command).

### 2.2 Gemini CLI

Sources: google-gemini/gemini-cli `docs/hooks/{index,reference,writing-hooks,best-practices}.md`,
`docs/extensions/reference.md`, `docs/cli/session-management.md`,
`docs/reference/configuration.md`, `docs/cli/telemetry.md`,
`packages/core/src/hooks/{types,hookPlanner,hookRunner,hookRegistry,hookEventHandler}.ts`,
`packages/core/src/services/chatRecordingService.ts`,
`packages/cli/src/commands/hooks/migrate.ts` (main, 2026-11-11).

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `SessionStart` (`source: startup`) | O | `additionalContext` supported; cannot block |
| session.resume | `SessionStart` (`source: resume`) | O | |
| session.clear | `SessionStart` (`source: clear`), paired `SessionEnd` (`reason: clear`) | O | |
| prompt.submitted | `BeforeAgent` (`prompt`) | O | can inject `additionalContext` for the turn |
| model.request | `BeforeModel` (`llm_request` with `model`, messages, config) | O | the only harness in this table with a true per-request hook; Caddie observes only, never rewrites |
| model.response | `AfterModel` (`llm_response.usageMetadata.totalTokenCount`) | O, D for detail | fires per streaming chunk, so coalesce per message; full `tokens {input, output, cached, thoughts, tool, total}` are in the chat record, so the adapter prefers the transcript (D) and uses the hook for timing |
| tool.before | `BeforeTool` (`tool_name`, `tool_input`, `mcp_context`) | O | not subscribed in M1 |
| tool.after | `AfterTool` (`tool_response`) | O | not subscribed in M1; sizes derived from the record |
| turn.end | `AfterAgent` (`prompt_response`, `stop_hook_active`) | O | |
| context.compact.before | `PreCompress` (`trigger: auto|manual`) | O | advisory, fired without awaiting |
| context.compact.after | none | D | from the next model request's size drop, or the `chat_compression` telemetry event when telemetry is enabled |
| subagent.start | none | D | subagent transcripts appear under `chats/<parentSessionId>/<subagentSessionId>.jsonl`; start inferred from the file's first record |
| subagent.stop | none | D | inferred from the file's last record; the migrator maps Claude `SubagentStop` to `AfterAgent`, which is not a subagent event |
| model.switch | none | D | model id changes between `BeforeModel` calls |
| session.end | `SessionEnd` (`reason: exit|clear|logout|prompt_input_exit|other`) | O | best effort, not awaited |
| notification | `Notification` (`ToolPermission` only) | O | not subscribed |

Capabilities declared: `hasTranscript`, `hasUsageInHooks` (total only; cache
split comes from the transcript), `canInjectContext`, `canNotifyHuman`
(`systemMessage`), `hasCompaction` (before observed, after derived),
`hasSubagents` (derived), `hasClear`, `hasTurnBoundary`, `hasSessionEnd`,
`hasPromptEvent`, `hasModelInEvents`. `hasStatusLine` is false: the footer
is configurable only through `ui.footer.*` settings, so the status-line
feature degrades to `systemMessage` on turn end and the CLI.

Packaging: an extension under `~/.gemini/extensions/<name>/` with
`gemini-extension.json` (`name`, `version`, `settings[]` for user options)
and hooks in `hooks/hooks.json` using the same shape as settings `hooks`;
`${extensionPath}` and `${workspacePath}` are substituted. Hook commands are
shell strings (no exec form), timeouts are in **milliseconds** (default
60000), all hooks for an event run in parallel unless one sets
`sequential: true`, and project-level hooks run only in trusted folders.
Hooks are synchronous and block the CLI, so every Gemini hook handler must
return in well under a second and defer work to a detached process exactly
as on Claude Code. Env: `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID`,
`GEMINI_CWD`, and `CLAUDE_PROJECT_DIR` as an alias.

Observation source: `~/.gemini/tmp/<project_hash>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`,
JSONL with a metadata record, one record per message (`type: user|gemini`,
`toolCalls`, `thoughts`, `tokens`), and `$set`/`$patch`/`$rewindTo` control
records the adapter must apply in order. Retention
`general.sessionRetention.maxAge` default 30 days. `GEMINI_CLI_HOME` relocates
the root.

Gaps: whether `BeforeTool`/`AfterTool` fire inside subagent loops is
undocumented; `PreCompress` has no `after` counterpart; the `Notification`
`details` payload is undocumented.

### 2.3 OpenCode

Sources: opencode.ai/docs/{plugins, build/plugins, build/plugins/server,
build/plugins/migrate-v1, build/plugins/cli, cli/plugins, compaction,
troubleshooting, agents, migrate-v1}, anomalyco/opencode `dev` branch
`packages/plugin/src/promise/{session,tool,shell,permission,event,registration}.ts`
and `packages/schema/src/{session-event,session-status-event,token-usage,session-message}.ts`
(2026-11-11). OpenCode has two incompatible plugin generations; this mapping
is for **V2** (`@opencode/plugin`, `Plugin.define({id, setup(ctx)})`). V1
(`@opencode-ai/plugin`, last tag v1.19.5, string-keyed hooks such as
`chat.message` and `tool.execute.before`) is deprecated and not targeted.

OpenCode plugins are **in-process TypeScript modules**, not commands. Hooks
are typed callbacks that mutate their input, run sequentially in plugin
order, are always awaited and have no timeout. The adapter therefore runs
inside the harness process, which is the first finding of the fitness
exercise (§4): the kernel must be importable as a library, not only through
the `caddie` CLI.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | event `session.created` (`parentID` absent) | O | plugin `setup()` runs at load, not per session; observed via `ctx.event.subscribe` |
| session.resume | none | — | sessions are server-owned and reopened by id; `session.viewed` is the nearest signal; treated as `session.start` with `resumeUnknown` |
| session.clear | none | — | no clear concept; a new session is `session.created` |
| prompt.submitted | `ctx.session.hook("prompt")`; events `session.inbox.enqueued/delivered` | O | mutate-only hook; Caddie observes |
| model.request | `session.hook("model.request")` / `"context"`; event `session.step.started` | O | |
| model.response | event `session.step.ended {cost, tokens {input, output, reasoning, cache {read, write}}}` | O | **usage in the event**: the only harness here where hooks alone give full cost |
| tool.before | `ctx.tool.hook("execute.before")`; event `session.tool.called` | O | not subscribed in M1 |
| tool.after | `ctx.tool.hook("execute.after")`; events `session.tool.success/failed` | O | sizes from the event payload |
| turn.end | event `session.execution.succeeded/failed/interrupted`; `session.status {type: idle}`; hook `experimental.idle` | O | `session.idle` is deprecated; the only pre-idle intercept is experimental |
| context.compact.before | `session.hook("compaction")` before result; event `session.compaction.started {reason}` | O | |
| context.compact.after | same hook after `result`; event `session.compaction.ended {model, cost, tokens}` | O | compaction cost is reported natively |
| subagent.start | event `session.created` with `parentID` | O | child sessions, no dedicated name |
| subagent.stop | `session.execution.succeeded/failed` on the child session | D | correlated by `parentID` |
| model.switch | `session.hook("experimental.model.resolve")`; model id on each step | D | |
| session.end | `session.execution.interrupted {reason: shutdown}`, `session.deleted`, `session.archived` | O (partial) | no per-session end hook; orphan catch-up is the normal path |
| notification | TUI plugin `context.ui.toast.show`, `context.attention.notify`; slot `home.footer.status` | O | requires a separate TUI plugin entry (`./tui` export) |

Capabilities declared: `hasUsageInHooks` (full, including cache split and
cost), `hasTranscript` (SQLite, see below), `canNotifyHuman` and
`hasStatusLine` (through the TUI plugin part only), `hasCompaction`,
`hasSubagents`, `hasTurnBoundary`, `hasPromptEvent`, `hasModelInEvents`.
`canInjectContext` is available through the `prompt` hook (mutating the
user message) and `metadata.experimental.instructions`; M3 decides whether
to use it. `hasClear` and `hasSessionEnd` are false.

Packaging: an npm package with `package.json` `exports` for `./server` (the
hooks) and `./tui` (footer segment and toasts), depending on
`@opencode/plugin`; listed in `opencode.json(c)` under `plugins`
(`"@agent-caddie/opencode"` or a local directory), or auto-discovered from
`.opencode/plugins/` and `~/.config/opencode/plugins/`; managed with
`opencode plugin add|update|remove`. Config layers merge arrays, so a
company can enable the plugin globally.

Observation source: a single event-sourced SQLite database at
`~/.local/share/opencode/opencode.db` (`OPENCODE_DB` overrides; XDG roots
apply; channel-suffixed names such as `opencode-beta.db`). Per-step usage
and cost are stored on every assistant message and compaction. The adapter
reads it with `node:sqlite` (Node ≥ 22.5) and declares `hasTranscript: false`
on older Node, relying on `hasUsageInHooks` instead. Table layout is not yet
examined (gap).

Gaps: no timeout or concurrency statement for plugin hooks beyond "runs them
in plugin order"; `experimental.idle` exists only in source; the exact
resume flags were not verified.

### 2.4 Pi

Sources: `packages/coding-agent/docs/{extensions, session-format, sessions,
compaction, message-types, settings, environment-variables}.md` and
`src/core/extensions/{runner,types}.ts` in github.com/earendil-works/pi
(formerly badlogic/pi-mono; the old URL redirects), package
`@earendil-works/pi-coding-agent` (2026-11-11).

Pi extensions are **in-process TypeScript modules** (`export default
function (pi: ExtensionAPI)`, `pi.on(event, handler)`), loaded with jiti,
with full OS permissions, every handler awaited in load-then-registration
order, errors logged and ignored except on `tool_call` and `user_bash`, and
no timeouts. Same architectural consequence as OpenCode: the adapter embeds
the kernel.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `session_start {reason: startup|new}` (after `project_trust`, `resources_discover`) | O | |
| session.resume | `session_start {reason: resume, previousSessionFile}`; pre-hook `session_before_switch` | O | `fork` is a resume with a new file |
| session.clear | `session_before_switch {reason: new}` → `session_shutdown {reason: new}` → `session_start {reason: new}` | O | `/new` is the clear analogue; emitted once from the `session_start` |
| prompt.submitted | `input {text, source}` then `before_agent_start {prompt, systemPrompt}` | O | `before_agent_start` can return a `message` to inject context |
| model.request | `context` → `context_with_system` → `before_provider_headers` → `before_provider_request {payload}` | O | |
| model.response | `after_provider_response`, `provider_stream_event`, `message_start/update/end {message}` | O | `message_end` carries the assistant message with full `usage` |
| tool.before | `tool_call {toolName, input, parentToolCallId?}` and `tool_execution_start` | O | not subscribed in M3 beyond `tool_execution_start` |
| tool.after | `tool_result` and `tool_execution_end {result, isError, durationMs}` | O | |
| turn.end | `turn_end {turnIndex, message, toolResults}`; run-level `agent_end` → `agent_before_settle` → `agent_settled {aborted}` | O | canonical `turn.end` maps to `agent_settled` (idle); Pi's `turn_end` is per model step |
| context.compact.before | `session_before_compact {reason: manual|threshold|overflow, preparation.tokensBefore}` | O | cancellable; can supply a custom summary |
| context.compact.after | `session_compact {compactionEntry}`; failure `session_compact_failed` | O | compaction `usage` recorded on the entry |
| subagent.start | none | D | nested tool calls carry `parentToolCallId`; subagents are an example extension only |
| subagent.stop | none | D | `tool_execution_end` with `parentToolCallId` |
| model.switch | `model_select`; `model_change` entry in the session file | O | `thinking_level_select` is the effort analogue |
| session.end | `session_shutdown {reason: quit|reload|new|resume|fork}` | O | |
| notification | `ctx.ui.notify`, `ctx.ui.setStatus(key, text)` footer segment, `setWidget` | O | |

Pi also emits `cache_warming_decision {warmCost, missCost,
continuationProbability, action}` before deciding whether to send a
cache-warming request. That is the harness making the same cold-cache
judgement Caddie's `cache.cold-compaction` rule makes; the adapter records
it as a `harness_event` so the rule can defer to the harness when it is
already warming.

Capabilities declared: all twelve flags true except `hasSubagents`
(derived only) and `hasUsageInHooks` (true: `message_end` carries usage with
`cacheRead`, `cacheWrite`, `cacheWrite1h?`, `reasoning?` and `cost`).
`hasStatusLine` is true via `ctx.ui.setStatus`.

Packaging: an npm package with `package.json` `{"pi": {"extensions":
["./src/index.ts"]}}` installed with `pi install npm:@agent-caddie/pi`, or
a file under `~/.pi/agent/extensions/` (project-local `.pi/extensions/`
after trust). Settings in `~/.pi/agent/settings.json` (`packages`,
`extensions`). `PI_CODING_AGENT_DIR` relocates the root. Runtime deps must be
in `dependencies`.

Observation source: `~/.pi/agent/sessions/--<cwd with separators as
dashes>--/<timestamp>_<uuid>.jsonl`; header line `{type: session, version:
3, id, cwd, parentSession?}` then tree entries (`id`, `parentId`) of types
`message`, `model_change`, `thinking_level_change`, `usage`, `compaction`,
`context_edit`, `branch_summary`, `custom`, `custom_message`, `label`,
`session_info`. Every assistant message carries `usage` and `cost`; `usage`
entries record non-message spend such as cache warming. The adapter must
walk the tree from the leaf (`buildContextEntries` semantics) rather than
read lines in order, because branches coexist in one file.

Gaps: `cache_warming_decision` is documented and dispatched but was not
found in the type literals; RPC and JSON modes (`--mode rpc|json`) may
expose additional event names (`sdk.md`, `rpc.md` not read); absence of
handler timeouts rests on a grep of `runner.ts`.

### 2.5 Codex CLI

Sources: learn.chatgpt.com/docs/hooks (the `developers.openai.com/codex/*`
pages redirect there), the Codex config reference, and the `openai/codex`
source tree (`codex-rs/hooks/src/lib.rs`, `legacy_notify.rs`,
`codex-rs/rollout/src/{lib,recorder,policy}.rs`, `codex-rs/protocol`), all
read 2026-11-11.

Codex has fourteen PascalCase settings hooks and is the only harness besides
Pi that fires a hook on every model request.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `SessionStart` (`source: startup`) | O | output `hookSpecificOutput.additionalContext` becomes developer context; `permission_mode` on the input |
| session.resume | `SessionStart` (`source: resume|fork`) | O | |
| session.clear | `SessionStart` (`source: clear`) | O | start side only; `SessionEnd` `reason` is always `other` today |
| prompt.submitted | `UserPromptSubmit` | O | `prompt` text available; can block; heuristics only |
| model.request | `PreModelRequest` | O | fires per attempt, including retries inside a turn; diagnostic only |
| model.response | `PostModelRequest` (`status`, `error`, `token_usage`) | O | `token_usage` may be `null`; the rollout `TokenCount` event is the authoritative source |
| tool.before | `PreToolUse` (+ `PermissionRequest` for approval gates) | O | not subscribed in M3; tool calls derived from `FunctionCall` rollout items |
| tool.after | `PostToolUse` | O | not subscribed |
| turn.end | `Stop`; `Interrupt` for aborted turns | O | `Stop` output must be JSON; `{"continue": false}` is never sent |
| context.compact.before | `PreCompact` (`trigger: manual|auto`) | O | `systemMessage` is a UI warning, so the cold-compaction nudge can be shown here |
| context.compact.after | `PostCompact` (+ `SessionStart source: compact`) | O | |
| subagent.start | `SubagentStart` (`agent_id`, `agent_type`) | O | |
| subagent.stop | `SubagentStop` (`agent_transcript_path`, `last_assistant_message`) | O | `SessionEnd` never fires for subagents |
| model.switch | none | D | `model` on every hook input and `TurnContext` rollout items |
| session.end | `SessionEnd` | O | main thread only; also fires after 30 minutes idle with no client; 1 s default budget, 3 s maximum, always synchronous |
| notification | none | — | `tui.notifications` and the legacy `notify` program are UI mechanisms, not a hook |

Capabilities declared: all twelve true except `hasStatusLine` (false:
`tui.status_line` is a list of built-in item ids, not a command) and
`canNotifyHuman` restricted to `systemMessage` on the events that support
it. `hasUsageInHooks` is true but the adapter still reconciles against the
rollout because `token_usage` is nullable.

Packaging: `~/.codex/hooks.json` or a `[hooks]` table in `config.toml`;
project-level `.codex/hooks.json` loads only when the project layer is
trusted. Codex plugins ship `.codex-plugin/plugin.json` with a default
`hooks/hooks.json` and go through the same hash-based trust review as any
non-managed hook, so the Caddie plugin must document that users will be asked
to trust it and that every update changes the hash. `async: true` background
handlers are capped at eight per session and cannot block; `SessionEnd`
ignores `async`. Default timeout 600 s, so Caddie sets explicit short
timeouts. `mcp_tool` handlers exist; Caddie uses `command` handlers only.
Enterprise `allow_managed_hooks_only = true` disables plugin hooks entirely,
which the adapter detects as a missing `session.start` and falls back to
logs-only mode.

Observation source: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<conversation_id>.jsonl`
(archived sessions under `archived_sessions/`). Each line is `{timestamp,
ordinal, ...RolloutItem}` with variants including `SessionMeta`,
`ResponseItem` (`Message`, `Reasoning`, `FunctionCall`, `FunctionCallOutput`,
`Compaction`), `TurnContext`, `Compacted`, `EventMsg` (`TurnStarted`,
`TurnComplete`, `TurnAborted`, `TokenCount`) and `TokenUsageRecord`.
`TokenCount` carries `TokenUsage {input_tokens, cached_input_tokens,
cache_write_input_tokens, output_tokens, reasoning_output_tokens,
total_tokens}` plus `last_usage_includes_reasoning` and
`model_context_window`. The hook input `transcript_path` points at the same
rollout but the docs call its format unstable, so the adapter pins the
variant names it reads and fails soft on unknown ones.

Gaps: the rollout layout is documented only in source; `PostModelRequest`
`token_usage` sub-fields were not confirmed against the generated schema;
the default `tui.status_line` items were not seen verbatim; the removal
release for the legacy `notify` program is not stated.

### 2.6 Cursor

Sources: cursor.com/docs/hooks, cursor.com/docs/reference/plugins, the
Cursor CLI reference and SDK pages, read 2026-11-11.

Cursor is the hooks-without-transcript case the fitness exercise in §4 was
designed around. Twenty-one camelCase hooks cover tools, prompts and
subagents in detail, but there is no model-request event, no documented
transcript format, and no token usage anywhere outside the SDK.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `sessionStart` (`session_id`, `composer_mode`, `is_background_agent`) | O | fire-and-forget; `additional_context` and `env` outputs; not fired in cloud agents |
| session.resume | none | — | `sessionStart` fires only on new conversations |
| session.clear | none | — | |
| prompt.submitted | `beforeSubmitPrompt` (`prompt`, `attachments`) | O | blocking; can refuse submission; heuristics only |
| model.request | none | — | |
| model.response | `afterAgentResponse` (`text`), `afterAgentThought` (`text`, `duration_ms`) | O | per assistant message, not per API request; no usage |
| tool.before | `preToolUse`; specific `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` | O | the adapter subscribes to `preToolUse` only |
| tool.after | `postToolUse` (`tool_output`, `duration`), `postToolUseFailure`; specific `afterShellExecution`, `afterMCPExecution`, `afterFileEdit` | O | output size observable here, which replaces the transcript for `tools.output-bloat` |
| turn.end | `stop` (`status: completed|aborted|error`, `loop_count`) | O | `followup_message` would loop the agent; never sent |
| context.compact.before | `preCompact` (`trigger`, `context_tokens`, `context_window_size`, `context_usage_percent`, `is_first_compaction`) | O | observational; `user_message` is shown at compaction time |
| context.compact.after | none | — | derived from the next `afterAgentResponse` after a `preCompact` |
| subagent.start | `subagentStart` (`subagent_id`, `subagent_type`, `subagent_model`, `is_parallel_worker`) | O | `subagent_model` makes `subagents.main-model` evaluable without a transcript |
| subagent.stop | `subagentStop` (`status`, `duration_ms`, `message_count`, `tool_call_count`, `agent_transcript_path`) | O | |
| model.switch | none | D | `model_id` on every hook input |
| session.end | `sessionEnd` (`reason: completed|aborted|error|window_close|user_close`, `duration_ms`) | O | fire-and-forget; IDE and CLI only |
| notification | none | — | `user_message` outputs are the only human-facing channel |

Capabilities declared: `canInjectContext` (`additional_context` on
`sessionStart` and `postToolUse`), `canNotifyHuman` (`user_message` on
blocking hooks), `hasCompaction` (before only), `hasSubagents`, `hasTurnBoundary`,
`hasSessionEnd`, `hasPromptEvent`, `hasModelInEvents`. False: `hasTranscript`
(the path is gated by a "transcripts enabled" setting and the format is
undocumented, so the adapter treats it as absent until verified),
`hasUsageInHooks`, `hasStatusLine`, `hasClear`. Consequence per the
capability matrix: cost is reported as unavailable, cache rules do not load,
and the session report is built from tool counts, durations, output sizes,
compaction stats and subagent models.

Packaging: `hooks.json` (`version: 1`) at `~/.cursor/hooks.json` or
`<project>/.cursor/hooks.json`; plugins ship `.cursor-plugin/plugin.json`
with `hooks/hooks.json` and `${CURSOR_PLUGIN_ROOT}` (the Claude Code alias
`${CLAUDE_PLUGIN_ROOT}` is also expanded). Exit code 2 and
`CLAUDE_PROJECT_DIR` follow Claude Code semantics. Hooks are fail-open
unless `failClosed: true`; Caddie never sets it. Timeouts are in seconds
with an unpublished platform default, so Caddie sets them explicitly.
`loop_limit` applies to `stop` and `subagentStop` follow-ups; Caddie emits
none.

Observation source: none in M3. The CLI's `--output-format stream-json`
carries no usage fields, and the SDK `TokenUsage` is per run and SDK only.
If the transcript format is later documented, `hasTranscript` flips on and
the adapter gains a `parse` implementation without any kernel change.

Gaps: transcript directory and format; the default per-script timeout; the
`statusLine` setting seen in search results but not on the fetched pages;
whether `matcher` applies to `beforeMCPExecution`.

### 2.7 GitHub Copilot CLI

Sources: docs.github.com Copilot CLI hooks reference, config-directory
reference, command reference and chronicle page; `github/copilot-sdk`
`session-events.ts`, read 2026-11-11.

Copilot CLI accepts both its native camelCase names and Claude Code's
PascalCase aliases; the alias switches the payload to snake_case and applies
Claude Code matcher and tool-name mapping. The adapter uses the native
names.

| Canonical | Native | O/D | Notes |
|---|---|---|---|
| session.start | `sessionStart` (`source: startup|new`) | O | `additionalContext` output, joined across hooks; `initialPrompt` present for `-p` runs |
| session.resume | `sessionStart` (`source: resume`) | O | |
| session.clear | `sessionEnd` (`reason: user_exit`, detached) then `sessionStart` (`source: new`) | O | the adapter pairs them by `cwd` and timestamp within 5 s |
| prompt.submitted | `userPromptSubmitted` (`prompt`); `userPromptTransformed` | O | `modifiedPrompt` is SDK only; heuristics only |
| model.request | none | — | `errorOccurred` with `errorContext: model_call` only on failure |
| model.response | none | D | from `assistant.usage` events in the session event log (see observation source) |
| tool.before | `preToolUse` (`toolName`, `toolArgs`); `permissionRequest` | O | `preToolUse` is fail-closed on hook error, so the Caddie hook must exit 0 even on internal failure |
| tool.after | `postToolUse` (`toolResult.textResultForLlm`), `postToolUseFailure` | O | output size observable |
| turn.end | `agentStop` (`transcriptPath`, `stopReason`, `stop_hook_active`) | O | `decision: block` forces another turn; never sent |
| context.compact.before | `preCompact` (`trigger`, `customInstructions`) | O | notification only |
| context.compact.after | none | D | from the event log |
| subagent.start | `subagentStart` (`agentName`, `transcriptPath`) | O | not emitted for the built-in `general-purpose` agent |
| subagent.stop | `subagentStop` (`agentId`, `agentType`, `response`) | O | |
| model.switch | none | D | event log |
| session.end | `sessionEnd` (`reason: complete|error|abort|timeout|user_exit`) | O | |
| notification | `notification` (`notification_type`: `shell_completed`, `agent_completed`, `agent_idle`, `permission_prompt`, `elicitation_dialog`) | O | async; CLI only; not subscribed |

Capabilities declared: `canInjectContext`, `canNotifyHuman` (hook
`progress` lines render in the timeline; `additionalContext` reaches the
model), `hasStatusLine` (`statusLine.command` receives session JSON on
stdin), `hasCompaction` (before only), `hasSubagents`, `hasClear`,
`hasTurnBoundary`, `hasSessionEnd`, `hasPromptEvent`. `hasTranscript` is
provisional (see gaps); `hasUsageInHooks` and `hasModelInEvents` are false.

Packaging: `~/.copilot/hooks/*.json` (`version: 1`), repository
`.github/hooks/*.json`, inline `hooks` in `~/.copilot/settings.json`, or a
plugin's `hooks.json` under `~/.copilot/installed-plugins/<marketplace>/<plugin>/`
with persistent state in `$COPILOT_PLUGIN_DATA`. Copilot also reads the
shared subset of `.claude/settings.json`, so a Claude Code settings-level
installation is picked up automatically; the Caddie plugin must therefore
tolerate being loaded twice and dedupe on `sessionId`. Hook types `command`
(default timeout 30 s), `http` and `prompt`; Caddie uses `command`.
Repository, user and plugin hooks run inside the session sandbox when it is
enabled, so the hook must not assume network access or writes outside
`$COPILOT_PLUGIN_DATA` and `~/.caddie/`.

Observation source: `~/.copilot/session-state/<sessionId>/events.jsonl`,
written periodically during the session and at session end, plus
`session-store.db` (SQLite) for cross-session indexing. The SDK's session
event schema defines a non-ephemeral `assistant.usage` event with
`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens` in an envelope `{id, timestamp, parentId, type,
data, agentId?}`. The adapter reads `assistant.usage` from `events.jsonl`
and declares `hasTranscript` only after a probe finds at least one such
event in the current session; until then cost is unavailable rather than
guessed.

Gaps: whether `events.jsonl` is byte-identical to the SDK event stream is
inferred, not documented; `permissionRequest` input fields are not
tabulated; the `source` reported by the replacement session after `/clear`
is not stated; sessions sync to the user's GitHub account by default
(`remoteExport`), which the privacy doc must mention because Caddie's
findings never leave the machine but the underlying transcript may.

## 3. Packaging standard and conformance checklist

Every adapter ships as a harness-native package that installs Caddie's hooks
and nothing else. The kernel and CLI are the same bundle for every harness;
only the manifest and the hook wiring differ.

| Harness | Package shape | Hook config | Root and data variables | Install command |
|---|---|---|---|---|
| Claude Code | `plugin/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/` | top-level `hooks` key, exec form, `async: true` where allowed | `${CLAUDE_PLUGIN_ROOT}` (per version), `${CLAUDE_PLUGIN_DATA}` (persistent) | `/plugin marketplace add`, `/plugin install caddie` |
| Gemini CLI | `~/.gemini/extensions/caddie/gemini-extension.json` + `hooks/hooks.json` | synchronous, timeouts in ms, `sequential` unset | extension directory | `gemini extensions install`; `gemini hooks migrate --from-claude` as a bootstrap |
| OpenCode | npm package exporting `./server` (and `./tui` for status) with `Plugin.define` | in-process `ctx.session.hook` / `ctx.event.subscribe` | plugin module directory; state in `~/.caddie/` | `opencode plugin add @agent-caddie/opencode` |
| Pi | npm package with `pi.extensions` in `package.json` | in-process event handlers | `PI_CODING_AGENT_DIR` | `pi install npm:@agent-caddie/pi` |
| Codex CLI | `.codex-plugin/plugin.json` + `hooks/hooks.json`, or user `~/.codex/hooks.json` | `command` handlers with explicit `timeout`; `async` for post-events | none documented; state in `~/.caddie/` | plugin install, then trust in `/hooks` |
| Cursor | `.cursor-plugin/plugin.json` + `hooks/hooks.json` | `version: 1`, explicit `timeout`, `failClosed` unset | `${CURSOR_PLUGIN_ROOT}` | plugin install or copy to `~/.cursor/hooks.json` |
| Copilot CLI | plugin directory with `hooks.json`, or `~/.copilot/hooks/caddie.json` | `version: 1`, `command` type, `timeoutSec` set | `$COPILOT_PLUGIN_DATA` | `copilot plugin install` |

Adapter conformance checklist. An adapter PR is not mergeable until each
line is proven by a test in the adapter contract suite or a documented
manual step. `[ADR-0019, ADR-0025 proposed]`

1. Declares a `HarnessCapabilities` object and a `name`; the kernel never
   sees the name outside the adapter and the registry.
2. Maps every native event it subscribes to onto a canonical event with
   `source: 'observed'`, and marks everything it reconstructs as `derived`.
3. Emits `session.start` before any other event for that session, and
   either `session.end` or lets the orphan catch-up close it; never both.
4. Dedupes model responses by the harness's request identifier, or by a
   documented composite key when there is none.
5. Passes the contract suite against both the minimal (transcript-only) and
   full fixtures, plus its own native fixture recorded from a real session
   with prompt text redacted.
6. Never blocks a harness action: no deny, block, follow-up or `continue:
   false` output on any event. Hooks exit 0 on internal error and log to
   the journal.
7. Fits the harness's hook budget on the synchronous path (300 ms target;
   Claude Code `SessionEnd` 1.5 s; Codex `SessionEnd` 1 s), and defers
   finalisation to a detached process where the harness allows it.
8. Stores nothing under the plugin root; all state is in `~/.caddie/` or the
   harness's persistent data directory.
9. Declares which native events it deliberately ignores and why (§1.5).
10. Documents the trust and update story for that harness (hash trust in
    Codex, sandbox in Copilot, hot reload in Cursor).
11. Reads the observation source incrementally with a cursor, tolerates
    partial last lines, and fails soft on unknown record types.
12. Keeps the harness-specific code under `packages/adapter-<name>` with
    no imports from other adapters.

## 4. Architecture fitness exercise

Before any code, the plan required walking two deliberately different
adapters through the design: a logs-only harness and a
hooks-without-transcript harness. The research turned up two more shapes
worth testing, in-process plugins and non-file observation sources. Each
walk-through lists what the adapter needs from the kernel and whether the
current ports satisfy it. Anything that would have forced a kernel change
later is recorded here as a port requirement now.

### 4.1 Logs-only harness: Codex CLI with hooks disabled

Scenario: an enterprise `requirements.toml` sets
`allow_managed_hooks_only = true`, so no Caddie hook ever fires, but the
rollout files are still written.

- The adapter never receives `session.start`. The kernel must therefore
  accept a session whose first event is derived. **Satisfied**: the state
  machine in §1.1 allows a derived `session.start` synthesised from the
  rollout's `SessionMeta` line, and the orphan catch-up already handles
  sessions with no `session.end`.
- Session discovery has no `transcript_path` hint. **Satisfied**:
  `ObservationSource.listSessions({since})` scans
  `$CODEX_HOME/sessions/YYYY/MM/DD/` and is the same call the CLI uses for
  `caddie summary`.
- There is no hook on which to run the pipeline. **Port requirement**: the
  CLI needs a `caddie scan` command (or the finalizer run from a timer)
  that invokes `listSessions`, finalises any session whose file has been
  stable for longer than the harness's idle timeout, and records
  `capabilitiesObserved` with every hook flag false. This is a `Commands`
  port addition, not a kernel change.
- Nudges have nowhere to go. **Satisfied** by the notifier fallback order
  in the capability matrix: everything becomes a post-hoc finding in the
  report.
- All findings carry derived evidence. **Satisfied**: confidence is scaled
  by the derived factor; the rules are unchanged.

### 4.2 Hooks-without-transcript harness: Cursor

Scenario: all twenty-one Cursor hooks are available, but there is no
usable transcript and no usage anywhere.

- Cost cannot be computed. **Satisfied**: `hasTranscript` and
  `hasUsageInHooks` are both false, so the pricing and cache rules do not
  load and the report prints cost as unavailable. The scorer must still
  produce a score from the remaining metrics. **Port requirement**: the
  `SessionRecord` needs every usage-derived field to be optional, and the
  scorer's weights must renormalise over the metrics present. This is a
  kernel type decision recorded for WP2.
- Tool output size, durations and subagent models arrive in hooks rather
  than from a transcript. **Port requirement**: the `HarnessEvents` payload
  for `tool.after` must carry an optional `outputBytes` and `durationMs`,
  and `subagent.start` an optional `model`, so hook-rich harnesses can feed
  the same aggregate fields a transcript would. The aggregate step reads
  the field and does not care which port supplied it.
- `sessionStart` and `sessionEnd` are fire-and-forget and may be dropped.
  **Satisfied**: §1.4 bleed rules already allow a session to be opened by
  its first turn event and closed by catch-up.
- Compaction has a before event with context size but no after event.
  **Satisfied**: the adapter derives `context.compact.after` from the next
  model response, as §1.4 describes for Gemini.

### 4.3 In-process plugin harnesses: OpenCode and Pi

Scenario: the harness loads the adapter as a TypeScript module inside its
own process, with no child process and no stdin JSON.

- The kernel must be importable as a library, not only driven by the CLI.
  **Port requirement**: `packages/kernel` exports `createCaddie(ports)`
  returning the `HarnessEvents` and `Commands` inbound ports; the CLI is one
  host that wires the filesystem adapters, and an in-process plugin is
  another. This is already the hexagonal shape, but it is now a hard
  requirement and a boundary test: the kernel bundle must load without
  touching `process.argv` or the filesystem at import time.
- Hook latency budgets are replaced by event-loop blocking inside the
  harness. **Port requirement**: every `HarnessEvents` method is
  asynchronous and the pipeline never does synchronous filesystem work on
  the event path; writes go through the `Store` port, whose in-process
  implementation batches them.
- Pi's session file is a tree, not a line sequence. **Port requirement**:
  `ObservationSource.parse` returns events in causal order defined by the
  adapter, and the kernel never assumes file order equals event order. The
  cursor type is adapter-opaque.
- OpenCode's history lives in SQLite. **Port requirement**:
  `ObservationSource` must not assume a file path; `locateSession` returns
  an adapter-defined handle, and the cursor may be a row id. The store
  adapter for OpenCode uses `node:sqlite`, which raises the adapter's Node
  floor to 22.5 while the kernel stays on 18.

### 4.4 Usage in hooks without a transcript: Pi and Codex

Scenario: usage arrives on `model.response` events (Pi `message_end`,
Codex `PostModelRequest`) and there may be no need to read a log at all.

- **Port requirement**: the `model.response` payload carries an optional
  canonical `usage` object (`input`, `output`, `cacheRead`, `cacheWrite5m`,
  `cacheWrite1h`, `reasoning`, `harnessReportedCostUsd?`) and the aggregate
  step prefers observed usage over derived when both exist for the same
  request id. The transcript reconciliation becomes a calibration source,
  which is the same role the Claude Code status line already plays.

### 4.5 Outcome

Five port requirements fall out of the exercise, none of which changes the
hexagon: a `scan` command on `Commands`; optional usage-derived fields and
renormalised scoring in `SessionRecord`; optional `outputBytes`,
`durationMs` and `model` on event payloads; `createCaddie(ports)` as the
kernel's public entry with import-time purity; and an adapter-opaque
session handle and cursor on `ObservationSource`. All five are carried into
the interfaces document in Phase 2 and the kernel ADRs in WP2 and WP3.

## 5. Cross-harness summary

O = observed by a native event, D = derived from the observation source,
— = not available. Verified 2026-11-11.

| Canonical event | Claude Code | Gemini CLI | OpenCode | Pi | Codex CLI | Cursor | Copilot CLI |
|---|---|---|---|---|---|---|---|
| session.start | O | O | O | O | O | O | O |
| session.resume | O | O | — | O | O | — | O |
| session.clear | O | O | — | O (`new`) | O | — | O (paired) |
| prompt.submitted | O | O | O | O | O | O | O |
| model.request | D | O | O | O | O | — | — |
| model.response | D | O | O | O | O | O (no usage) | D |
| tool.before | O | O | O | O | O | O | O |
| tool.after | O | O | O | O | O | O | O |
| turn.end | O | O | O | O | O | O | O |
| context.compact.before | O | O | O | O | O | O | O |
| context.compact.after | O | D | O | O | O | D | D |
| subagent.start | O | — | O (`parentID`) | D | O | O | O |
| subagent.stop | O | — | D | D | O | O | O |
| model.switch | O (M2) | D | D | O | D | D | D |
| session.end | O | O | O (partial) | O | O | O | O |
| notification | O | O | O (TUI plugin) | O | — | — | O |
| Usage in hooks | — | O (total only) | O (`step.ended`) | O (`message_end`) | O (nullable) | — | — |
| Observation source | JSONL per session | JSONL per session | SQLite | JSONL tree | JSONL rollout | none | JSONL event log |
| Status line | command | — | `./tui` export | `setStatus` | item list only | — | command |
| Hook transport | child process, stdin JSON | child process, stdin JSON | in-process | in-process | child process, stdin JSON | child process, stdin JSON | child process, stdin JSON or HTTP |
| Sync budget | 1.5 s `SessionEnd` | 60 s default | event loop | event loop | 600 s default, 1 s `SessionEnd` | platform default | 30 s default |

Reading the table: every harness supports the turn skeleton (prompt, tools,
turn end), so the eight M1 rules that depend only on turn structure run
everywhere. Cost-bearing rules run on six of seven harnesses today; Cursor
joins when its transcript format is documented. Compaction-after is the
most commonly derived event, which is why the cold-compaction rule accepts
a derived boundary at reduced confidence rather than requiring an observed
one.

## 6. Sources

- Claude Code: code.claude.com/docs/en/hooks, hooks-guide, plugins,
  plugins/manifest-reference, statusline, claude-directory,
  plugins/mods/events.
- Gemini CLI: geminicli.com/docs hooks reference, extensions, session
  management; `google-gemini/gemini-cli` source for the chat record format.
- OpenCode: opencode.ai/docs/plugins (V2), `anomalyco/opencode` source for
  event names and the SQLite schema.
- Pi: `badlogic/pi-mono` extension docs and `packages/coding-agent` source
  for event names and the session tree format.
- Codex CLI: learn.chatgpt.com/docs/hooks and config reference;
  `openai/codex` `codex-rs/hooks` and `codex-rs/rollout`.
- Cursor: cursor.com/docs/hooks, reference/plugins, CLI and SDK references.
- Copilot CLI: docs.github.com Copilot CLI hooks, config-directory, command
  and chronicle references; `github/copilot-sdk` session event schema.

Research notes with verbatim quotes are kept outside the repository and
summarised here; when a harness changes, update the affected §2 subsection,
bump `last-verified`, and record any mapping deprecation per §1.5.
