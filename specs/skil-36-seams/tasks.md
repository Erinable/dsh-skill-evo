## Serial Delivery

These tasks are four Builder-sized units and MUST run in this order. A later task is blocked until the previous task's acceptance checks pass and its changes are merged. The first task is the end-to-end tracer bullet: one real ask-and-wait flow works through the tracker seam while the two caller skills become consumers of it.

### Task 1 — 2: Make ask-and-wait tracker-owned

**Depends on:** none.  
**Requirements:** R-1, R-2, R-3, R-4.

**Files and interface:**

- Add `## Ask a person and wait` to `skills/setup-matt-pocock-skills/issue-tracker-multica.md` and keep `docs/agents/issue-tracker.md` byte-identical. Define inputs `issue`, `body`, optional `thread`, and optional `next`; define file-backed comment publication, self-assignee behavior, member resolution, one-shot wakeup registration, parent/instruction forwarding, and no polling.
- Add the same section to `issue-tracker-github.md`, `issue-tracker-gitlab.md`, and `issue-tracker-local.md`, with the interactive/one-shot `n/a` behavior from the design.
- Reduce `skills/delivery-contract/SKILL.md` to caller policy and a reference to the adapter section; remove its hard-coded member id and direct wakeup mechanism.
- Reduce `skills/grilling/SKILL.md` issue-async step 2 to the adapter reference, passing its triggering thread and next instruction; remove its direct wakeup mechanism and issue-field member lookup.

**Acceptance criteria and evidence:**

```text
grep -rl 'wakeup create' skills docs/agents
```

prints only `skills/setup-matt-pocock-skills/issue-tracker-multica.md` and `docs/agents/issue-tracker.md`.

```text
grep -rn 'creator_id\|assignee_id' skills/grilling
```

prints no lines.

```text
diff -u skills/setup-matt-pocock-skills/issue-tracker-multica.md docs/agents/issue-tracker.md
```

prints no output. A manual section review confirms the Multica flow uses member `user_id`, not membership `id`, and that the three non-Multica sections explain their `n/a` boundary.

### Task 2 — 6: Move repository facts to the instance seam

**Depends on:** Task 1.  
**Requirements:** R-5, R-6, R-7.

**Files and interface:**

- Create `docs/agents/instance.md` with exactly the design sections `## Decision maker`, `## Subscribers`, `## Labels in this workspace`, and `## Agent routing`. Move the owner policy there while leaving generic owner lookup mechanics in the tracker adapter.
- Remove repository-specific wording, SKIL identifiers, and agent routing from both Multica tracker copies; retain neutral examples and make the copies identical.
- Remove the `## Multica labels` section from `docs/agents/triage-labels.md` so it matches `skills/setup-matt-pocock-skills/triage-labels.md`; retain generic name lookup/create behavior in the adapter.
- Update `skills/orchestrate/SKILL.md` to reference instance sections and move parent subscription to the first repository-backed routing/stage run. Update any remaining delivery-contract instance reference. Add an `instance.md` pointer under `AGENTS.md`'s `## Agent skills`.

**Acceptance criteria and evidence:**

```text
grep -rn 'cb288268' skills docs/agents
```

prints only `docs/agents/instance.md`.

```text
diff -u docs/agents/triage-labels.md skills/setup-matt-pocock-skills/triage-labels.md
diff -u skills/setup-matt-pocock-skills/issue-tracker-multica.md docs/agents/issue-tracker.md
```

prints no output.

```text
grep -n 'this repo' skills/setup-matt-pocock-skills/issue-tracker-multica.md
```

has no repository-specific assertion; any remaining match is manually confirmed to be generic wording.

### Task 3a — 7a: Extract the runtime seam

**Depends on:** Task 2.  
**Requirements:** R-8, R-9, R-11, R-12.

**Files and interface:**

- Create `skills/setup-matt-pocock-skills/runtime.md` and byte-identical `docs/agents/runtime.md` with `## Which mode am I in`, `## Subagents: fan out, converge before the turn ends`, and `## Delivering a file`.
- Remove the runtime convergence section and delivery decision from the Multica adapter; leave artifact attachment mechanics for Task 3b.
- Update the six mode-consuming skills (research, handoff, prototype, to-questionnaire, improve-codebase-architecture, grilling) and `ask-matt:75` to cite runtime sections. Keep setup's tracker-selection use of `MULTICA_TASK_ID`, but correct the adapter's old issue-UUID description and add `runtime.md` to the setup file list and `AGENTS.md` skills index.

**Acceptance criteria and evidence:**

```text
grep -rln 'MULTICA_TASK_ID' skills docs/agents
```

prints only the runtime template, `docs/agents/runtime.md`, and the setup skill's tracker-selection logic.

```text
diff -u skills/setup-matt-pocock-skills/runtime.md docs/agents/runtime.md
```

prints no output. A manual review confirms the mode definition says task/run id, one-shot delivery uses the adapter, and fan-out is converged before turn exit without polling or background yield.

### Task 3b — 7b: Normalize the tracker interface

**Depends on:** Task 3a.  
**Requirements:** R-10, R-11, R-12.

**Files and interface:**

- Reorder and complete all four `skills/setup-matt-pocock-skills/issue-tracker-{github,gitlab,local,multica}.md` adapters with the exact ten `##` sections and spelling/order in R-10. Mark unsupported operations `n/a` with a reason.
- Split the old Multica `report the path` content so the runtime decision stays in `runtime.md` and attachment/PR/inline mechanics live in `## Deliver an artifact`.
- Move `prototype:28`'s attachment command into the adapter section; change `grilling:54` to cite tracker `Conventions`; make setup's triage mapping reference `Triage state`.
- Keep every templated `docs/agents/*` copy synchronized with its setup template; `instance.md` is the only repository-only exception.

**Acceptance criteria and evidence:**

Run all four checks and compare each output with R-10:

```text
grep '^## ' skills/setup-matt-pocock-skills/issue-tracker-github.md
grep '^## ' skills/setup-matt-pocock-skills/issue-tracker-gitlab.md
grep '^## ' skills/setup-matt-pocock-skills/issue-tracker-local.md
grep '^## ' skills/setup-matt-pocock-skills/issue-tracker-multica.md
```

and confirm the output is exactly the ten section titles in R-10, in order.

```text
grep -rnE 'multica (issue|label|attachment)' skills --include=SKILL.md
```

prints only the explicitly allowed instance-layer references in `orchestrate` and `delivery-contract`.

```text
diff -u skills/setup-matt-pocock-skills/issue-tracker-multica.md docs/agents/issue-tracker.md
diff -u skills/setup-matt-pocock-skills/runtime.md docs/agents/runtime.md
diff -u skills/setup-matt-pocock-skills/triage-labels.md docs/agents/triage-labels.md
diff -u skills/setup-matt-pocock-skills/domain.md docs/agents/domain.md
```

has no output for corresponding template/install files. The final manual review confirms no adapter or instance document names a skill step or agent.

## Out-of-repository coordination (not Builder tasks)

**Requirement:** R-13. The design's §9 follow-up is recorded here so it cannot be lost, but it is not part of the four repository tasks and must not be implemented by editing this repository. Coordinate it after Task 3b, when both referenced adapter sections exist:

1. Update the Triager agent instructions so label ids come from the selected tracker adapter's `Triage state` section rather than `docs/agents/triage-labels.md`.
2. Update Mika's `orchestrate` agent instructions so ask-and-wait follows the selected tracker adapter's `Ask a person and wait` section rather than `delivery-contract`.

The coordinating owner should report both instruction changes when the serial repository tasks are accepted.
