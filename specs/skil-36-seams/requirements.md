## Requirements

This specification turns `docs/design/skil-36-seams.md` into independently verifiable requirements. The confirmed decisions D-1 through D-6 are normative; no additional product decision is open.

### R-1 Ask-and-wait has one tracker-owned authority

WHEN a skill needs to ask a person and resume from a reply THE SYSTEM SHALL use the selected tracker adapter's `## Ask a person and wait` section as the operation definition, and no caller skill SHALL duplicate the tracker mechanism.

### R-2 Ask-and-wait resolves a member recipient safely

WHEN the triggering comment author has `author_type == member` THE SYSTEM SHALL use that author's `author_id` as the wakeup actor id; OTHERWISE THE SYSTEM SHALL query workspace members and use the `user_id` of the member whose role is `owner`, and SHALL NOT use an issue's `creator_id` or `assignee_id` as a member id.

### R-3 Ask-and-wait preserves its interface and run boundary

WHEN the Multica adapter receives `issue`, `body`, optional `thread`, and optional `next` inputs THE SYSTEM SHALL publish `body` with `--content-file`, pass `thread` as `--parent` when present, skip wakeup registration when the issue is assigned to the current agent, otherwise register one `comment.created` wakeup in `mode once` filtered to the resolved member `user_id`, pass `thread` and `next` as wakeup parent/instruction when present, and end the run without polling.

### R-4 Non-Multica adapters declare their async boundary

WHEN the GitHub, GitLab, or local adapter is used THE SYSTEM SHALL provide the same `## Ask a person and wait` section, stating that interactive sessions may ask and wait in-session and one-shot runs have no asynchronous recall mechanism (`n/a`).

### R-5 Instance facts have a repository-only authority

WHEN repository-specific member, subscriber, label snapshot, or agent-routing facts are needed THE SYSTEM SHALL read `docs/agents/instance.md`, whose interface SHALL contain `## Decision maker`, `## Subscribers`, `## Labels in this workspace`, and `## Agent routing`; generic tracker templates SHALL contain no repository-specific facts.

### R-6 Tracker template and installed copy cannot drift

WHEN the Multica tracker configuration is changed THE SYSTEM SHALL keep `skills/setup-matt-pocock-skills/issue-tracker-multica.md` and `docs/agents/issue-tracker.md` byte-for-byte identical, while `docs/agents/instance.md` remains repository-only and is not a setup template.

### R-7 Label rules are generic and snapshots are explicitly staleable

WHEN a triage label is resolved THE SYSTEM SHALL resolve it by name, create it when absent, and avoid hard-coded UUIDs; `docs/agents/instance.md` SHALL describe current labels only as a snapshot whose authoritative source is the adapter's label query, and `docs/agents/triage-labels.md` SHALL not contain a second Multica-specific rule.

### R-8 Runtime mode is defined once

WHEN a skill needs to distinguish an interactive session from a one-shot run THE SYSTEM SHALL follow `runtime.md`'s `## Which mode am I in` section: an available `MULTICA_TASK_ID` (or the runtime brief's terminal-on-exit condition) means one-shot, otherwise interactive; the documentation SHALL identify `MULTICA_TASK_ID` as a task/run id, not an issue id.

### R-9 Runtime delivery and fan-out rules are centralized

WHEN a skill dispatches subagents or produces a file THE SYSTEM SHALL follow `runtime.md`'s `## Subagents: fan out, converge before the turn ends` and `## Delivering a file` sections: collect dispatched results before the turn ends, do not background-and-yield or poll/sleep, and deliver one-shot files through the tracker adapter's artifact mechanism rather than a runtime-local path.

### R-10 Every tracker adapter implements the same ten-section interface

WHEN any tracker adapter is consumed THE SYSTEM SHALL expose these `##` sections in this exact order: `Conventions`; `Triage state`; `Pull requests as a triage surface`; `When a skill says "publish to the issue tracker"`; `When a skill says "fetch the relevant ticket"`; `Deliver an artifact`; `Concurrent writes`; `Mentions`; `Ask a person and wait`; `Wayfinding operations`. An unsupported operation SHALL be marked `n/a` with its reason.

### R-11 Consumers reference seams by section name

WHEN a skill needs runtime, tracker, or instance behavior THE SYSTEM SHALL reference the corresponding document section by name, SHALL not repeat `MULTICA_TASK_ID` mode logic or tracker commands in consumer skills, and SHALL preserve the dependency direction `skill -> runtime -> tracker` plus `skill -> instance`; tracker and instance documents SHALL not name skill steps or agents.

### R-12 Setup installs the runtime seam

WHEN setup scaffolds the repository THE SYSTEM SHALL copy `skills/setup-matt-pocock-skills/runtime.md` to `docs/agents/runtime.md` and include `runtime.md` in its file list; all setup-installed `docs/agents/*` files with templates SHALL remain identical except for repository-only `instance.md`.

### R-13 Agent-instruction consumers are synchronized outside this repository

WHEN these repository changes are adopted THE SYSTEM SHALL also update the Triager agent instruction to point label lookup at the tracker adapter's `Triage state` section and update Mika's `orchestrate` instruction to point ask-and-wait at the tracker adapter's `Ask a person and wait` section; these instruction files are outside this repository and are coordination deliverables, not repository edits.

### Scope boundary

The implementation is documentation and instruction wiring only. It does not alter the Node packages, issue-tracker service, setup behavior beyond the documented file list/content, or already-installed copies in other repositories.
