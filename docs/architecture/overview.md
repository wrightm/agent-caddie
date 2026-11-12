---
title: Architecture overview
status: living
last-verified: 2026-11-11
owner: maintainers
depends-on-adrs: [0002, 0003, 0004, 0005, 0017, 0019, 0025]
---

# Architecture overview

agent-caddie ("Caddie") is a local-only coach for coding-agent harnesses. This
document is the current truth about how it is put together: the layers, the
ports between them, every component's responsibility and where that
responsibility begins and ends. Flows between components are in
[flows.md](flows.md); the canonical harness lifecycle is in
[harness-lifecycles.md](harness-lifecycles.md); which features need which
harness capabilities is in [capability-matrix.md](capability-matrix.md); typed
interfaces are in [interfaces.md](interfaces.md). Decisions and their
alternatives are in [../adr/](../adr/README.md). Where a section depends on an
ADR that is still `proposed`, it is tagged so nobody treats it as settled.

## 1. Shape: a hexagon with ports

Caddie is a hexagonal (ports-and-adapters) system. The **kernel** is the
hexagon: it holds the data model, the pipeline and all coaching logic, and it
never imports a harness, a filesystem path, a network client or a clock
directly. Everything that touches the outside world does so through a **port**
(a TypeScript interface owned by the kernel) implemented by an **adapter**
(a package outside the kernel). Tests replace every adapter with an in-memory
double. `[ADR-0019 proposed]`

```
                 driving side (things that call Caddie)
   ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
   │ harness hooks      │  │ transcripts / logs │  │ CLI, agents, CI    │
   │ (Claude Code, …)   │  │ on disk            │  │                    │
   └─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
             │ HarnessEvents          │ ObservationSource      │ Commands
   ══════════╪════════════════════════╪════════════════════════╪══════════ ports
             ▼                        ▼                        ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                               KERNEL                                 │
   │  config · pack · pricing · aggregate · risk · rule engine · impact   │
   │  score · pipeline · journal · bundle · coach (budget, prompt)        │
   └──────────────────────────────────────────────────────────────────────┘
             │              │               │              │           │
   ══════════╪══════════════╪═══════════════╪══════════════╪═══════════╪═ ports
             ▼ Store        ▼ Notifier      ▼ LlmProvider  ▼ PackSource ▼ Clock
   ┌──────────────┐ ┌──────────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────┐
   │ store-fs     │ │ claude-code hook │ │ anthropic    │ │ file/url │ │ real │
   │ (~/.caddie)  │ │ stdout, statusln │ │ claude-cli   │ │          │ │      │
   └──────────────┘ └──────────────────┘ └──────────────┘ └──────────┘ └──────┘
                 driven side (things Caddie calls)
```

### Ports

| Port | Direction | Owner | Purpose | Implemented by (M1) |
|---|---|---|---|---|
| `HarnessEvents` | inbound | kernel | Lifecycle events pushed by a harness hook, already mapped to the canonical lifecycle | `adapter-claude-code` |
| `ObservationSource` | inbound | kernel | Pull-based, incremental reading of what the harness recorded (transcripts, logs), with a cursor | `adapter-claude-code` |
| `Commands` | inbound | kernel | Operations a human, an agent or CI invokes: report, summary, rules, pack, bundle, eval, doctor | `cli` |
| `Store` | outbound | kernel | Durable local state: sessions, findings, reports, live stats, journal, overrides, bundles | `store-fs` |
| `Notifier` | outbound | kernel | Deliver a lesson, nudge or status segment to the human or the model through whatever surface the harness offers | `adapter-claude-code` (hook stdout, status line) |
| `LlmProvider` | outbound | kernel | Run one coaching completion with model, reasoning and output limits; return text and usage | `provider-noop` (M1), `provider-anthropic`, `provider-claude-cli` (M2) |
| `PackSource` | outbound | kernel | Fetch an organisation or updated knowledge pack from a file path or URL | `pack-source-file` (M1), `pack-source-http` (later, signed) |
| `Clock` | outbound | kernel | Current time, for gap and TTL arithmetic | real / fake |

Rules of the hexagon, enforced in CI by dependency-cruiser `[ADR-0026 proposed]`:

- `packages/kernel` imports nothing from `packages/adapter-*`, `packages/reporters`, `packages/cli`, and nothing from `node:fs`, `node:child_process`, `node:http(s)` or `node:net`.
- Every other package imports the kernel only through its public `index.ts`.
- No file under `packages/kernel` or `packages/rules-core` contains a harness name (`claude`, `gemini`, `codex`, `cursor`, `opencode`, `copilot`, `pi`) outside of test fixtures and pack data.
- Components exchange data only through the typed interfaces in [interfaces.md](interfaces.md). No component reads another component's files, environment variables or globals.

## 2. Layers

From the outside in:

1. **Harness integration** (`plugin/`, `packages/adapter-claude-code`): packaging that a harness installs, and the adapter that translates the harness's native hooks and transcripts into canonical events. One package per harness. `[ADR-0002, ADR-0017]`
2. **Driving adapters** (`packages/cli`): the single executable (`caddie`) that receives hook invocations and CLI commands and calls the kernel. Also the composition root that wires concrete adapters to ports.
3. **Kernel** (`packages/kernel`): the coaching logic, harness-agnostic. `[ADR-0004]`
4. **Plugins to the kernel** (`packages/rules-core`, `packages/reporters`, sinks): units that the kernel calls through its five plugin contracts: adapter, collector, rule, reporter, sink. Statically registered in M1; a dynamic loader later uses the same contracts. `[ADR-0004]`
5. **Driven adapters**: filesystem store, notifiers, LLM providers, pack sources, clock.
6. **Data**: the knowledge pack (`pack/`) and the user's local state (`~/.caddie/`), both versioned.

## 3. Component descriptions

Every component is described with the same template so its boundary is
explicit:

> **Purpose** · **Begins at / ends at** (the first thing it is responsible for
> and the last) · **Inputs** (port or type) · **Outputs** · **Owns** (state,
> files) · **Depends on** (ports only) · **Must not know about** · **Failure
> behaviour** · **Boundary tests**.

### 3.1 Harness adapter: Claude Code (`packages/adapter-claude-code`)

- **Purpose**: turn Claude Code's native hooks and transcript JSONL into canonical `CaddieEvent`s and deliver notifications through Claude Code's surfaces.
- **Begins at**: raw hook stdin JSON or a transcript path. **Ends at**: a `CaddieEvent[]` with a cursor, or a `NotifierResult`. It does not aggregate, judge or store anything.
- **Inputs**: hook stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, event-specific fields); transcript files under `~/.claude/projects/<cwd-dashed>/<sessionId>.jsonl` and `<sessionId>/subagents/agent-*.jsonl`; status-line stdin JSON.
- **Outputs**: `CaddieEvent[]` (`session_meta`, `request`, `prompt`, `tool_call`, `tool_result`, `subagent_spawn`, `compaction`, `command`, `mcp_change`, `hook_run`, `turn_end`, `harness_event`), each tagged `source: observed | derived`; `Cursor` (file offsets plus seen request ids); `HarnessCapabilities`.
- **Owns**: knowledge of the JSONL entry types and their quirks (one API response is written once per content block with duplicated `usage`, so it dedupes by `requestId`; raw `input_tokens` is often a placeholder while cache fields are reliable); the cwd-to-directory encoding; detection of the cache TTL (1h if `ephemeral_1h_input_tokens` ever appears, else 5m).
- **Depends on**: `Clock`. It reads files through a small `FileReader` it receives from the composition root, so tests can feed it strings.
- **Must not know about**: rules, pricing, scoring, the store layout, other harnesses.
- **Failure behaviour**: unknown entry types are counted and skipped, never thrown; a truncated trailing line is left for the next read; a missing transcript yields an empty event list and a `harness_event` of kind `transcript_missing`.
- **Boundary tests**: fixture transcripts (dedup, compaction, subagents, commands, MCP, output bloat, one anonymised real-shape sample per entry type); the adapter contract suite against both the "minimal" and "full" harness fixtures; hook-input mapping tests per event.

### 3.2 Composition root and driving adapter (`packages/cli`)

- **Purpose**: be the one process the harness or the human runs. Parse arguments, wire concrete adapters to the kernel's ports, dispatch hook events and commands, and guarantee hooks never break the harness.
- **Begins at**: `process.argv` and stdin. **Ends at**: stdout for the harness or human, exit code, and a detached `finalize` child when a session ends.
- **Inputs**: `caddie hook <event>` with hook stdin; `caddie finalize <id>`; `caddie report|summary|rules|pack|bundle|eval|doctor|statusline`.
- **Outputs**: hook JSON (`hookSpecificOutput.additionalContext`, `systemMessage`) or nothing for async hooks; human text, Markdown or JSON for commands; the status-line segment.
- **Owns**: the static registry (which adapters, collectors, rules, reporters and sinks are active); `safeHook` (catch everything, log to `~/.caddie/logs/hook.log`, exit 0 with valid output); argument parsing.
- **Depends on**: kernel public API and every adapter package.
- **Must not know about**: transcript formats or rule internals.
- **Failure behaviour**: a hook never exits non-zero and never prints malformed JSON; a sync hook that exceeds its time budget returns empty output and logs; commands print a one-line error and exit 1.
- **Boundary tests**: spawn the real bundle per hook event with sample stdin and a temporary `CADDIE_HOME`; assert exit code, stdout validity, files written and latency; `run-hook.cmd` with an empty `PATH`.

### 3.3 Kernel: configuration (`kernel/config`)

- **Purpose**: one validated, defaulted `Config` object for the whole run.
- **Begins at**: raw JSON from the store plus environment overrides. **Ends at**: a frozen `Config`.
- **Inputs**: `~/.caddie/config.json`, `CADDIE_*` env vars. **Outputs**: `Config` (`nudges`, `lesson`, `statusline`, `risk`, `cacheTtl`, `thresholds`, `privacy`, `rules`, `pack`, `llmCoach`, `journal`).
- **Owns**: defaults (privacy off-by-default for prompt text, coach disabled, code rules disallowed) and validation messages.
- **Depends on**: `Store`. **Must not know about**: who reads a setting.
- **Failure behaviour**: invalid keys are reported by `doctor` and ignored; a missing file means defaults.
- **Boundary tests**: defaults snapshot; merge precedence (file < env); validation errors.

### 3.4 Kernel: knowledge pack (`kernel/pack`)

- **Purpose**: provide versioned facts the coach reasons with: models and pricing, constants (cache TTLs, auto-compact fraction, CLAUDE.md size guidance), rule defaults and thresholds, lessons, retired advice.
- **Begins at**: the shipped `pack/pack.json`, an optional organisation pack and user overrides. **Ends at**: one resolved `KnowledgePack` with provenance (`shipped 2026.11.1 + org acme-2026-10 + 2 user overrides`). `[ADR-0013, ADR-0020 proposed]`
- **Inputs**: pack JSON documents from `PackSource` and `Store`. **Outputs**: `KnowledgePack`, `PackProvenance`, validation findings.
- **Owns**: the pack schema and validator; layering and precedence; alias lookup; the "unknown model" placeholder entry; the updater interface (`check()` returns `disabled` in M1).
- **Depends on**: `PackSource`, `Store`. **Must not know about**: rules' logic or pricing arithmetic.
- **Failure behaviour**: an invalid organisation pack or override is rejected with a finding and the layer below is used; the shipped pack is always valid by CI invariant.
- **Boundary tests**: validation; layering precedence; alias resolution; `minCaddieVersion` handling; provenance string.

### 3.5 Kernel: pricing (`kernel/pricing`)

- **Purpose**: turn one deduplicated request's usage into an estimated cost and compute cache hit rates.
- **Begins at**: `Usage` plus a model id. **Ends at**: `CostEstimate` with its basis label. `[ADR-0006]`
- **Inputs**: `Usage {input, output, cacheRead, cacheWrite5m, cacheWrite1h, thinking?}`, `KnowledgePack`. **Outputs**: `CostEstimate {usd, basis: 'list-price-cache-fields', tier?}`.
- **Owns**: the formula `input·in + cw5m·in·1.25 + cw1h·in·2 + cacheRead·cacheReadPrice + output·out`, tier selection for two-tier models (Haiku: `input + cacheWrite + cacheRead > 100K`), the estimate label.
- **Depends on**: nothing but types. **Must not know about**: where usage came from.
- **Failure behaviour**: unknown model → cost `null` with reason, never a guess.
- **Boundary tests**: multipliers, tier switch, zero usage, unknown model.

### 3.6 Kernel: aggregator (`kernel/aggregate`)

- **Purpose**: fold a stream of `CaddieEvent`s into one `SessionRecord`, the single structure every rule and reporter reads.
- **Begins at**: `CaddieEvent[]` (possibly incremental) and an existing `SessionRecord`. **Ends at**: an updated `SessionRecord`. Idempotent: replaying the same events yields the same record.
- **Inputs**: events, `KnowledgePack`, `Config`, `Clock`. **Outputs**: `SessionRecord` (identity, timing, cache TTL, requests, turns, prompt heuristics, tools, subagents, compactions, commands, MCP servers seen vs called, model switches, idle gaps, prefix sizes, totals by model and origin, effort counts, cost, risk placeholder).
- **Owns**: turn segmentation; gap and cold-cache detection (idle > TTL before a compaction or request); standing-prefix estimate (cache-write size of the first request after start, clear or compaction); prompt heuristics (word count, has path, has verifiable check, looks like correction) computed from text that is then discarded unless `privacy.storePromptText` is on.
- **Depends on**: `pricing`, `Clock`. **Must not know about**: harness names, rules, reporters.
- **Failure behaviour**: events out of order are sorted by timestamp; missing usage leaves cost `null` for that request and marks the record `costComplete: false`.
- **Boundary tests**: idempotence; every field against the fixtures; privacy (no prompt text present by default).

### 3.7 Kernel: risk (`kernel/risk`)

- **Purpose**: estimate how much accuracy matters in this session and stop the coach recommending "cheaper" where it would be wrong to. `[ADR-0012]`
- **Begins at**: `SessionRecord` and risk config. **Ends at**: `RiskProfile {level: none|elevated|high, matches[]}` and a `riskGate` that rewrites findings.
- **Inputs**: cwd, paths touched, prompt heuristics, commands, configurable keyword and glob lists (auth, payment, stripe, migration, terraform, kubectl, `.env`, prod, secrets). **Outputs**: `RiskProfile`; findings with `cheaper`-tagged actions downgraded to informational with a `riskNote`.
- **Owns**: matching rules and their false-positive guards (e.g. "author" must not match "auth").
- **Depends on**: nothing but types. **Must not know about**: specific rules.
- **Failure behaviour**: on any doubt the level goes up, never down.
- **Boundary tests**: keyword and glob matching, false positives, gate rewriting.

### 3.8 Kernel: rule engine (`kernel/rules`)

- **Purpose**: resolve which rules apply and evaluate them. `[ADR-0008, ADR-0029 proposed]`
- **Begins at**: shipped rule definitions, pack defaults, user overrides (`~/.caddie/rules/overrides.json`: enable, disable, thresholds, severity, snooze-until) and user custom rules (`~/.caddie/rules/custom/*.json` declarative or expression rules; `*.cjs` code rules only when `rules.allowCode` is true). **Ends at**: `Finding[]` with provenance on each finding (which layer produced the rule and with what thresholds).
- **Inputs**: `RuleContext {session, history, pack, config, pricing, thresholds, clock}`. **Outputs**: `ResolvedRule[]`, `Finding[]`, `RuleEvaluationStats` (fired, suppressed, would-have-fired, errors, duration).
- **Owns**: layering and precedence; validation of custom rules; the expression evaluator for declarative rules; isolation of code rules (worker thread, timeout, memory cap); per-rule error containment.
- **Depends on**: `Store` (overrides), `Clock`. **Must not know about**: how findings are rendered.
- **Failure behaviour**: a failing rule produces an `error` stat and a single `config.rule-error` finding, never aborts the evaluation; a code rule that times out is disabled for the run.
- **Boundary tests**: precedence; snooze expiry; invalid custom rule; code rule timeout; "would have fired" accounting.

### 3.9 Core rules (`packages/rules-core`)

- **Purpose**: the shipped coaching rules, each a pure function of `RuleContext`.
- **Begins at**: `RuleContext`. **Ends at**: zero or more `Finding`s with evidence, action, confidence and source URLs.
- **Owns**: one file per rule; each declares `id`, `version`, `category`, `defaults`, `sources` (non-empty) and `watches` (the metrics it guards, so the impact tracker can measure what happens when the rule is changed).
- **Depends on**: kernel types only. **Must not know about**: harnesses, the store, reporters.
- **Failure behaviour**: exceptions are contained by the engine.
- **Boundary tests**: per-rule fixtures; invariant test that every rule has a pack entry, an active status, at least one source URL and a lesson.

### 3.10 Kernel: impact tracker (`kernel/rules/impact`)

- **Purpose**: tell the user what their tuning did. `[ADR-0009]`
- **Begins at**: a rule change (journal event with before/after values) and the history of sessions since. **Ends at**: `Finding`s of kind `config.rule-override-impact` and a `TuningSummary` for reports.
- **Inputs**: `Journal` events, `SessionRecord[]` history, `ResolvedRule[]` with `watches`. **Outputs**: for each change: watched metrics before vs after (windowed), count of times a disabled or relaxed rule would have fired, and a plain-language statement.
- **Owns**: windowing and minimum-sample logic so it never reports on one session.
- **Depends on**: `Store`, `Clock`. **Must not know about**: rule internals beyond `watches`.
- **Failure behaviour**: insufficient data yields no finding, never a guess.
- **Boundary tests**: window arithmetic; minimum samples; would-have-fired counts.

### 3.11 Kernel: scorer (`kernel/score`)

- **Purpose**: one comparable number per session (the "coach score") with a visible breakdown.
- **Begins at**: `Finding[]` and `SessionRecord`. **Ends at**: `Score {value 0–100, breakdown[]}`.
- **Owns**: severity weights, caps, the cache-efficiency bonus.
- **Depends on**: nothing but types. **Failure behaviour**: none; pure.
- **Boundary tests**: snapshot of breakdowns.

### 3.12 Kernel: journal (`kernel/journal`)

- **Purpose**: an append-only record of what the user did and what Caddie did, so behaviour can be reviewed, shared and debugged. `[ADR-0011, ADR-0030 proposed]`
- **Begins at**: a `JournalEvent` from any kernel component. **Ends at**: a line in `~/.caddie/journal/<yyyy-mm>.jsonl`.
- **Inputs/outputs**: events of kind `lesson_injected`, `nudge_shown`, `nudge_suppressed`, `finding_emitted`, `report_written`, `rule_changed`, `config_changed`, `pack_loaded`, `cli_command`, `hook_error`, `coach_spend`, and behaviour signals (`command`, `compaction`, `model_switch`, `prompt_heuristics`). All redacted according to `privacy` before writing.
- **Owns**: retention (90 days default) and redaction at the write boundary.
- **Depends on**: `Store`, `Clock`. **Must not know about**: who consumes the journal.
- **Boundary tests**: redaction; retention; ordering.

### 3.13 Kernel: pipeline (`kernel/pipeline`)

- **Purpose**: orchestrate the components in the right order for the three entry points: live update, finalize and summarise.
- **Begins at**: a session locator or a time range. **Ends at**: outputs handed to sinks and a journal entry. The pipeline contains no coaching logic.
- **Order (finalize)**: locate → wait for transcript stability → collect (adapter, incremental, dedup) → aggregate → risk → resolve rules → evaluate → risk gate → impact tracker → score → reporters → sinks → journal.
- **Owns**: ordering, the finalize lock (one finalizer per session), orphan catch-up.
- **Depends on**: every port. **Must not know about**: file formats.
- **Boundary tests**: end-to-end on fixtures with a temporary `CADDIE_HOME`; lock contention; orphan catch-up.

### 3.14 Kernel: bundle (`kernel/bundle`)

- **Purpose**: package local state for sharing, with the user in control. `[ADR-0011]`
- **Begins at**: a time window and options. **Ends at**: `~/.caddie/bundles/<date>.tar.gz` plus a printed manifest of exactly what is inside.
- **Owns**: the redaction pass (paths, prompt text, hostnames, usernames) and the manifest format.
- **Depends on**: `Store`. **Must not know about**: any upload destination. It never uploads.
- **Boundary tests**: redaction; manifest completeness; round trip into an eval scenario.

### 3.15 Kernel: LLM coach (`kernel/coach`)

- **Purpose**: optional prose coaching on top of the deterministic findings, under a budget. `[ADR-0018 proposed]`
- **Begins at**: deterministic findings plus a redacted session digest. **Ends at**: `Finding`s with `confidence < 1` and a `coach_spend` journal event. Disabled by default.
- **Owns**: `CoachBudget` (per-session, per-day, per-month caps computed from the journal; `skip` or `downgrade` on exceed), the prompt version, reasoning settings (effort, thinking budget), `minSessionCostUsd` gating.
- **Depends on**: `LlmProvider`, `Journal`, `Clock`. **Must not know about**: provider SDKs.
- **Failure behaviour**: any provider error or budget refusal yields no finding and a journal entry; never blocks a report.
- **Boundary tests**: budget windows; downgrade path; redaction of the digest; no-op provider.

### 3.16 Reporters (`packages/reporters`)

- **Purpose**: render the same inputs into each output format.
- **Begins at**: `ReportInput {session, findings, score, tuning, packProvenance, coachSpend}`. **Ends at**: `ReportOutput[]` with a target (`file`, `stdout`, `live-cache`, `lesson`).
- **Owns**: formats: JSON (the agent-consumable contract, schema-versioned `[ADR-0014]`), Markdown, lesson (≤160 chars), status-line segment. HTML later.
- **Depends on**: types only; pure functions. **Must not know about**: the store or the harness.
- **Boundary tests**: snapshots per format; JSON schema validation.

### 3.17 Sinks

- **Purpose**: put `ReportOutput`s somewhere. M1: the local store (`sessions/<id>.json`, `<id>.findings.json`, `reports/<date>-<id8>.md`, `index.jsonl`, `lesson.json`, `live/<id>.json`). A future opt-in upload sink is a separate plugin and is the only place a network destination could ever appear. `[ADR-0003]`
- **Boundary tests**: atomic writes (temp + rename); index append; live-file lifecycle.

### 3.18 Notifier adapter (Claude Code)

- **Purpose**: deliver what the kernel decided to say through what the harness offers.
- **Surfaces**: `additionalContext` on `SessionStart` (the one ≤160-char lesson, costs tokens so it is capped), `systemMessage` on any hook (shown to the human, zero tokens; used for nudges), the status-line segment (`$0.42 · cache 91% · coach 78 · ⚠ cold compact`). `[ADR-0007]`
- **Owns**: the mapping from `Notification {audience: human|model, urgency, text}` to the surface, and the rule that nothing goes to the model except the lesson.
- **Boundary tests**: output JSON per hook event; token cap.

### 3.19 Plugin package (`plugin/`)

- **Purpose**: what Claude Code installs from the marketplace. Contains `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/run-hook.cmd` (locates Node with an empty `PATH`, logs and exits 0 if none), `skills/caddie/SKILL.md` (≤40-word description) and the committed single-file bundle `dist/caddie.cjs`. `[ADR-0005]`
- **Owns**: nothing at runtime; it is packaging.
- **Boundary tests**: dist freshness in CI; `run-hook.cmd` with and without Node.

## 4. Data the system owns

```
~/.caddie/                      (override with CADDIE_HOME)
  config.json                   user configuration
  pack/overrides.json           user pack overrides; pack/org.json cached organisation pack
  rules/overrides.json          rule overrides; rules/custom/*.json|*.cjs user rules
  sessions/<id>.json            SessionRecord (survives the harness's own transcript cleanup)
  sessions/<id>.findings.json   Finding[] for the session
  reports/<date>-<id8>.md       Markdown report
  live/<id>.json                LiveStats for sessions in progress (deleted on finalize)
  index.jsonl                   one line per finalized session for summaries
  lesson.json                   the next lesson to inject
  journal/<yyyy-mm>.jsonl       Caddie actions and behaviour signals
  bundles/<date>.tar.gz         shareable, redacted bundles
  logs/hook.log                 hook diagnostics
```

Every persisted document carries `schemaVersion`. The pack carries
`packVersion` and `minCaddieVersion`. Findings JSON carries
`findingsSchemaVersion`. Breaking changes to any of these follow the policy in
`[ADR-0014 proposed]`.

## 5. Where responsibilities end: a quick reference

| Question | Answer |
|---|---|
| Who knows the transcript format? | Only the harness adapter. |
| Who knows prices? | Only the pack (data) and pricing (arithmetic). |
| Who decides something is a problem? | Only rules. |
| Who decides whether to say it? | Risk gate (content) and config `nudges` (channel); the notifier only delivers. |
| Who talks to a model? | Only the LLM coach, through `LlmProvider`, under `CoachBudget`. |
| Who writes to disk? | Only the `Store` adapter; the kernel asks. |
| Who touches the network? | Nothing in M1. Later: `PackSource` (signed pack) and an opt-in upload sink. |
| Who can block the user? | Nobody. Hooks always exit 0 and never return a blocking decision. |
