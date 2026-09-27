---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a cited Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to subagents — including when a decision elsewhere is waiting on a fact you would otherwise have to guess at.
---

Follow `docs/agents/runtime.md`'s `## Subagents: fan out, converge before the turn ends` while delegating reading to subagents collected inside this turn.

If a line of inquiry cannot finish inside this turn, say that in the write-up and name what is still unknown. An honest gap survives; a promised report that never arrives does not.

## What each subagent does

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Report its findings with a source citation on each claim.

## What you do with the reports

Write them up as a single Markdown file, citing each claim's source. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible.

Follow `docs/agents/runtime.md`'s `## Delivering a file` for the handoff; repository research notes belong in a PR.
