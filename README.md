# agent-caddie

**Pre-alpha. Design in progress; nothing to install yet.**

agent-caddie ("Caddie") is an open-source, local-only coach for coding-agent
harnesses, starting with Claude Code. Like a golf caddie it observes every
shot, keeps the scorecard (token cost), knows the course and conditions (task
context and risk), recommends the club (model and effort), and never swings.

It observes without being prompted, measures usage, explains where cost came
from, nudges quietly, reports per session and over time, and teaches. Rules can
be tuned by the user while Caddie stays honest about the side effects of that
tuning. Everything stays on your machine.

## Design documents

Design documents land under `docs/` as they are reviewed. So far:

- [Architecture overview](docs/architecture/overview.md): the hexagon, its
  ports and every component.
- [Flows](docs/architecture/flows.md): sequence diagrams for the session
  lifecycle, reports, rule overrides and bundles.
- [Harness lifecycles](docs/architecture/harness-lifecycles.md): the canonical
  lifecycle and how seven harnesses map onto it.
- [Capability matrix](docs/architecture/capability-matrix.md): which features
  need which harness capabilities.
- [Design spec](docs/specs/2026-11-11-agent-caddie-design.md): the
  point-in-time design record (status `draft`).

Interfaces, the test strategy and the decision records (ADRs) follow in later
phases.

## Licence

MIT. See [LICENSE](LICENSE).
