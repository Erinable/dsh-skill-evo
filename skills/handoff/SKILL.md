---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

**Where it lands depends on the carrier.** Check these conditions in order and take the first that matches:

1. **`MULTICA_TASK_ID` is set in the environment** (or the runtime brief says the task reaches a terminal state when the turn exits) → the next agent is a different run on a possibly different machine, so a file on this machine reaches nobody. Deliver the document on the surface this run answers on, per the tracker doc's "report the path" rules: post it as the comment body when it reads inline, or write it into the working directory and attach it. Never report a temp-directory path as the handoff.
2. **Otherwise** → an interactive session sharing the user's filesystem. Save to the temporary directory of the user's OS, not the current workspace, and tell them the path.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
