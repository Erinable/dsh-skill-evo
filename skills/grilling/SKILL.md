---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases — including "grill me" and "grill me with docs", both of which are this skill.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

## Two grounds: with a repo, without one

The interview is the same either way. What differs is whether it leaves a paper trail. Decide once, at the start:

- **A working directory is under you** → also load `domain-modeling` and run it alongside the interview. Every term you and the user pin down lands in `CONTEXT.md`; every hard-to-reverse decision lands as an ADR. The tree stops living only in the transcript, so a later reader — or a later run — can pick it up from the files. Prefer this whenever a repo is there to write into: the paper trail costs one extra skill load and buys everything the transcript loses.
- **No working directory** (a plan, a design, a piece of writing, nothing with a repo under it) → pure conversation, nothing written to disk. The shared understanding you reach at the end is the whole deliverable, so state it in full rather than pointing at files that do not exist.

These two grounds used to be two separate wrapper skills (`grill-me` and `grill-with-docs`), each existing only to supply a slash-command entry point. They are branches of this skill now.

The ground is independent of the carrier below: an issue-async run in a checked-out repo takes the first branch and the issue-async carrier both.

## Two carriers for a round

A round is always the same content. What differs is how you hand it over and how the answer comes back. Check these conditions in order and take the first that matches:

1. Follow `docs/agents/runtime.md`'s `## Which mode am I in`: one-shot runs use **issue-async**, while interactive sessions survive across the user's reply.

### Interactive session

Post the round, then wait for the user's answers in the same session and continue with the next round. Everything above applies unchanged.

### Issue-async

One round, one run. Each round is recorded on the issue, and the run keeps advancing through the frontier without waiting for a member. The design tree needs no in-memory state: the issue's comment history _is_ the tree, so each run rebuilds the frontier by reading it.

Per round:

1. Write the round to a file-backed body using the selected tracker adapter's `Conventions`. The body must list every frontier question and its recommended answer.
2. Publish the round as an issue comment, then immediately publish a decision comment for each question: `采用默认答案，成员可推翻` followed by the recommended answer. Recompute the frontier after applying those answers and continue in the same run.
3. Repeat until the frontier is empty. Do not use `Ask a person and wait` for business judgment questions. Use that adapter operation only for `irreversible / permission / spending` questions, and end the run after registering the wait.

If a member later replies, treat that reply as a requested override, apply it to the affected decision, and recompute the frontier. A reply is never required for the default decision to take effect.

When the frontier is empty, post the shared-understanding summary and finish the issue-async run. The summary must identify every default decision and say that the member may overturn it.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, docs), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Follow `docs/agents/runtime.md`'s `## Subagents: fan out, converge before the turn ends` while collecting those reports.

Inside the round, a running sub-agent is an unsettled prerequisite: it does not stall the rest of the frontier. Ask every question that doesn't depend on it now, in this same round, and leave the questions downstream of that fact for a later round. What waits on the sub-agent is those downstream questions — never your own turn boundary.

The _recommendations_ are the agent's: record each one and proceed. Members retain the ability to overturn a recorded default.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
