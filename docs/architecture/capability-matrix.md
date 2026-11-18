---
title: Capability matrix
status: living
last-verified: 2026-11-11
owner: maintainers
depends-on-adrs: [0019, 0025]
---

# Capability matrix

Features are **capability-gated, never harness-gated**. No rule, reporter or
CLI command checks which harness it is running under. Instead every adapter
declares a `HarnessCapabilities` object, and each feature declares the
capabilities it needs and what it does without them. This page is the single
list of both. `[ADR-0025 proposed]`

## Capabilities an adapter declares

| Flag | Meaning | True when |
|---|---|---|
| `hasTranscript` | Caddie can read what the harness recorded (requests, responses, usage, tool calls) through `ObservationSource` | the harness writes a machine-readable session log Caddie can locate |
| `hasUsageInHooks` | Hook payloads carry token usage, so cost can be computed without a transcript | the harness includes usage in its hook or event payloads |
| `canInjectContext` | A hook can return text that the harness adds to the model's context | the harness supports an `additionalContext`-style return |
| `canNotifyHuman` | A hook can show text to the human without it entering the model's context | the harness supports a `systemMessage`-style return, a notification API or a console channel Caddie can write to |
| `hasStatusLine` | The harness has a persistent status area Caddie can render a segment into | the harness supports a status-line command or widget |
| `hasCompaction` | Caddie is told before and after context compaction | the harness emits compaction events (hooks or log entries) |
| `hasSubagents` | Nested agent sessions are visible with their own usage | the harness emits subagent start or stop events, or writes subagent transcripts |
| `hasClear` | Context resets inside one process are distinguishable from new sessions | the harness emits a `clear` event or marks it in the log |
| `hasTurnBoundary` | The adapter can tell when a turn ends while the session is live | the harness emits a stop, idle or agent-end event |
| `hasSessionEnd` | The adapter is told when a session ends | the harness emits a session-end event (otherwise orphan catch-up applies) |
| `hasPromptEvent` | The adapter sees each user prompt as it is submitted (for prompt heuristics and timely nudges) | the harness emits a prompt-submitted event or the transcript records user messages |
| `hasModelInEvents` | The model id used for each request is visible | the transcript or hook payload names the model |

Each flag is also carried as `source: observed | derived` on the events it
governs: an adapter may set `hasCompaction: true` because it reads compaction
markers from a log (derived) even though no hook fires (not observed). A
finding's `confidence` is reduced when its evidence is `derived`.

## Features and what they need

| Feature | Requires | Degraded mode when missing | Component |
|---|---|---|---|
| Cost estimate per session | `hasTranscript` or `hasUsageInHooks`, `hasModelInEvents` | cost shown as "unavailable", never guessed; findings that need cost are suppressed with reason `no-usage` | pricing, aggregate |
| Cache hit rate and `cache.low-hit-rate` | usage with cache fields (`hasTranscript` with cache fields, or `hasUsageInHooks` with cache fields) | rule disabled with reason `no-cache-usage`; report notes the harness does not expose cache data | rules-core |
| `cache.cold-compaction` warning at compaction time | `hasCompaction` (observed) and `canNotifyHuman` | if compaction is only derived: post-hoc finding in the report; if there is no human channel: finding only | rules-core, notifier |
| Standing-prefix estimate and `prefix.large-standing-prefix` | cache-write size of the first request after start, clear or compaction | if `hasClear` is false, segments after a clear are attributed to the same session and the estimate is marked `approximate` | aggregate |
| `effort.high-on-simple-turns` | `hasModelInEvents` plus an effort or reasoning signal in events | rule disabled with reason `no-effort-signal` | rules-core |
| `subagents.main-model` | `hasSubagents` and `hasModelInEvents` | rule disabled; summary notes subagent usage is invisible on this harness | rules-core |
| `tools.output-bloat` | tool results with sizes (`hasTranscript`) | rule disabled | rules-core |
| `mcp.unused-servers` | list of configured servers and tool calls by server | rule disabled when servers are not enumerable | rules-core |
| `prompting.correction-streak` | `hasPromptEvent` (observed) or user messages in the transcript (derived) | rule disabled | rules-core |
| Lesson at session start | `canInjectContext` | lesson moves to the status line if `hasStatusLine`, else to `caddie report` output and the next CLI invocation | notifier |
| Nudge during the session | `canNotifyHuman` and `hasTurnBoundary` | nudges are collected and shown at session end (`hasSessionEnd`) or in the next report | notifier |
| Status-line segment | `hasStatusLine` and live stats (`hasTurnBoundary`) | `caddie statusline` still works when called manually; live stats refresh on session end only | reporters, cli |
| Live stats (`live/<id>.json`) | `hasTurnBoundary` | written once at session end | aggregate, pipeline |
| Detached finalize at session end | `hasSessionEnd` | orphan catch-up finalizes the session when its transcript has been idle for `orphanAfterMinutes`, triggered by the next hook or CLI call | pipeline |
| Session resume detection | `session.resume` observed or derived | a resumed session is treated as new; totals may double-count the resumed prefix, flagged `resumeUnknown` | adapter, aggregate |
| Risk gate | prompt heuristics, paths touched or cwd | with only cwd available the gate is coarser and the risk level is marked `low-evidence` | risk |
| Rule impact tracker | stored history (always available) | none; harness-independent | impact |
| Journal, bundle, overrides, pack CLI | none | none; harness-independent | kernel, cli |
| LLM coaching | deterministic findings (any harness) | none beyond the features above | coach |
| Eval scenarios | an adapter for the scenario's `harness` field | scenario skipped with reason `no-adapter` | evals |

## Minimal and full harness fixtures

The adapter contract test suite runs every adapter against two reference
fixtures, so each future adapter is tested against both ends of the
capability range:

- **Minimal harness**: `hasTranscript: true`, everything else false. No hooks,
  no notifications, no compaction or subagent visibility. Caddie must still
  produce a report with cost, cache rate (if cache fields exist), tool-output
  bloat and a score, with every live feature degraded as the table says.
- **Full harness**: every flag true, hooks for every canonical event, usage
  in the transcript. Everything in the table runs in its primary mode.

A new adapter passes the contract suite when: every event it emits is a valid
canonical event with `source` set; the capabilities it declares match the
events it actually emits on the fixture (an adapter must not declare
`hasCompaction` and then never emit a compaction event on a fixture that
contains one); and the degraded modes above hold for every capability it
leaves false.

## Where the gate lives

- Rules declare `requires: Capability[]` in their definition; the rule engine
  skips a rule whose requirements the active adapter does not meet and records
  `suppressed: {reason: 'capability', missing: [...]}` in
  `RuleEvaluationStats`. Reports list skipped rules under "not measurable on
  this harness" so silence is never mistaken for a clean session.
- The notifier maps a `Notification` to the best available surface in the
  order: requested surface → status line → report. It never drops a
  human-audience notification silently; the fallback is journaled.
- The pipeline checks `hasSessionEnd` and `hasTurnBoundary` to decide between
  live finalize and orphan catch-up.
- Nothing else in the kernel reads capability flags. A component that needs a
  new flag adds it here first, in the same PR as the adapter that declares it.
