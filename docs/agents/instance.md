# Workspace Instance

Read this file when a workflow needs workspace-specific people, labels, or agent routing. Label names below are a snapshot; query the tracker adapter for current values.

## Decision maker

The workspace owner is the decision maker. Resolve the owner through the tracker adapter's workspace member query (`role == owner`, using `user_id`). The current owner is ack7 (`cb288268-0840-47ad-837b-f1c63c65b0e6`); treat the query result as authoritative if it changes.

## Subscribers

The default subscriber set is the request initiator plus the decision maker, deduplicated by `user_id`:

- **Request initiator**: the chat initiator for a chat-created request, or the member who authored the triggering comment for an issue run.
- **Decision maker**: the workspace owner from the `Decision maker` section above.

When no member request initiator can be resolved, subscribe only the decision maker. A parent and every child issue use this same set. Resolve each person through the tracker adapter's workspace member query and pass `user_id`; membership ids, agent ids, `creator_id`, and `assignee_id` are not substitutes.

## Labels in this workspace

Current label snapshot:

- Triage: `needs-info`, `needs-triage`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Work tracking: `wayfinder:grilling`, `wayfinder:map`, `wayfinder:prototype`, `wayfinder:research`, `wayfinder:task`.

This snapshot may become stale. The tracker's label query is authoritative; resolve labels by name and create them when absent.

## Agent routing

- Assign `wayfinder:research` tickets to Scout. When the map owner works from a map, skip the `wayfinder` skill's "Fire the research subagents" step for those tickets to avoid duplicating the assigned research work.
