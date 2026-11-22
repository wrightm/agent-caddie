---
title: "ADR-0018: LLM coaching"
status: accepted
date: 2026-11-21
deciders: maintainers
supersedes: none
superseded-by: none
---

# ADR-0018: LLM coaching

## Context

Caddie's deterministic rules count things: cost, cache use, whether a
session stated how its work would be verified. They cannot judge whether
three corrections were about the same problem, or whether a misunderstanding
came from the prompt or from the agent. The design spec
([section 6.7](/docs/specs/2026-11-11-agent-caddie-design.md)) planned an
optional model pass for this and left its shape open.

A proposal for a "longitudinal prompt-coaching hook" prompted a review of
the field, recorded in
[Agent coaching tools landscape](research/0018-agent-coaching-tools-landscape.md).
Its findings that bear on this decision:

- At least nine tools and two vendor features already analyse coding-agent
  sessions over time. None follows up on whether a habit changed, keeps
  habit state beyond the harness's transcript retention without storing
  prompts, and stays local by default.
- A model's single-pass judgements of this kind are often wrong. In the
  best-documented study a second pass removed 46% of first-pass findings.
- Background model calls from hooks have a record of failures: recursion,
  respawn loops, dropped writes and orphaned daemons.
- No study shows that coaching changes developer behaviour.

The maintainer's goal for this feature is that the coach be as good as it
can be. Several decisions below trade some of the original privacy and
simplicity for that goal, and say so.

## Decision

The coach is off by default. Turning it on is the only consent it asks for.

### 1. The coach reads prompt text from the transcript

When the coach runs, it reads the session's prompt text from the harness's
own transcript and sends it to the configured provider. This replaces the
spec's rule that only a redacted digest with no prompt text is sent.

- There is one opt-in. Enabling the coach means it reads prompt text and
  sends it to the provider. There is no second setting.
- Transcript text is redacted for secrets before it is sent.
- The transcript is treated as untrusted data (see decision 11).
- The documentation explains what the user gets in return: findings
  grounded in their own words, judgements rules cannot make, and follow-up
  on habits.

### 2. Evidence quotes are stored; prompts are not

Each coaching finding keeps the short verbatim quotes that justify it, in
their redacted form.

- Quotes are kept for 90 days, the journal's retention period (ADR-0030).
- Quotes are never included in shareable bundles.
- There is no archive of full prompts. A user who wants to re-score older
  sessions raises the harness's own transcript retention
  (`cleanupPeriodDays` on Claude Code).

### 3. Storage stays on the journal and JSON files

Coaching data uses the append-only JSONL journal and JSON files the design
already has. SQLite is not added.

- Sessions are in `sessions/<id>.json` and `index.jsonl`.
- Per-prompt measurements are `prompt_heuristics` journal events.
- Coaching results are findings with `category: coaching`, plus
  `lesson.json`.
- Trend queries across sessions are done in code over the journal and
  index.

### 4. Providers sit behind the `LlmProvider` port

The coach reaches a model only through the `LlmProvider` port: one coaching
request in; structured findings, token usage and cost out. The coach does
not know which adapter served the request.

| Adapter | Route | Status |
|---|---|---|
| `provider-anthropic` | Messages API with an API key | Default and supported |
| `provider-claude-cli` | The signed-in `claude` command | Fallback when no API key is provided |
| Agent SDK adapter | Claude Agent SDK | Optional separate package, built only if users ask |
| Local-model adapter | A local model server | Later, once the evals can judge its quality |

The provider is selected in this order:

1. The provider named in `config.llmCoach`, if one is named.
2. `provider-anthropic`, if an API key is provided.
3. `provider-claude-cli`, if the session's harness is Claude Code and the
   `claude` command is installed and signed in.
4. Otherwise no coaching; a `coach_skipped` event records the reason.

Further rules:

- The fallback applies only when no key is provided. A failed API call is
  recorded as `coach_error` and does not switch to the CLI, so the account
  that is charged never changes without the user knowing.
- The first run on the CLI route tells the user which route is in use and
  that it draws on their Claude plan.
- Findings record the provider and model that produced them.
- The choice of default model is left to the evals. Every route reaches the
  same models, so quality depends on the model and the prompt, not the
  route.

### 5. Budget: call caps everywhere, USD caps where cost is real

- Call caps apply on every route: one end-of-session pass per session, a
  small capped number of mid-session checkpoint passes per session, and a
  daily cap across both. A coach call together with its validation call
  (decision 10) counts as one pass.
- USD caps (per session, per day, per month) apply on the API route,
  metered from the usage the provider returns and recorded in the journal.
- On the CLI route the per-session cap is passed as `--max-budget-usd`, and
  the reported `total_cost_usd` is journalled as an estimate. A call there
  draws on plan limits, not a dollar balance, so the call caps are the hard
  limit.
- A size gate (`minSessionCostUsd`) skips sessions too small to be worth
  coaching.
- Over budget means skip, recorded as `coach_skipped`. The spec's option to
  downgrade to a cheaper model is removed.
- `coach_spend` events say whether a cost is metered or estimated.

### 6. Three triggers, one code path, one-shot processes

- **End of session:** a step inside the detached `caddie finalize`. This is
  the default automatic trigger. It reuses the session lock, the wait for a
  stable transcript and orphan catch-up.
- **Mid-session checkpoints:** the `Stop` hook does a cheap check against
  the journal and exits. When a threshold is met, it spawns the same
  detached one-shot worker. Checkpoints are on by default with conservative
  thresholds and a setting to turn them off.
- **On demand:** a `caddie coach` command, for a session skipped for
  budget, a re-score after a prompt-version change, or a platform where the
  detached spawn is unreliable.

Further rules:

- The coach step can fail or time out without affecting the rest of the
  finalizer. The deterministic findings are written first.
- A checkpoint result is written to a pending file and shown at the next
  point the harness allows. It never blocks a prompt.
- The checkpoint worker waits for a stable transcript, because `Stop` can
  fire before the transcript is written. A `Stop` that does not fire loses
  nothing, because the finalizer still runs.
- The end-of-session pass takes the session's checkpoint findings into
  account, so the same point is not made twice.
- There is no daemon and no scheduled task.

### 7. The prompt hook measures and never acts

The `UserPromptSubmit` hook computes heuristics, journals them as
`prompt_heuristics` events and discards the text, within a target of 300 ms
including Node start-up.

- It does not block, rewrite or comment on a prompt.
- It makes no model call and writes no raw prompt text.
- The checkpoint thresholds in decision 6 are read from these events.

### 8. Delivery is layered

| Surface | What it carries |
|---|---|
| Session start | One focus habit, shown to the person |
| Mid-session | A checkpoint finding as a `systemMessage`, within `nudges.maxPerSession` |
| Status line | The coach score |
| Report | All findings with their evidence quotes, and the trend for each habit |

- At session start a `systemMessage` is used if the harness displays it
  there. `additionalContext` reaches the model, not the person, and is the
  fallback only.
- Every coaching finding is assigned to one habit from a fixed list in the
  pack, so habits can be counted across sessions. The impact tracker, with
  its minimum of five sessions, reports whether a habit improved.
- The coach has one focus habit at a time. It stays on it until it improves
  or the user dismisses it.
- A finding the model cannot assign to a listed habit is kept in the report
  and is not used for follow-up.
- Habit state (counts and trend) holds no prompt text, so it can outlast
  the 90-day quote retention.
- Tone is neutral. A finding states what happened and the quote, with no
  praise or scolding.

### 9. Rules count; the model judges

- Deterministic rules keep verification at session level, grounding on a
  first prompt, cost signals and counts. The model receives those results
  and does not recompute them.
- The model makes a fixed set of judgements: which corrections belong to
  the same issue, where a task starts and ends, the likely cause of a
  misalignment (the prompt or the agent), and which habit a finding belongs
  to.
- The model reports a behaviour as a problem only when the transcript shows
  an observable harm: pushback, rework, a failed check or abandonment.
- The model gives no scores. Scores are computed in code from the validated
  findings.
- Each finding carries one concrete suggestion, written as a rewrite of the
  user's own quoted prompt. Advice to add text to an instructions file is
  not given by default.
- Cause is reported as likely, not certain.

Of the proposal's five metrics, verification rate and grounding become
deterministic rules, correction ratio and context drift become model
judgements gated on a harm signal, and the micromanagement index is dropped
for lack of evidence.

### 10. Coach output is validated in four layers

1. **Fields on every finding:** `confidence < 1`, the provider, the model,
   and the coach and validator prompt versions.
2. **Quote check on every finding:** each evidence quote must appear
   verbatim, at the stated turn, in the redacted transcript text the model
   was sent. A finding that fails is dropped.
3. **Second pass on every coaching pass:** a separate model call sees each
   finding with its quote and the surrounding turns, and keeps or rejects
   it. Only kept findings are shown or counted towards habits.
4. **Release gate:** a change to the coach prompt, the validator prompt or
   the default model ships only if precision on a human-labelled set meets
   a threshold.

Further rules:

- Dropped and rejected findings are journalled as counts.
- The eval grader is pinned and given a threshold.
- User-reported helpfulness is not used as validation.
- Reproducibility comes from the pinned model, the pinned prompts and the
  quote check. Current Claude models reject sampling parameters, so a
  temperature of 0 is not available.

### 11. Safety guards

Recursion:

- The child process gets an environment variable owned by Caddie. Every
  Caddie hook exits at once when it is set. This is the guard relied on.
- On the CLI route the child is also started with
  `--settings '{"disableAllHooks": true}'`.
- A lock allows one coach process per session. The daily call cap is the
  last line of defence.

Untrusted input:

- The coach and validator calls have no tools.
- The transcript is passed as delimited data, with the rule that nothing in
  it is followed as an instruction.
- Output must match the schema; anything else is discarded.
- Coach text shown to the user is plain text with a length limit.
- The evals include prompt-injection cases.

Failure handling:

- Any provider error yields no finding and a `coach_error` journal entry.
- There is no automatic retry within a session.
- The coach process has a hard timeout.
- After repeated failures the coach pauses until the next day, and `doctor`
  reports it.

### 12. Port-level contract; Claude Code verified first

- The coach depends only on ports: `LlmProvider` for the model and the
  harness adapter for the transcript. Nothing in the coach names Claude
  Code.
- The capability matrix gates the coach. It needs a readable transcript and
  a way to run after the session. A harness without both gets deterministic
  findings only, and `doctor` says why.
- Claude Code is the only route verified at first. Each other harness is
  added after its transcript format, session-end behaviour and credential
  terms are checked.
- Hooks identify the harness they are running in, because some harnesses
  load Claude Code hook configuration.

## Alternatives considered

| Decision | Alternative | Why not |
|---|---|---|
| 1 | Send only a redacted digest with no prompt text | The model could not ground findings in quotes or make the judgements in decision 9 |
| 2 | Keep a full prompt archive | Little benefit over the harness's own retention setting, at a large privacy cost |
| 3 | SQLite | `node:sqlite` needs Node 22.5 or later; concurrent hook writes have a failure record in a comparable tool |
| 4 | Agent SDK as the main route | A runtime dependency and a whole agent harness for a single request |
| 4 | CLI route as opt-in only | A user with no API key would get no coaching |
| 5 | USD caps only | Only an estimate on the plan route; does not bound quota use |
| 5 | Downgrade to a cheaper model when over budget | A weaker model taking over silently works against the goal |
| 6 | Daemon | The worst failure record in the research |
| 6 | Scheduled task or command only | Coaching would depend on set-up or on the user remembering |
| 7 | Synchronous checks that act on the prompt, and a raw prompt log | A comparable tool reversed this design; the log contradicts decision 2 |
| 7 | No prompt-time work | Checkpoints would have nothing cheap to trigger on |
| 8 | A single surface | Either not timely, not detailed, or never read |
| 9 | The model scores behaviours directly | Not reproducible; two of the proposed metrics lack evidence |
| 10 | Provenance fields only | Labels uncertainty without reducing it |
| 12 | Specify every harness now | Their headless modes and credential terms were not researched |

## Consequences

Good:

- Findings are grounded in the user's own words and can be checked.
- The coach can follow up on a habit, which no local tool in the research
  does.
- A user with no API key still gets coaching on Claude Code.
- Node 18, the single CJS bundle and zero runtime dependencies are
  unchanged.

Costs and risks:

- Redacted prompt text leaves the machine when the coach is on. With the
  coach off, nothing changes.
- Redacted evidence quotes are stored locally for 90 days.
- Each coaching pass makes two model calls.
- The CLI route depends on behaviour Anthropic could change: the terms for
  spawning `claude -p` are not confirmed for this use, and a planned
  `--bare` default for `-p` never reads the signed-in credentials and would
  break the route.
- Re-scoring after a prompt or rubric change is possible only within the
  harness's transcript retention.
- No study shows that coaching changes developer behaviour. The impact
  tracker is this project's own evidence, and it measures habits, not
  outcomes.

Documents to update when this is implemented:

- Design spec: section 6.7 (transcript reading, call caps, no downgrade),
  section 6.8 (what leaves the machine; quotes in the store), the nudging
  and LLM coaching rows in section 5.1, and section 9 (delivery).
- [flows.md](/docs/architecture/flows.md): flow 7 needs the transcript
  read, the validation pass and a checkpoint variant.
- [capability-matrix.md](/docs/architecture/capability-matrix.md): the
  coach now needs a readable transcript; add whether each harness shows a
  `systemMessage` at session start.
- [overview.md](/docs/architecture/overview.md): the `LlmProvider` contract
  and the adapter list.
- Privacy tests: "no prompt text in the store" becomes "no prompt text in
  the store except redacted evidence quotes on coaching findings, and none
  in bundles".
- The pack: a new fixed habit list, each habit with an identifier, a
  description and how improvement is measured.

## To verify or set before or during implementation

Not verified by the research:

- Whether a `systemMessage` returned from `SessionStart` is shown to the
  user, per harness.
- Whether `disableAllHooks` also disables plugin hooks. A test must prove
  that the environment-variable guard alone stops recursion.
- Detached spawn from a hook on Windows.
- Node start-up time inside a hook, which the 300 ms target depends on.
- The token overhead of a `claude -p` call.

Values deliberately not set here:

- The default model, chosen by the evals.
- The call caps, USD caps and size gate.
- The checkpoint thresholds.
- The precision threshold for the release gate. The reference is 0.93 on
  200 human-checked records in the misalignment study.
- The timeout, and the number of failures that pauses the coach.

Work this creates:

- A human-labelled set of transcripts whose owners agree to their use. It
  is never shipped in a bundle.

## References

- [Agent coaching tools landscape](research/0018-agent-coaching-tools-landscape.md),
  the research behind this decision, with sources.
- [Design spec](/docs/specs/2026-11-11-agent-caddie-design.md), sections
  5.1, 6.7, 6.8 and 9.
- [Architecture overview](/docs/architecture/overview.md) and
  [flows](/docs/architecture/flows.md).
- ADR-0030 (journal retention and bundle window), not yet written.
