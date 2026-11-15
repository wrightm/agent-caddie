# Instructions for coding agents

These instructions apply to any coding agent working in this repository.
[CONTRIBUTING.md](CONTRIBUTING.md) is the full contributor guide; this page
is the part an agent must do without being asked, so that no human has to
tidy up afterwards.

## Before starting work

1. Find the issue the work belongs to:
   `gh issue list --state open --search "<topic>"`. Large pieces of work
   have a tracking issue with a task list.
2. If no issue fits, say so and propose one. Do not open a pull request
   that belongs to no issue.
3. Branch from an up-to-date `main`, named `<type>/<short-topic>`. Never
   commit to `main`; direct pushes are blocked.
4. Mark the issue as started: `scripts/board.sh <issue-number> "In Progress"`.

## Opening a pull request

1. Give it a Conventional Commits title. It becomes the commit on `main`.
2. Name the issue in the description, on a line of its own:
   - `Part of #N` when the issue stays open after this pull request;
   - `Closes #N` only when this pull request finishes the issue.

   The `linked issue` check fails without one of these.
3. Run the checks listed under "Checks" in
   [CONTRIBUTING.md](CONTRIBUTING.md#checks) and fix what they report
   before pushing.
4. Put the pull request on the board:
   `scripts/board.sh <pr-number> "In Progress"`.
5. Do not merge. The maintainer reviews and merges every pull request.

## After a merge

If the session is still running when the pull request merges:

1. Tick the deliverable it completed in the tracking issue's task list.
2. If the issue is still open and nothing else is in flight for it, leave
   its board status alone. The board moves merged pull requests and closed
   issues to Done by itself.

## If the board script fails

`scripts/board.sh` needs the `gh` CLI with the `project` scope and write
access to the board. If it fails for lack of access, carry on and say so in
your final message. Do not ask the user to change their credentials.
