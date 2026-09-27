# Workspace Instance

Read this file when a workflow needs workspace-specific people, labels, or agent routing. Label names below are a snapshot; query the tracker adapter for current values.

## Decision maker

The workspace owner is the decision maker. Resolve the owner through the tracker adapter's workspace member query (`role == owner`, using `user_id`). The current owner is ack7 (`cb288268-0840-47ad-837b-f1c63c65b0e6`); treat the query result as authoritative if it changes.

## Subscribers

Subscribe the decision maker when creating parent or child issues. A chat-created parent is subscribed during its first repository-backed routing run, when this file is available.

## Labels in this workspace

Current label snapshot:

- Triage: `needs-info`, `needs-triage`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Work tracking: `wayfinder:grilling`, `wayfinder:map`, `wayfinder:prototype`, `wayfinder:research`, `wayfinder:task`.

This snapshot may become stale. The tracker's label query is authoritative; resolve labels by name and create them when absent.

## Agent routing

- Assign `wayfinder:research` tickets to Scout. When the map owner works from a map, skip the `wayfinder` skill's "Fire the research subagents" step for those tickets to avoid duplicating the assigned research work.
