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

Post the question with `glab issue note <number> --message-file <file>` and wait for a reply in the issue thread. Interactive sessions can continue in place; one-shot runs have no tracker wakeup operation (`n/a`).

## Wayfinding operations

- **Map:** a GitLab issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket:** a child issue carrying `Part of #<map>` and a `wayfinder:*` label.
- **Blocking:** use native blocking links (`/blocked_by #<number>`); otherwise record `Blocked by: #<number>` in the child body.
- **Frontier:** list open map children, remove assigned or blocked tickets, and take the first remaining ticket in map order.
- **Resolve:** post the answer, close the issue, and append a context pointer to the map.
