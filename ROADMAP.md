# Roadmap

agent-caddie is pre-alpha: design documents and tooling, no code yet.

This page says where the project is going and what it will not do. It makes
no date commitments: order and status are published, dates are not. Current
status lives in the milestones and issues linked below, not on this page.

## Direction

The work is grouped into four milestones, in order.

1. **[Foundations](https://github.com/wrightm/agent-caddie/milestone/1)**:
   the documents and tooling that come before any code. Typed interfaces,
   the test and evaluation strategy, the decision record index, repository
   structure, the delivery pipeline and developer documentation.
2. **[M1 Observe](https://github.com/wrightm/agent-caddie/milestone/2)**: the
   first usable version, for Claude Code only. Caddie observes sessions,
   explains where cost came from, evaluates eight rules, reports per session
   and over time, and keeps a local journal that can be shared as a redacted
   bundle. Built as ten work packages, each with its own tracking issue.
3. **[M2 Coach](https://github.com/wrightm/agent-caddie/milestone/3)**:
   optional LLM coaching with a hard budget, and HTML reports.
4. **[M3 Harnesses](https://github.com/wrightm/agent-caddie/milestone/4)**:
   adapters for harnesses beyond Claude Code. Which one comes first is
   decided when the milestone starts, on user demand, capability coverage
   and effort.

## Not planned

- **Enforcement.** Caddie never blocks a tool call, a prompt or a model
  choice. It observes and advises.
- **Automatic upload.** Nothing leaves the machine unless the user creates
  a bundle and shares it by hand. An upload destination, if it ever exists,
  will be opt-in.
- **A hosted service or dashboard** run by this project.

## Where to find what

Each kind of fact has one home. Other places link to it rather than repeat
it.

| Question | Where it lives |
|---|---|
| How mature is the project? | The status line at the top of the [README](README.md) |
| Where is it going, and what is out of scope? | This page |
| What is being worked on now? | [Open issues](https://github.com/wrightm/agent-caddie/issues) and the project board |
| What belongs to which milestone, and how far along is it? | [Milestones](https://github.com/wrightm/agent-caddie/milestones) |
| What does a large piece of work involve? | Its tracking issue, which carries a task list |
| What has shipped? | The changelog and GitHub releases, from the first release |
| Why was something decided? | Decision records (ADRs) under `docs/adr/`, as they are written |

## How to influence it

- **Vote.** Add a 👍 reaction to the issue you care about. Reactions are
  counted; "+1" comments are not.
  [Open issues by votes](https://github.com/wrightm/agent-caddie/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)
  shows the current ranking.
- **Propose.** Open an issue describing the problem you want solved. A
  proposal that changes the architecture is settled by a decision record,
  discussed in its pull request.
- **Build.** See [CONTRIBUTING.md](CONTRIBUTING.md).

Votes inform priorities; they do not bind them. The maintainer decides what
is accepted and in what order, and says why when declining.

## How this page is kept current

- It is reviewed at the end of every milestone step and at every release.
- It changes only through a pull request, so a change of direction is
  visible and has a stated reason.
- It carries direction only. If it ever disagrees with a milestone or an
  issue about status, the milestone or issue is right.
