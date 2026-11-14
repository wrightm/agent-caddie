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
4. Say in the description what changed, why, and how you checked it.
5. Make sure the checks pass and every review conversation is resolved.

## Review

The project has a single maintainer, [@wrightm](https://github.com/wrightm),
who reviews and merges every pull request. Automated reviewers may comment,
but their comments are advisory and never count as approval. When more
maintainers join, this section and a `CODEOWNERS` file will say who reviews
what.

## Checks

Three checks run on every pull request and must pass before merge. You can
run them locally from the repository root:

```sh
# Markdown style
npx markdownlint-cli2 "**/*.md"

# Relative links and heading anchors (needs lychee installed)
lychee --offline --include-fragments "**/*.md"

# Front matter of documents under docs/
node scripts/check-front-matter.mjs
```

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

Every document under `docs/` starts with front matter; the front-matter
check lists the fields each kind requires. A change to the architecture
needs a decision record (ADR) before it merges; the ADR process is being set
up and will be documented here.

## Licence

agent-caddie is released under the [MIT licence](LICENSE). By contributing,
you agree that your contribution is licensed under the same terms. A
Developer Certificate of Origin sign-off check is planned; signing off your
commits now (`git commit -s`) is welcome but not yet required.
