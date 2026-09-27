# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create, read, list, comment, assign, edit, and close issues with `gh issue`; use `gh issue view <number> --comments` and include labels when reading.
- Pull requests use `gh pr`; infer the repository from `git remote -v`.
- Use a heredoc or file-backed body for multi-line issue and comment text.

## Triage state

The five triage roles are GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Resolve existing labels with `gh label list`; create missing labels with `gh label create`, then add or remove them with `gh issue edit --add-label` / `--remove-label`. The issue lifecycle is represented by GitHub open or closed state; `wontfix` is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.** PRs are implementation artifacts, not feature requests for triage. If a repository enables this surface, use the corresponding `gh pr` commands and the same labels.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `gh issue create --title "..." --body-file <file>` (or an inline body for short text).

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`; include labels and fetch the PR when the ticket points at one.

## Deliver an artifact

GitHub issue comments do not provide a general attachment mechanism. Commit repository artifacts and open a PR, or put a short artifact inline in the issue or PR body. A runtime-local path is not delivery.

## Concurrent writes

Assign an issue with `gh issue edit <number> --add-assignee @me` before working. Assignment is the claim; comments are append-only, while edits to the issue body and labels are owned by the assignee.

## Mentions

GitHub `@user` and `@team` mentions notify recipients in issue and PR comments. Do not use a mention merely for attribution.

## Ask a person and wait

Post the question with `gh issue comment <number> --body-file <file>` and wait for a reply in the issue or its thread. Interactive sessions can continue in place; one-shot runs have no tracker wakeup operation (`n/a`).

## Wayfinding operations

- **Map:** a GitHub issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket:** a linked sub-issue (or a task-list entry when sub-issues are unavailable), labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking:** use GitHub native issue dependencies; otherwise record `Blocked by: #<number>` in the child body.
- **Frontier:** list open map children, remove assigned or blocked tickets, and take the first remaining ticket in map order.
- **Resolve:** post the answer, close the issue, and append a context pointer to the map.
