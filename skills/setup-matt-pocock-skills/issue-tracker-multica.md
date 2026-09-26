# Issue tracker: Multica

Issues and specs for this repo live as Multica issues. Use the `multica` CLI for all operations. Never reach for `curl`/`wget` against the Multica API — the CLI holds the credentials.

Issues are addressed by UUID (`01a0da17-0747-72e1-a7f6-c700d948fca8`) and carry a human identifier (`SKIL-10`). Commands take the UUID; prose and links should quote the identifier. When running inside a Multica agent task, `MULTICA_TASK_ID` holds the current issue's UUID.

## Conventions

- **Create an issue**: `multica issue create --title "..." --description-file <path>`. Optional: `--priority`, `--status`, `--assignee`/`--assignee-id`, `--parent <issue-id>`, `--stage N`, `--project <id>`, `--due-date YYYY-MM-DD`, `--attachment <path>`.
- **Read an issue**: `multica issue get <id> --output json`.
- **List issues**: `multica issue list --output json` with `--status`, `--assignee`, `--project`, `--priority`, `--limit`/`--offset`. Add `--fields id,identifier,title,status,labels` to keep the payload small.
- **Search**: `multica issue search <query> --output json` matches title, description, and comments.
- **Comment on an issue**: `multica issue comment add <issue-id> --content-file <path>`, plus `--parent <comment-id>` to reply in a thread.
- **Read comments**: `multica issue comment list <issue-id> --roots-only --summary --compact --output json` to scan threads, then `--thread <comment-id> --tail 30 --compact` to expand one. Never bulk-pull a whole history.
- **Change status**: `multica issue status <id> <status>`.
- **Assign**: `multica issue assign <id> (--to <name> | --to-id <uuid> | --unassign)`. Assigning to an agent can start a run.
- **Sub-issues**: `multica issue children <id> --output json` lists children grouped by stage.
- **Close**: Multica has no close verb. Set the terminal status instead — `multica issue status <id> done` (or `cancelled` for wontfix) — and post the outcome as a comment first.

### Long bodies always go through a file

Write the body to a UTF-8 file with your file-write tool, then pass `--description-file` / `--content-file`. Do not use a heredoc on stdin: it can swallow trailing flags (Multica #4182). Do not use inline `--content` for anything an agent authored — it decodes `\n`, `\r`, `\t`, `\\` and mangles the body (MUL-2904).

The path must sit inside the current working directory. Writing to `/tmp` or another shared path is rejected unless you pass `--allow-external-file`, and that flag exists to be avoided: a stale file from another run is exactly what it lets in (MUL-4252). Delete the temp file only after the post succeeds, gated on the exit status (`&&`), never unconditionally.

### Never merge stderr into parsed output

`--output json` writes JSON to stdout; confirmations, warnings, and hints go to stderr. `2>&1` mixes them, so a write that **succeeded** parses as malformed and invites a duplicate retry. Keep the streams separate — redirect stderr away (`2>/dev/null`) or leave it alone.

## Labels

Multica labels are workspace-scoped objects, not free strings. `multica issue label add` takes a **label UUID**, not a name, so a label has to exist before it can be applied:

```
multica label list --output json                                  # find an existing label's id
multica label create --name needs-triage --color '#f59e0b' --output json   # create it once, workspace-wide
multica issue label add <issue-id> <label-id>
multica issue label remove <issue-id> <label-id>
multica issue label list <issue-id> --output json
```

Create each label once per workspace and reuse its id. On a fresh workspace `multica label list` returns `[]`, so a skill that applies triage labels must create them on first use rather than assuming they exist.

## Status vs. label: two orthogonal axes

Multica's `status` is a lifecycle enum owned by the board: `todo`, `in_progress`, `in_review`, `done`, `blocked`, `backlog`, `cancelled`. The `triage` skill's five state roles describe *why* an issue is parked, which the lifecycle enum cannot express — `needs-info` and `ready-for-agent` are both "not started" to the board but opposite instructions to a reader.

So: **labels carry the triage role, status carries the lifecycle.** Apply both. This mapping is fixed for this repo:

| triage role       | Multica status | label             |
| ----------------- | -------------- | ----------------- |
| `needs-triage`    | `todo`         | `needs-triage`    |
| `needs-info`      | `blocked`      | `needs-info`      |
| `ready-for-agent` | `todo`         | `ready-for-agent` |
| `ready-for-human` | `todo`         | `ready-for-human` |
| `wontfix`         | `cancelled`    | `wontfix`         |

Setting a triage role means two calls: `multica issue status <id> <status>` and `multica issue label add <id> <label-id>`. Remove the previous role's label when moving between roles, or an issue accumulates contradictory labels.

`done` is a human decision. An agent that finished the work sets `in_review` and lets a person accept it.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Multica tracks PRs as links on an issue, not as independent request objects; `multica issue pull-requests <id>` lists them. There is no PR-as-ticket surface to triage, so this flag stays off.)_

## When a skill says "publish to the issue tracker"

Create a Multica issue: write the body to a file, then `multica issue create --title "..." --description-file <path>`.

An issue title already renders as its H1 — start the description with prose or `##`, never a Markdown `# ` heading.

## When a skill says "fetch the relevant ticket"

`multica issue get <id> --output json`, then catch up on the discussion with the two-step comment read above. The issue body alone is usually not the whole instruction; earlier comments often carry the constraints.

## Mentions are side-effecting

Inside an issue body or comment, these link forms **act**, they do not merely render:

- `[SKIL-10](mention://issue/<issue-id>)` — link, no side effect
- `[Project](mention://project/<project-id>)` — link, no side effect
- `[@Name](mention://member/<user-id>)` — notifies a human
- `[@Name](mention://agent/<agent-id>)` — enqueues a new run for that agent

Use an agent mention only to hand over concrete new work. Crediting someone, or thanking them, is prose — write the name as plain text. A courtesy mention bills a run whose only possible reply is another courtesy.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create the label once (`multica label create --name wayfinder:map --color '#8b5cf6'`), then `multica issue label add <map-id> <label-id>`. Keep the map's own status at `in_progress` while the effort is live.
- **Child ticket**: `multica issue create --parent <map-id> --title "..." --description-file <path> --stage N`. The ticket type goes on as a label — `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` — created once per workspace like any other label. Once claimed, assign the ticket to the driving dev.
- **Blocking**: Multica has no dependency edge. Express a blocker with the `--stage N` barrier — every ticket in stage N runs only after stage N-1 finishes, and the parent's assignee is woken when a stage completes. Create a blocked ticket with `--status backlog` so it does not start early; the map owner promotes it to `todo` when its stage opens. For a dependency that cuts across stages, add a `Blocked by: SKIL-<n>` line at the top of the child body and treat it as satisfied when that issue reaches `done` or `cancelled`.
- **Frontier query**: `multica issue children <map-id> --output json` returns children grouped by stage. Read the lowest stage that still has unfinished work, drop anything in `backlog` (not yet promoted), `blocked`, or already assigned, and drop any ticket whose `Blocked by:` issues are not terminal. First in stage order, then in board order, wins.
- **Claim**: `multica issue assign <id> --to <dev>` followed by `multica issue status <id> in_progress` — the session's first writes.
- **Resolve**: post the answer with `multica issue comment add <id> --content-file <path>`, set `multica issue status <id> in_review` (an agent) or `done` (a human accepting it), then append a context pointer to the map's Decisions-so-far by rewriting the map body via `multica issue update <map-id> --description-file <path>`.

`multica issue update` replaces the description wholesale — read the current body with `multica issue get` first, append to it, and write the whole thing back, or you will drop the rest of the map.
