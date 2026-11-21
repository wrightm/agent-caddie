# Contributing to agent-caddie

Thank you for your interest. agent-caddie is pre-alpha: the repository holds
design documents and no code yet. This guide covers what applies today and
will grow as code, tests and tooling land.

## What is useful right now

- **Review the design.** Read the documents under `docs/` and the open pull
  requests, and comment where something is wrong, unclear or missing.
- **Correct a harness fact.** The design maps several coding-agent harnesses
  onto one lifecycle. If a hook, field or behaviour is described incorrectly,
  open an issue or a pull request with a link to the source.
- **Open an issue** for a question, an idea or a problem. Issue templates
  are not in place yet, so plain issues are fine.
- **Vote on priorities.** Add a 👍 reaction to the issues you care about.
  [ROADMAP.md](ROADMAP.md) says where the project is going, what is out of
  scope, and where to find current status.

Suspected vulnerabilities go through the private process in
[SECURITY.md](SECURITY.md), never a public issue.

## How changes are made

Every change reaches `main` through a pull request, including the
maintainer's. Direct pushes are blocked.

1. Branch from `main`. Name the branch `<type>/<short-topic>`, for example
   `docs/fix-cursor-hooks`.
2. Keep the pull request to one topic and as small as it can be.
3. Give it a [Conventional Commits](https://www.conventionalcommits.org/)
   title, such as `docs(architecture): correct the Gemini cache fields`.
   Pull requests are squash-merged, so the title becomes the commit on
   `main`. Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `ci`,
   `chore`.
4. Say in the description what changed, why, and how you checked it, and
   name the issue it belongs to (see [Linking work](#linking-work)).
5. Make sure the checks pass and every review conversation is resolved.

## Linking work

Every pull request belongs to an issue, and says so in its description:

- `Part of #N` when the issue stays open after the pull request merges;
- `Closes #N` when the pull request finishes the issue. GitHub then closes
  the issue on merge.

That one line is what keeps the rest in step. The issue carries the
milestone, the [project board](https://github.com/users/wrightm/projects/1)
follows the issue, and the pull request appears on the issue's timeline. A
`linked issue` check fails a pull request whose description names no issue.
If nothing fits, open an issue first.

A large piece of work has a tracking issue with a task list. When a pull
request completes one of its deliverables, tick the box once it has merged.

Coding agents do all of this themselves, including moving items on the
board with `scripts/board.sh`. Their instructions are in
[AGENTS.md](AGENTS.md).

## Review

The project has a single maintainer, [@wrightm](https://github.com/wrightm),
who reviews and merges every pull request. Automated reviewers may comment,
but their comments are advisory and never count as approval. When more
maintainers join, this section and a `CODEOWNERS` file will say who reviews
what.

## Checks

Four checks run on every pull request against its files, and a fifth,
`linked issue`, reads the description (see [Linking work](#linking-work)).
You can run the four locally from the repository root:

```sh
# Markdown style
npx markdownlint-cli2 "**/*.md"

# Links between files and heading anchors (needs lychee installed).
# --root-dir resolves links that start at the repository root, such as
# /docs/architecture/overview.md
lychee --offline --include-fragments --root-dir "$PWD" "**/*.md"

# Front matter of documents under docs/
node scripts/check-front-matter.mjs

# Mermaid diagrams render (downloads the Mermaid CLI through npx)
node scripts/check-mermaid.mjs
```

These checks guard everything else, so the scripts behind them are tested
too. Every script under `scripts/` has a `<name>.test.mjs` beside it, and
the tests run on every pull request. A new script comes with its tests, and
a change in behaviour comes with a test that fails without it. Run them
after changing anything under `scripts/`:

```sh
node --test scripts/*.test.mjs
```

GitHub shows an error box in place of a Mermaid diagram it cannot parse. In
a sequence diagram, a semicolon ends the statement and `#` starts an entity
code, so keep both out of message text.

A link to a document that is planned but not yet written is listed in
`.lycheeignore`; remove the line in the pull request that adds the file.

## Documentation conventions

Two kinds of document live under `docs/` and are treated differently:

- **Point-in-time records** are the history and the "why". Design specs live
  in `docs/specs/` and are named `YYYY-MM-DD-<topic>.md`. Once a spec is
  approved, only its status line changes; a later spec supersedes it.
- **Living documents** are the current truth, such as everything in
  `docs/architecture/`. They change in the same pull request as the thing
  they describe, and carry a `last-verified` date in their front matter.
  They describe the system, not the schedule: milestone labels (M1, M2)
  belong in specs, plans and the roadmap. A living document says "planned"
  for something that does not exist yet.

A link to a file in another folder starts at the repository root
(`/docs/adr/README.md`), not with `../`, so the reader sees where the file
lives. A link to a file in the same folder uses the bare file name.

Every document under `docs/` starts with front matter; the front-matter
check lists the fields each kind requires. A change to the architecture
needs a decision record (ADR) before it merges; the ADR process is being set
up and will be documented here.

## Licence

agent-caddie is released under the [MIT licence](LICENSE). By contributing,
you agree that your contribution is licensed under the same terms. A
Developer Certificate of Origin sign-off check is planned; signing off your
commits now (`git commit -s`) is welcome but not yet required.
