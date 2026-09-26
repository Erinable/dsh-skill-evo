# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Multica labels

In Multica a label is a workspace-scoped object, not a free string. `multica issue label add` takes the label's **UUID**, so look it up by name first:

```bash
multica label list --output json   # find the entry whose name matches, use its id
multica issue label add <issue-id> <label-id>
```

Don't hard-code label UUIDs in docs or scripts; they belong to the workspace and change with it. Always resolve them by name at the time of use.

Besides the five triage labels above, the workspace already has these `/wayfinder` labels (see `docs/agents/issue-tracker.md` for how they are used):

- `wayfinder:map`
- `wayfinder:research`
- `wayfinder:prototype`
- `wayfinder:grilling`
- `wayfinder:task`
