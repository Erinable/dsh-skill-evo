# Issue tracker: Multica

Issues live in Multica. Use the `multica` CLI for all operations. Never reach for `curl` or `wget` against the Multica API; the CLI holds the credentials.

Issues are addressed by UUID (`<issue-uuid>`) and carry a human identifier (`ABC-10`). Commands take the UUID; prose and links should quote the identifier.

## Conventions

- Create an issue with `multica issue create --title "..." --description-file <path>`; optionally pass priority, status, assignee, parent, stage, project, due date, or attachment.
- Read with `multica issue get <id> --output json`; list with `multica issue list --output json`; search with `multica issue search <query> --output json`.
- Add comments with `multica issue comment add <issue-id> --content-file <path>` and use `--parent <comment-id>` for replies. Read comments with a roots summary followed by a bounded thread read.
- Change lifecycle with `multica issue status <id> <status>` and assign with `multica issue assign <id> --to <name>` or `--to-id <uuid>`. Multica has no close verb; use `done` or `cancelled`.

### Long bodies always go through a file

Write long descriptions and comments to UTF-8 files inside the working directory, then pass `--description-file` or `--content-file`. Do not use inline `--content` or a heredoc alongside other flags.

### Never merge stderr into parsed output

Keep stderr separate from `--output json`; otherwise a successful write can look like a parse failure and invite a duplicate retry.

## Triage state

Labels carry the triage role and lifecycle status carries the board state. The canonical mapping is `needs-triage` → `todo`, `needs-info` → `blocked`, `ready-for-agent` → `todo`, `ready-for-human` → `todo`, and `wontfix` → `cancelled`. Apply both axes and remove the previous role label when changing roles. Resolve a label by name with `multica label list --output json`; create it with `multica label create`, then use `multica issue label add` or `remove`. An agent that finishes work sets `in_review`; `done` is a human decision.

## Pull requests as a triage surface

**PRs as a request surface: no.** Multica attaches pull requests to issues with `multica issue pull-requests <id>`; it does not track PRs as independent triage requests.

## When a skill says "publish to the issue tracker"

Create a Multica issue by writing the body to a file and running `multica issue create --title "..." --description-file <path>`.

## When a skill says "fetch the relevant ticket"

Run `multica issue get <id> --output json`, then scan comments with `multica issue comment list <id> --roots-only --summary --compact --output json` and expand only relevant threads with `--thread <comment-id> --tail 30 --compact`.

## Deliver an artifact

When a file must reach a reader, use the first matching delivery:

1. A repository artifact belongs in the repo: commit it and open a PR.
2. A one-off artifact can be attached to the issue comment: `multica issue comment add <issue-id> --content-file ./reply.md --attachment ./report.html` (repeat `--attachment` as needed).
3. A short artifact can be included inline in the comment body.

The attachment path must be inside the working directory. A runtime-local path is not delivery.

## Concurrent writes

Assignment is the claim: assign the issue before changing it. Comments are append-only and safe from any run; issue descriptions and fields are owned by the assignee, and parent issue lifecycle is owned by its owner. A child reports upward by comment rather than changing the parent.

## Mentions

`mention://issue/<issue-id>` and `mention://project/<project-id>` are links. `mention://member/<user-id>` notifies a human and `mention://agent/<agent-id>` starts an agent run; use an agent mention only when handing over concrete work.

## Ask a person and wait

Write the question to a file and publish it with `multica issue comment add <issue> --content-file <body-file>`, preserving `--parent <thread>` when replying. If the issue is assigned to this agent, a member reply wakes it directly. Otherwise register one event wakeup for the workspace member's `user_id` with `multica issue wakeup create <issue> --kind event --event comment.created --mode once --filter-actor-type member --filter-actor-id <member-user-id>`. Resume by reading the reply and following the supplied next instruction.

## Wayfinding operations

- **Map:** one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog; keep it `in_progress` while live.
- **Child ticket:** create with `multica issue create --parent <map-id> --title "..." --description-file <path> --stage N`; use `backlog` until its stage opens and assign it to the driving agent.
- **Blocking:** use stage barriers; for cross-stage dependencies record `Blocked by: ABC-<n>` and wait for a terminal blocker.
- **Frontier:** read `multica issue children <map-id> --output json`, choose the first unfinished, promoted, unassigned, unblocked child in stage order.
- **Resolve:** research and prototype children are delivered as PRs; grilling is resolved by the member's acceptance; task children are set `done` by their implementer. Append a context pointer to the map description.
