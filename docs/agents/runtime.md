## Which mode am I in

An available `MULTICA_TASK_ID` means this is a one-shot run. `MULTICA_TASK_ID` is the task/run id, not an issue id. The same one-shot mode applies when the runtime brief says the task reaches a terminal state when the turn exits. Otherwise this is an interactive session that survives across the user's reply.

## Subagents: fan out, converge before the turn ends

A one-shot run reaches a terminal state when the top-level turn exits. A dispatched subagent whose result has not been collected by then is orphaned, so its work is lost.

Dispatch independent subagents in parallel, then block until every report has arrived before writing up or ending the turn. Parallel dispatch is compatible with this rule; serializing the reads is unnecessary. Work that cannot finish inside the turn belongs in a follow-up issue or wakeup instead. Do not poll or sleep waiting for a report.

Skills that dispatch subagents should point here rather than restating these convergence rules.

## Delivering a file

In an interactive session sharing the user's filesystem, a file can be handed over by reporting its path. In a one-shot run, a runtime-local path reaches nobody. Follow the selected tracker adapter's `## Deliver an artifact` section for the delivery mechanism.

If the artifact belongs in the repository, commit it and open a PR. If it is a one-off for a reader, attach it to the surface the run answers on. If it is short enough to read inline, put it in the response instead. Never present an absolute path or `file://` URL as the deliverable.
