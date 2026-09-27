# Workspace Instance

Read this file when a workflow needs workspace-specific people, labels, or agent routing. Label names below are a snapshot; query the tracker adapter for current values.

## Decision maker

The workspace owner is the decision maker. Resolve the owner through the tracker adapter's workspace member query (`role == owner`, using `user_id`). The current owner is ack7 (`cb288268-0840-47ad-837b-f1c63c65b0e6`); treat the query result as authoritative if it changes.

## Subscribers

The default subscriber set is the request initiator plus the decision maker, deduplicated by `user_id`. The canonical issue-description line is `需求提出人 user_id: <member-user-id>`; parent creation writes it and every child copies it into `child.md`.

- **Request initiator**: resolve in this order: a valid `需求提出人 user_id` line already recorded in the issue description; if the line says `unresolved`, use the decision maker immediately; otherwise use the member who authored the triggering comment, then `creator_id` only when `creator_type == member`, then the decision maker. The `creator_type == member` case is safe because the platform has established that the id is a member, and is the deliberate exception to ADR-0012's old agent-id guard.
- **Decision maker**: the workspace owner from the `Decision maker` section above.

When chat context cannot provide a member id, write `需求提出人 user_id: unresolved (fallback to Decision maker)` instead of inventing an id. When no valid member request initiator can be resolved, subscribe only the decision maker. A parent and every child issue use this same set. Resolve each person through the tracker adapter's workspace member query and pass `user_id`; membership ids and agent ids are not substitutes.

## Labels in this workspace

Current label snapshot:

- Triage: `needs-info`, `needs-triage`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Work tracking: `wayfinder:grilling`, `wayfinder:map`, `wayfinder:prototype`, `wayfinder:research`, `wayfinder:task`.

This snapshot may become stale. The tracker's label query is authoritative; resolve labels by name and create them when absent.

## Agent routing

- Assign `wayfinder:research` tickets to Scout. When the map owner works from a map, skip the `wayfinder` skill's "Fire the research subagents" step for those tickets to avoid duplicating the assigned research work.
