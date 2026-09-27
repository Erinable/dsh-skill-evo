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

When this flag is `yes`, list external PRs with `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`; retain only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` authors and drop `OWNER`, `MEMBER`, and `COLLABORATOR`. Read with `gh pr view <number> --comments` and `gh pr diff <number>`. Comment, label, or close with `gh pr comment`, `gh pr edit --add-label` / `--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with `gh pr view 42`, falling back to `gh issue view 42` when it is not a PR.

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

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map:** a GitHub issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog. Create it with `gh issue create --label wayfinder:map`.
- **Child ticket:** a linked sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues are unavailable, add the child to a task list and put `Part of #<map>` at the top. Labels are `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`; once claimed, assign it to the driving dev.
- **Blocking:** use GitHub native dependencies: `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. The blocker id is the numeric database id from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not the issue number or `node_id`. GitHub reports `issue_dependencies_summary.blocked_by` for open blockers. Where dependencies are unavailable, use `Blocked by: #<number>` in the child body.
- **Frontier:** list open map children, scoped to sub-issues or the task list, and drop any with `issue_dependencies_summary.blocked_by > 0`, an open `Blocked by` issue, or an assignee; take the first remaining ticket in map order.
- **Claim:** `gh issue edit <n> --add-assignee @me` is the first write.
- **Resolve:** post the answer with `gh issue comment <n> --body "<answer>"`, close it, and append a context pointer to the map.
