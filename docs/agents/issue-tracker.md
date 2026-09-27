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

Labels carry the triage role and lifecycle status carries the board state. The canonical mapping is `needs-triage` → `todo`, `needs-info` → `blocked`, `ready-for-agent` → `todo`, `ready-for-human` → `todo`, and `wontfix` → `cancelled`. Apply both axes and remove the previous role label when changing roles. Resolve a label by name with `multica label list --output json`; create it with `multica label create`, then use `multica issue label add` or `remove`. Label add/remove takes a label UUID, not a label name. An agent that finishes work sets `in_review`; `done` is a human decision.

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

1. Write one question body to a UTF-8 file inside the working directory. It must name the target, classify the question (`business judgment` or `irreversible / permission / spending`), state the default answer, and record the ask timestamp. Publish it with `multica issue comment add <issue> --content-file <body-file>`; if replying to a thread, pass the triggering `thread` as `--parent <thread>`.
2. Resolve the request initiator: use the chat initiator for a chat-created request, or the triggering comment's `author_id` when `author_type == member`. If no member initiator is available, use the decision maker from `docs/agents/instance.md`.
3. Choose exactly one target. Ask the request initiator for business judgment. Ask the decision maker for irreversible decisions, permissions, or spending. When the initiator is the decision maker, that person is the target for both classes. Resolve the target through `multica workspace member list --output json` and use its `user_id`; never use a membership id, agent id, `creator_id`, or `assignee_id`.
4. Read the issue assignee. If the issue is assigned to this agent, register no wakeup: a reply from the target member wakes that assignee directly.
5. Otherwise register exactly one one-shot event wakeup filtered to the target member: `multica issue wakeup create <issue> --kind event --event comment.created --mode once --filter-actor-type member --filter-actor-id <target-user-id>`. Pass the triggering `thread` as wakeup `--parent <thread>` and the continuation as `--instruction <next>`.
6. Only the target member's reply answers the question. With a registered wakeup, other member replies do not wake this wait; the target filter is intentional so an unrelated reply cannot settle a decision. If the issue is assigned to this agent and the tracker directly wakes it for any comment, discard non-target replies as context and keep the question open.
7. End the run after publishing and, when required, registering the wakeup. Do not poll or sleep. On the next run, read the target's reply and follow the `next` instruction. If no reply arrives, the `2 / 4 / 7 day` escalation in `delivery-contract` and `orchestrate/PATROL.md` applies.

## Wayfinding operations

- **Map:** one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog; keep it `in_progress` while live.
- **Child ticket:** create with `multica issue create --parent <map-id> --title "..." --description-file <path> --stage N`; use `backlog` until its stage opens and assign it to the driving agent.
- **Blocking:** use stage barriers; for cross-stage dependencies record `Blocked by: ABC-<n>` and treat it as satisfied only when the blocker is `done` or `cancelled`.
- **Frontier:** read `multica issue children <map-id> --output json`, choose the first unfinished, promoted, unassigned child in stage order, dropping `backlog`, `blocked`, and children with unsatisfied `Blocked by:` entries.
- **Research routing:** assign research tickets according to `docs/agents/instance.md`'s `Agent routing`; the map owner does not dispatch a second research subagent.
- **Resolve:** research and prototype children are delivered as PRs; grilling is resolved by the member's acceptance, then the map owner posts the resolution and sets that ticket `done`; task children are set `done` by their implementer. A ticket left `in_review` never closes its stage, so later stages remain locked.
- Before appending a context pointer, run `multica issue get <map-id> --output json`, append to the existing description, and write the complete body with `multica issue update <map-id> --description-file <path>`; update replaces the description wholesale.
