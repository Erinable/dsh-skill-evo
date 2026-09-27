---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

**Where it lands depends on the carrier.** Check these conditions in order and take the first that matches:

1. **One-shot mode** (as defined by `docs/agents/runtime.md`'s `## Which mode am I in`) → deliver the document through the selected tracker adapter.
2. **Interactive mode** → save to the temporary directory of the user's OS and report the path.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
