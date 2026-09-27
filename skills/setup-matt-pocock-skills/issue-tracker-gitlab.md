# Issue tracker: GitLab

Issues and specs for this repo live as GitLab issues. Use `glab` for all operations.

## Conventions

- Create, read, list, comment, assign, edit, and close issues with `glab issue`; use `glab issue view <number> --comments` and `-F json` for structured output.
- GitLab calls comments notes and pull requests merge requests: use `glab issue note` and `glab mr`.
- Use a file-backed description for multi-line issue and note text.

## Triage state

The five triage roles are GitLab labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Resolve labels with `glab label list`; create missing labels as needed, then add or remove them with `glab issue update --label` / `--unlabel`. An issue's open or closed state carries its lifecycle; `wontfix` is closed.

## Pull requests as a triage surface

**Merge requests as a request surface: no.** Merge requests are implementation artifacts, not feature requests for triage. If a repository enables this surface, use the corresponding `glab mr` commands and the same labels.

When this flag is `yes`, list external merge requests with `glab mr list -F json` and retain only requests whose author is not a project member or owner. Read with `glab mr view <number> --comments` and `glab mr diff <number>`. Comment, label, or close with `glab mr note`, `glab mr update --label` / `--unlabel`, and `glab mr close`.

GitLab numbers issues and merge requests separately, so `#42` is unambiguous once the surface is known. Use `glab mr` for merge requests and `glab issue` for issues.

## When a skill says "publish to the issue tracker"

Create a GitLab issue with `glab issue create --title "..." --description-file <file>`.

## When a skill says "fetch the relevant ticket"

Run `glab issue view <number> --comments`; use `-F json` when a structured record is needed.

## Deliver an artifact

GitLab notes do not provide a portable attachment contract. Commit repository artifacts and open a merge request, or put a short artifact inline in the issue or merge request description. A runtime-local path is not delivery.

## Concurrent writes

Assign an issue with `glab issue update <number> --assignee @me` before working. Assignment is the claim; notes are append-only, while issue body and label edits are owned by the assignee.

## Mentions

GitLab `@user` and `@group` mentions notify recipients in issue and merge request notes. Do not use a mention merely for attribution.

## Ask a person and wait

Post the question with `glab issue note <number> --message "$(cat <file>)"` and wait for a reply in the issue thread. Interactive sessions can continue in place; one-shot runs have no tracker wakeup operation (`n/a`).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map:** a GitLab issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog. Create it with `glab issue create --label wayfinder:map`. On GitLab tiers with native epics, an epic may be the map instead.
- **Child ticket:** a child issue carrying `Part of #<map>` and a `wayfinder:*` label; once claimed, assign it to the driving dev.
- **Blocking:** native blocking is available only on Premium/Ultimate: post `/blocked_by #<blocker>` as `glab issue note <child> --message "/blocked_by #<blocker>"`. On the free tier, record `Blocked by: #<number>` in the child body.
- **Frontier:** list open map children with `glab issue list -F json`, remove assigned or blocked tickets, and use `glab api projects/:id/issues/:iid/links` to inspect native blockers; take the first remaining ticket in map order.
- **Claim:** `glab issue update <n> --assignee @me` is the first write.
- **Resolve:** post the answer with `glab issue note <n> --message "<answer>"`, close it, and append a context pointer to the map.
