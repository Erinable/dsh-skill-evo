---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a cited Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to subagents — including when a decision elsewhere is waiting on a fact you would otherwise have to guess at.
---

Delegate the reading to **subagents you collect inside this turn**. A subagent reads far more than you want in your own context, and its report comes back compressed — that is the whole reason to use one. What you must not do is let the turn end while one is still reading.

## Dispatch in parallel, converge before the turn ends

Split the question into independent lines of inquiry and dispatch one subagent per line — **all in the same batch**, so they read concurrently. Then block until every one of them has reported, and write the findings up before this turn exits.

Parallel is not the same thing as background, and the difference is where the turn ends:

- **Fan out and converge (do this):** dispatch N subagents at once, wait for all N to report, then write the file. The wall-clock cost is one subagent, not N. Nothing is serialized except the write-up at the end.
- **Background and yield (never do this):** dispatch a subagent, stop waiting for it, and finish your turn. Under a one-shot run — `MULTICA_TASK_ID` set in the environment, or the runtime brief says the task reaches a terminal state when the turn exits — the task goes terminal the moment your turn does. Anything still reading is orphaned and its findings are lost. Not delayed: lost. You will have reported research that does not exist.

So: never poll, sleep, or end a turn "standing by" for a report. And never narrow to one subagent out of caution about backgrounding — serializing the reads throws away the parallel win without buying any safety. The constraint is *collect before you exit*, not *dispatch one at a time*.

If a line of inquiry cannot finish inside this turn, say that in the write-up and name what is still unknown. An honest gap survives; a promised report that never arrives does not.

## What each subagent does

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Report its findings with a source citation on each claim.

## What you do with the reports

Write them up as a single Markdown file, citing each claim's source. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible.

The file in the repo is the right artifact — it rides a PR into the repo and so survives every later run. **How you hand it over depends on the carrier.** In an interactive session sharing the user's filesystem, saying where it landed is the hand-over. Under a one-shot run the path reaches nobody: commit the file, open a PR, and deliver the PR link plus the findings that matter inline. Per the tracker doc's "report the path" rules — never report a runtime-local path as the deliverable.
