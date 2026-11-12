---
title: agent-caddie design
status: draft
date: 2026-11-11
authors: [wrightm]
supersedes: none
superseded-by: none
living-docs: [docs/architecture/overview.md, docs/architecture/flows.md, docs/architecture/harness-lifecycles.md, docs/architecture/capability-matrix.md]
---

# agent-caddie design

> Point-in-time design record. Once approved it is not edited except for its
> status line; the living documents it links to carry the current truth.
> Status lifecycle: draft → approved → implemented → superseded.

## 1. Problem

Coding-agent harnesses such as Claude Code spend tokens in ways their users
cannot see. The 2026-11-11 research (`Claude Code token optimisation
playbook`) found that most overspend and most avoidable quality loss comes
from a handful of observable behaviours: an expensive default model and
effort, a bloated standing prefix, compactions after the cache has gone
cold, subagents running on the main model, tool-output bloat and vague
prompts. Nothing today watches a session, keeps score over time and teaches
the user what to change. Dashboards exist, but they show totals, not causes,
and they do not coach.

## 2. Goals

- **Observe without being asked.** Install once; every session is measured.
- **Explain cost.** Every figure is traceable to usage fields, a price in a
  versioned knowledge pack and a stated formula. Costs are labelled estimates.
- **Coach, quietly.** Deliver one short lesson at session start, a nudge only
  when it would change what the user does next, and a report at the end.
- **Teach over a horizon.** Reports over days and weeks show trends and
  whether the user's changes helped.
- **Respect risk.** Never recommend a cheaper model or less reasoning on work
  where accuracy matters most.
- **Be tunable and honest about tuning.** Users modify, add and reset rules;
  Caddie measures and reports the side effects of those changes.
- **Stay local and trusted.** No network calls in M1. Prompt text is never
  stored by default. Sharing is an explicit, reviewed, redacted bundle.
- **Be a platform.** Hexagonal kernel; adapters per harness; features gated
  by capability; findings as a stable JSON contract for agents and CI.
- **Learn.** A knowledge pack that updates independently of code and retires
  advice that stops being true.

## 3. Non-goals (M1)

- Enforcing anything. Caddie never blocks a tool call, a prompt or a model.
- Hosted dashboards, team roll-ups or any upload (a future opt-in sink).
- HTML reports (roadmap), OpenTelemetry export, Windows CI.
- LLM coaching execution (config, interfaces and budget metering ship in M1;
  providers and the prompt ship in M2).
- Adapters other than Claude Code (the Gemini CLI adapter is the first
  follow-up and drives the lifecycle design now).

## 4. Users and how they meet Caddie

1. **Individual developer** installs the Claude Code plugin from the
   marketplace. Sees a status-line segment, an occasional system message, a
   one-line lesson at session start, and runs `caddie report` or
   `caddie summary --since 7d` when curious.
2. **Team or company** publishes an organisation pack with negotiated
   pricing or private models; developers import it. Later, a company may
   turn on the upload sink.
3. **Agent workflow** (CI job, skill, another harness) calls
   `caddie report --json` and branches on findings.
4. **Contributor** adds a rule, an adapter, a pack entry or an eval scenario
   following the repo skills and the architecture principles.

## 5. Architecture

The full description is in [overview.md](../architecture/overview.md). In
one paragraph: a harness adapter translates native hooks and transcripts into
canonical lifecycle events; the kernel aggregates them into a `SessionRecord`,
assesses risk, resolves the layered rule set (shipped pack → user overrides →
user custom rules), evaluates rules into findings, gates them by risk, asks
the impact tracker what the user's tuning did, scores the session, renders
reports and writes everything to `~/.caddie/` through a store port, journaling
each action. A single CLI binary serves hooks, commands and the detached
finalize. `[ADR-0002, 0004, 0017, 0019 proposed]`

Canonical lifecycle, capability flags and the mapping for seven harnesses
are in [harness-lifecycles.md](../architecture/harness-lifecycles.md).
Feature gating is in [capability-matrix.md](../architecture/capability-matrix.md).
Sequence diagrams are in [flows.md](../architecture/flows.md).

### 5.1 Decisions this spec depends on

| Area | Leaning | ADR | Status |
|---|---|---|---|
| Data source | hook-driven plugin + transcript reader | 0002 | proposed |
| Network | local-only; signed pack update later; upload opt-in sink | 0003 | proposed |
| Kernel/plugins | five plugin kinds, static registry in M1 | 0004 | proposed |
| Runtime | TypeScript, Node ≥ 18, single committed CJS bundle, zero runtime deps | 0005 | proposed |
| Cost | estimate from cache fields with requestId dedup | 0006 | proposed |
| Nudging | quiet by default; `systemMessage` for humans; `additionalContext` only for the lesson | 0007 | proposed |
| Rules | pack → overrides → custom; declarative first | 0008 | proposed |
| Rule impact | every rule declares `watches`; side effects reported over time | 0009 | proposed |
| Privacy | prompt text redacted by default | 0010 | proposed |
| Journal and bundles | local journal; redacted shareable bundles; never auto-upload | 0011 | proposed |
| Risk | never recommend cheaper on high-risk work | 0012 | proposed |
| Pack | versioned data separate from code; layered shipped → org → user | 0013, 0020 | proposed |
| Agent contract | findings JSON with schema versioning | 0014 | proposed |
| Multi-harness | hexagonal ports; canonical lifecycle; capability gating; observed/derived | 0017, 0019, 0025 | proposed |
| LLM coaching | off by default; provider-pluggable; model, reasoning and budget configurable | 0018 | proposed |
| Evals | scenario-based; own runner + promptfoo; cost-capped CI | 0021, 0024 | proposed |
| User-authored rules | expression rules by default; code rules behind `rules.allowCode` in worker threads | 0029 | proposed |
| Retention | journal 90 days; bundle window 30 days | 0030 | proposed (agreed in planning) |

Where a section below depends on a `proposed` ADR, it describes the leaning.
The ADR is written in full and reviewed before the work package that
implements it starts; if the decision changes, this spec is superseded.

## 6. Behaviour

### 6.1 What is measured

Per session: requests and their usage (input, output, cache read, cache
write 5m and 1h, thinking where reported), cost estimate by model and origin
(main, subagent, compaction), cache hit rate, turns and their prompt
heuristics (word count, path present, verifiable check present, looks like a
correction), tool calls with result sizes, subagents with model and cost,
compactions with idle gap before them, commands (`/clear`, `/compact`,
`/model`), MCP servers seen versus called, model switches, idle gaps longer
than the cache TTL, standing-prefix size, and a risk profile. Over a horizon:
all of the above aggregated by day, model and rule, plus trends and the
tuning summary.

### 6.2 The eight M1 rules

| Rule | Fires when | Evidence shown | Action | Watches |
|---|---|---|---|---|
| `cache.low-hit-rate` | cache read share of input below threshold (default 0.75) over ≥ N requests | hit rate, requests, cold starts | keep sessions warm, avoid long idle gaps, batch work | `cache.hitRate`, `cost.perSession` |
| `cache.cold-compaction` | compaction after idle > cache TTL | idle minutes, prefix tokens re-written, cost | compact before leaving, or `/clear` and restart | `cache.coldCompactions`, `cost.compaction` |
| `effort.high-on-simple-turns` | high effort or large thinking on turns that look simple (short prompt, single file, no verification) | count, cost share | lower effort for simple turns; keep high for design and debugging | `effort.highShare`, `cost.perTurn` |
| `prefix.large-standing-prefix` | first-request cache write above threshold | tokens, estimated breakdown (CLAUDE.md, MCP tools, skills) | trim CLAUDE.md, disable unused MCP servers | `prefix.tokens`, `cost.perSession` |
| `mcp.unused-servers` | servers whose tools were never called across the session (and across history) | servers, estimated tokens per request | disable or scope the server | `prefix.tokens`, `mcp.unusedServers` |
| `subagents.main-model` | subagents ran on the main model while a cheaper model is available | count, cost, model | set `model: haiku` or `sonnet` on agent definitions | `subagents.costShare` |
| `tools.output-bloat` | tool results above size threshold or repeated large reads | tool, bytes, count | use targeted reads, `head`, grep, delegate to a subagent | `tools.outputBytes`, `cost.perTurn` |
| `prompting.correction-streak` | ≥ N consecutive prompts that look like corrections | streak length, turns | restate the goal with a verifiable check; consider `/clear` | `prompting.correctionRate` |

Each rule ships with defaults in the pack, at least one source URL, a lesson
of ≤ 160 characters, a category, and a `requires` list of capabilities. The
risk gate downgrades any action tagged `cheaper` to informational when the
session's risk level is `high`.

### 6.3 Nudging policy

- **Session start**: one lesson, ≤ 160 characters, injected as context. It is
  the only thing Caddie ever adds to the model's context. Rotated so the same
  lesson is not shown twice within `lesson.repeatAfterSessions` sessions.
- **During the session**: a `systemMessage` to the human only when a finding
  would change what they do next (a cold compaction is about to happen, a
  correction streak has reached the threshold). Rate-limited to
  `nudges.maxPerSession` and suppressible per rule via overrides.
- **Status line**: `$0.42 · cache 91% · coach 78 · ⚠ cold compact`, refreshed
  at each turn end; `--wrap` composes with the user's existing status-line
  command.
- **Session end**: nothing is shown; the report is written and
  `caddie report latest` prints it.
- Every delivered or suppressed nudge is journaled.

### 6.4 Tuning rules and seeing the side effects

Users change rules with `caddie rules set|disable|enable|snooze|reset|add|
explain`. Every change is journaled with before and after values and the
rule's `watches`. After `impact.minSamples` sessions (default 5) the impact
tracker emits `config.rule-override-impact` findings and a tuning section in
summaries: the watched metrics before and after the change, and how often
the default rule would have fired. Resetting restores defaults and the
tracker closes the window. This is how Caddie "communicates side effects over
time". `[ADR-0009 proposed]`

### 6.5 Journal and bundles

The journal (`~/.caddie/journal/<yyyy-mm>.jsonl`, 90-day retention) records
Caddie actions and user behaviour signals, redacted at write time. `caddie
bundle` packages a window (30 days by default) of sessions, findings, journal,
config, overrides, pack provenance and doctor output into a redacted tarball
with a printed manifest. Nothing is ever uploaded; the bundle is for the user
to share by hand, and it is the import format for eval scenarios.
`[ADR-0011, 0030 proposed]`

### 6.6 Knowledge pack

Shipped with the bundle and validated in CI. Layered: shipped → organisation
pack (`pack.source`: path or URL) → user overrides. Managed with `caddie pack
show|validate|update|set|edit|import|export|reset|diff`. Every report states
the resolved provenance. Signing and auto-update are deferred; `update` in M1
works against a local path or URL and says it is unverified.
`[ADR-0013, 0020 proposed]`

### 6.7 LLM coaching (configured in M1, executed in M2)

Off by default. When enabled, after the deterministic pipeline, a redacted
session digest (rule ids, metrics, risk level; never prompt text) is sent to
a configured provider and model with configured reasoning effort, thinking
budget and output cap, under per-session, per-day and per-month USD caps
metered from the journal. Over budget means skip or downgrade to a cheaper
model, per config. Coaching findings carry `confidence < 1`, the model and
the prompt version; spend appears in reports. `doctor` validates the
model, reasoning and budget combination against the pack.
`[ADR-0018 proposed]`

### 6.8 Privacy

Prompt text is never stored unless `privacy.storePromptText` is true; only
heuristics are kept. Paths are stored for session reports and redacted in
bundles. Transcripts are read, never copied. The session key file of the
harness is never read. Tests assert that no prompt text appears in the
store, journal or bundle by default. `[ADR-0010 proposed]`

## 7. Interfaces and data

Typed interfaces are specified in Phase 2
([interfaces.md](../architecture/interfaces.md)). The documents Caddie
persists and their schema versions are listed in overview.md §4. The JSON
findings contract is the one external interface and is versioned by
`findingsSchemaVersion`. `[ADR-0014 proposed]`

## 8. Quality

- Unit tests per package; contract tests per port against in-memory doubles;
  fixture transcripts; pipeline end-to-end with a temporary `CADDIE_HOME`;
  hook integration against the real bundle with a latency budget; privacy
  tests; invariant tests linking rules, pack entries, lessons and sources.
- Scenario-based evaluation suite (`evals/`), deterministic in CI on every
  PR, coaching suite scheduled and cost-capped. Multi-harness from day one via
  a `harness` field per scenario.
- Architecture fitness functions in CI (dependency boundaries, no harness
  names in the kernel, front-matter validation).

## 9. Delivery

Milestones: **M1 Observe** (this spec's scope, Claude Code only), **M2
Coach** (LLM providers and prompt, HTML report), **M3 Harnesses** (Gemini
CLI adapter first, then Codex, Cursor, OpenCode, Copilot CLI, Pi as
contributors and capabilities allow). Work packages WP1–WP10 for M1 are
listed in the plan and will become tracking issues. Every PR is human
reviewed; ADRs are reviewed just in time before the work package that
depends on them.

## 10. Open questions

Tracked as issues once the repository has issue templates. At the time of
writing:

1. Whether `effort` can be observed on Claude Code per request (transcript
   field) or only as a session setting; this decides whether
   `effort.high-on-simple-turns` can fire per turn or only per session.
2. Whether the Gemini CLI chat log carries cache usage fields; this decides
   the degraded mode of `cache.*` rules on that harness.
3. The exact set of derived events a logs-only adapter (Codex) can produce
   with acceptable confidence, which the fitness exercise in
   harness-lifecycles.md answers in part.

## 11. Sources

- `~/reports/Claude Code token optimisation playbook.md` (2026-11-11) and its
  notes.
- Harness documentation verified for harness-lifecycles.md, listed there.
- Architecture references: Cockburn, "Hexagonal architecture"; MADR 4.0; the
  Diátaxis framework.
