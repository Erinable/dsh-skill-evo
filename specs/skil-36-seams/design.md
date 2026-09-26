## Context and Decisions

This spec implements the merged design in `docs/design/skil-36-seams.md`. The design identifies three seams whose rules were copied into unrelated skills:

- **Tracker seam**: the four `issue-tracker-*.md` adapters.
- **Runtime seam**: one-shot versus interactive execution, fan-out convergence, and file delivery.
- **Instance seam**: this repository's member, subscriber, label, and routing facts.

The confirmed decisions are D-1 through D-6 in the design: the exact ten tracker section names; `docs/agents/instance.md` as the repository-only instance file; the dependency direction; owner/member wakeup resolution; repository checkout as a prerequisite for docs; and `runtime.md` as a setup template plus installed copy.

## Architecture

The authority graph is:

```text
consumer skill --> docs/agents/runtime.md --> issue-tracker adapter
       |
       +----------> docs/agents/instance.md
```

`skills/setup-matt-pocock-skills/issue-tracker-*.md` are the adapter templates. The Multica template is copied byte-for-byte to `docs/agents/issue-tracker.md`; GitHub, GitLab, and local adapters implement the same section contract with `n/a` where their tracker cannot support an operation. `docs/agents/instance.md` is never templated.

The runtime template is `skills/setup-matt-pocock-skills/runtime.md`; setup installs it as `docs/agents/runtime.md`. Consumer skills cite the runtime section names and retain only their own consequences. The tracker adapter owns tracker mechanics, including Multica wakeups and artifact attachment mechanics. Runtime owns the decision of whether a path is a deliverable.

## Ask-and-wait Data Flow

1. A caller supplies the issue id, a file-backed question body, and optional reply thread and next-run instruction to the adapter section.
2. The adapter posts the body with `multica issue comment add --content-file`, adding `--parent` when a thread is supplied.
3. The adapter reads the issue assignee. If it is the current agent, it registers no wakeup because direct member comments already wake that assignee.
4. Otherwise it resolves a member user id from the triggering member comment, or from the workspace owner returned by `multica workspace member list --output json`. It uses `user_id`, not membership `id`, and never issue creator/assignee fields.
5. It registers exactly one `comment.created`, `mode once` wakeup filtered to that member, passes the optional parent/instruction, and ends the run. It never polls.

The non-Multica adapters document the same operation as an interactive in-session wait and `n/a` for one-shot asynchronous recall.

The existing Mika asking references are in `skills/orchestrate/SKILL.md:6`, `:41`, and `:60`, so the first repository task changes them. Mika's agent instructions are empty and its installed skills do not include `delivery-contract`. Triager's asking reference is in agent configuration outside the repository and is synchronized when Task 1 merges.

## Instance Data Flow

`instance.md` holds four sections: the decision-maker rule and query source; subscriber policy; a label snapshot marked as potentially stale; and local agent routing. The adapter retains generic name-based label resolution and creation. The orchestrate entry point moves parent subscription into the first repository-backed run so the chat-only entry point does not need instance docs.

## Runtime Data Flow

`runtime.md` is the only source for mode classification. `MULTICA_TASK_ID` is documented as the task/run id and is removed from the tracker adapter prose. In one-shot mode, a runtime-local path is not delivery; the caller follows the adapter's `Deliver an artifact` mechanism. In interactive mode, the path can be reported to the co-located user. Subagent work is dispatched in parallel where useful and collected before the turn ends; work that cannot fit becomes a later issue or wakeup. The `wayfinder` fan-out reference moves to this runtime section with the other consumers.

## Error Handling and Invariants

- Missing `docs/agents/*` is handled by the existing repository convention: ask the user to run `/setup-matt-pocock-skills`; consumer skills do not invent another mode rule.
- A missing label is created by name; a stale instance snapshot is not treated as authoritative.
- A wakeup must use a member `user_id`; using membership ids or agent ids is invalid and must be detectable in review.
- A self-assigned ask does not create a duplicate wakeup. A non-self ask creates one one-shot wakeup and then exits.
- A caller must use a file-backed comment body. No caller may reintroduce a direct wakeup command or duplicate `MULTICA_TASK_ID` logic.
- Tracker adapters must not depend on a repository skill step or agent identity. The only repository-specific routing belongs in `instance.md`, where agent names are instance facts. Routing there must not make adapter behavior depend on a skill's step number.

## Verification Strategy

Verification is intentionally mechanical because the change is documentation seam work:

- `grep` proves wakeup commands, creator/assignee misuse, `MULTICA_TASK_ID` consumers, and leaked tracker commands have one allowed location.
- `diff` proves byte identity for the Multica tracker, runtime, and triage-label template/installed-copy pairs. `docs/agents/domain.md` is intentionally filled with repository layout and is not expected to match its template.
- `grep '^## '` proves all four adapters implement the same ordered ten-section interface.
- A manual review checks the section contents, the four `instance.md` sections, exact runtime semantics, Mika's in-repository asking references, and Triager's three staged instruction changes: ask after Task 1, label lookup after Task 2, and label-section rename after Task 3b.
- No package build or runtime test is required because no executable package code changes.

## Assumptions and Non-goals

The repository is checked out for every run that reads `docs/agents/*`, as accepted by D-5. Existing copies installed in other repositories are not migrated. The work does not change the tracker service, Node packages, or any scan-report items outside design sections 2, 6, and 7.
