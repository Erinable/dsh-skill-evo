---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
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

## Two carriers for a round

A round is always the same content. What differs is how you hand it over and how the answer comes back. Check these conditions in order and take the first that matches:

1. **`MULTICA_TASK_ID` is set in the environment** (or the runtime brief says the task reaches a terminal state when the turn exits) → **issue-async**. The run cannot outlive the turn, so there is nothing to wait inside.
2. **Otherwise** → **interactive session**. The session survives across the user's reply.

### Interactive session

Post the round, then wait for the user's answers in the same session and continue with the next round. Everything above applies unchanged.

### Issue-async

One round, one run. Each round ends with your run ending, and the member's reply is what starts the next one — handing the turn back is how the loop advances, not a failure to finish. The design tree needs no in-memory state: the issue's comment history _is_ the tree, so each run rebuilds the frontier by reading it.

Per round:

1. Write the round to a file and post it as one issue comment (`--content-file`; see the tracker doc's rules on file-backed bodies). Reply in the thread you were triggered from by passing that thread's `--parent`.
2. Register the wakeup that will bring you back, naming the member whose answers you need:

   ```
   multica issue wakeup create <issue-id> \
     --event comment.created \
     --filter-actor-type member --filter-actor-id <member-user-id> \
     --mode once \
     --parent <thread-comment-id> \
     --instruction "Grilling round <N> is posted. Read the new reply, recompute the frontier, ask the next round."
   ```

   `--filter-actor-type member` is what makes this correct: without it, your own comment and every agent write on the issue can wake you into a round nobody has answered. Get the member's UUID from the triggering comment's author, or from the issue's `creator_id` / `assignee_id`. `--mode once` matches one round; a `continuous` subscription on `comment.created` is how two agents wake each other in a loop.

3. End the run. Do not poll, sleep, or re-read the issue hoping the answer lands before the turn closes.

On waking: read the comments added since your last round, attribute each answer to its question number, recompute the frontier, and post the next round. A question the member did not answer stays on the frontier — carry it into the next round as still-open, in their words or not at all. Answers are the member's to give, so every round you post is a round you leave for them; supplying the missing side yourself would settle the tree against a decision nobody made.

When the frontier is empty, post the shared-understanding summary and register one more wakeup the same way: the member's confirmation is itself an answer, and it arrives in a later run.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, docs), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Dispatch every such fact-finder for this round in one batch so they run concurrently, and **collect all of their reports before this run ends** — see the tracker doc's fan-out-and-converge rule. A sub-agent still reading when your turn exits is orphaned and its answer is lost, so the question it was settling comes back unsettled with nothing to show.

Inside the round, a running sub-agent is an unsettled prerequisite: it does not stall the rest of the frontier. Ask every question that doesn't depend on it now, in this same round, and leave the questions downstream of that fact for a later round. What waits on the sub-agent is those downstream questions — never your own turn boundary.

The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
