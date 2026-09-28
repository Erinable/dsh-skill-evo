# Issue tracker: Multica

Issues live in Multica. Use the `multica` CLI for all operations. Never reach for `curl` or `wget` against the Multica API; the CLI holds the credentials.

Issues are addressed by UUID (`<issue-uuid>`) and carry a human identifier (`ABC-10`). Commands take the UUID; prose and links should quote the identifier.

## Conventions

- Create an issue with `multica issue create --title "..." --description-file <path>`; optionally pass priority, status, assignee, parent, stage, project, due date, or attachment.
- Read with `multica issue get <id> --output json`; list with `multica issue list --output json`; search with `multica issue search <query> --output json`.
- Add comments with `multica issue comment add <issue-id> --content-file <path>` and use `--parent <comment-id>` for replies. Read comments with a roots summary followed by a bounded thread read.
- Change lifecycle with `multica issue status <id> <status>` and assign with `multica issue assign <id> --to <name>` or `--to-id <uuid>`. Multica has no close verb; use `done` or `cancelled`.

An issue title already renders as its H1; descriptions start with prose or `##`, never a Markdown `# ` heading.

### Long bodies always go through a file

Write long descriptions and comments to UTF-8 files inside the working directory, then pass `--description-file` or `--content-file`. Do not use inline `--content` or a heredoc alongside other flags: inline `--content` decodes escape sequences and mangles the body. Delete a temporary file only after a successful post, gated with `&&`; avoid `--allow-external-file`.

### Never merge stderr into parsed output

Keep stderr separate from `--output json`; otherwise a successful write can look like a parse failure and invite a duplicate retry.

## Triage state

Labels carry the triage role and lifecycle status carries the board state. The canonical mapping is `needs-triage` → `todo`, `needs-info` → `blocked`, `ready-for-agent` → `todo`, `ready-for-human` → `todo`, and `wontfix` → `cancelled`. Apply both axes and remove the previous role label when changing roles. Resolve a label by name with `multica label list --output json`; create it with `multica label create`, then use `multica issue label add` or `remove`. Label add/remove takes a label UUID, not a label name. An agent that finishes work sets `in_review`; `done` follows PR merge, including Reviewer auto-merges for eligible documentation PRs.

## Pull requests as a triage surface

**PRs as a request surface: no.** Multica attaches pull requests to issues with `multica issue pull-requests <id>`; it does not track PRs as independent triage requests.

## When a skill says "publish to the issue tracker"

Create a Multica issue by writing the body to a file and running `multica issue create --title "..." --description-file <path>`.

## When a skill says "fetch the relevant ticket"

Run `multica issue get <id> --output json`, then scan comments with `multica issue comment list <id> --roots-only --summary --compact --output json` and expand only relevant threads with `--thread <comment-id> --tail 30 --compact`.

## Deliver an artifact

When a file must reach a reader, use the first matching delivery:

1. A repository artifact belongs in the repo: commit it and open a PR.
2. A one-off artifact can be attached to the issue comment: `multica issue comment add <issue-id> --content-file ./reply.md --attachment ./report.html` (repeat `--attachment` as needed; zip several files first).
3. A short artifact can be included inline in the comment body.
4. In a chat task, upload with `multica attachment upload ./report.html` and include the returned snippet.

The attachment path must be inside the working directory. Do not write an absolute path or `file://` URL as a link or embedded image; when a surface has no attachment mechanism, say so in words. A runtime-local path is not delivery.

## Concurrent writes

Multica has no locking and `multica issue update` replaces fields wholesale. Assignment is the claim: assign the issue and set it `in_progress` as the first writes of the run. Comments are append-only and safe from any run; before rewriting a description, immediately re-read the current body and write the complete body back. Parent issue lifecycle is owned by its owner; a child run never changes the parent issue's status, including `done`. An agent finishes its own issue at `in_review`; `done` is a human decision.

## Mentions

`mention://issue/<issue-id>` and `mention://project/<project-id>` are links. `mention://member/<user-id>` notifies a human and `mention://agent/<agent-id>` starts an agent run; use an agent mention only when handing over concrete work.

## Ask a person and wait

This operation is for `irreversible / permission / spending` decisions only. A `business judgment` caller records `采用默认答案，成员可推翻` and continues without registering a wait.

1. Write one question body to a UTF-8 file inside the working directory. Include these exact lines so patrol can find and resume it: `提问目标 user_id: <target-user-id>`, `提问类别: irreversible / permission / spending`, `默认答案: <answer>`, `提问时间: <RFC3339>`, and `resume status: <todo|in_progress>`. Publish it with `multica issue comment add <issue> --content-file <body-file>`; if replying to a thread, pass the triggering `thread` as `--parent <thread>`.
2. Resolve the request initiator in this order: a valid `需求提出人 user_id: <member-user-id>` line in the issue description (inherited from the parent for child issues); if the line explicitly says `unresolved`, use the Decision maker immediately; otherwise use the triggering comment's `author_id` when `author_type == member`, then `creator_id` only when `creator_type == member`, and finally the decision maker from `docs/agents/instance.md`. An unresolved parent is an explicit fallback and a comment on a child never overrides a recorded parent initiator.
3. Choose exactly one target for protected decisions. Business judgment is resolved by recording `采用默认答案，成员可推翻` and continuing; irreversible decisions, permissions, or spending ask the Decision maker. When the initiator is the Decision maker, that person is the target for protected decisions. Resolve the target through `multica workspace member list --output json` and use its `user_id`; never use a membership id or an agent id. The `creator_type == member` fallback is the limited, explicit exception to ADR-0012's old prohibition on `creator_id`.
4. Read the issue assignee. If the issue is assigned to this agent, register no wakeup: a reply from the target member wakes that assignee directly.
5. Otherwise register exactly one one-shot event wakeup filtered to the target member: `multica issue wakeup create <issue> --kind event --event comment.created --mode once --filter-actor-type member --filter-actor-id <target-user-id>`. Pass the triggering `thread` as wakeup `--parent <thread>` and the continuation as `--instruction <next>`.
6. Only the target member's reply answers the question. With a registered wakeup, other member replies do not wake this wait; the target filter is intentional so an unrelated reply cannot settle a decision. If the issue is assigned to this agent and the tracker directly wakes it for any comment, discard non-target replies as context and keep the question open.
7. For a patrol transfer, disable the wakeup whose `parent` is the original question thread and whose actor filter names the old target. If the issue is assigned to the original asking agent, direct member replies wake that agent and no replacement is needed. Otherwise register one replacement with the same `parent` and `next`, the new target's `user_id`, and `--agent-id <original-asking-agent-id>`; reuse an already matching wakeup and do not post a duplicate question. A reply from the replaced target after transfer is context only.
8. End the run after publishing and, when required, registering the wakeup. Do not poll or sleep. On the next run, read the target's reply and follow the `next` instruction. If no reply arrives, the fixed-marker `2 / 4 / 7 day` state machine in `delivery-contract` and `orchestrate/PATROL.md` applies. A business judgment must never enter this wait state.

## Wayfinding operations

- **Map:** one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog; keep it `in_progress` while live.
- **Child ticket:** create with `multica issue create --parent <map-id> --title "..." --description-file <path> --stage N`; use `backlog` until its stage opens and assign it to the driving agent.
- **Blocking:** use stage barriers; for cross-stage dependencies record `Blocked by: ABC-<n>` and treat it as satisfied only when the blocker is `done` or `cancelled`.
- **Frontier:** read `multica issue children <map-id> --output json`, choose the first unfinished, promoted, unassigned child in stage order, dropping `backlog`, `blocked`, and children with unsatisfied `Blocked by:` entries.
- **Research routing:** assign research tickets according to `docs/agents/instance.md`'s `Agent routing`; the map owner does not dispatch a second research subagent.
- **Resolve:** research and prototype children are delivered as PRs; `wayfinder:grilling` records its recommended answers with `采用默认答案，成员可推翻`, sets that ticket `done` in the same run, and continues the map; task children are set `done` after their PR merges. A ticket left `in_review` never closes its stage, so later stages remain locked.
- Before appending a context pointer, run `multica issue get <map-id> --output json`, append to the existing description, and write the complete body with `multica issue update <map-id> --description-file <path>`; update replaces the description wholesale.
