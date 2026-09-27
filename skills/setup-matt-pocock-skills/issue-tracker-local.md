# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- Use `.scratch/<feature-slug>/spec.md` for a spec and `.scratch/<feature-slug>/issues/NN-<slug>.md` for one ticket per file.
- Put comments under `## Comments`; use the file itself for reads, writes, and status changes.
- A `Status:` line near the top records the issue lifecycle and assignment.

## Triage state

Record the five roles as the `Status:` value: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix`. No label service exists; do not create or resolve labels. `wontfix` is a terminal status.

## Pull requests as a triage surface

n/a: local Markdown has no pull request or merge request tracker.

## When a skill says "publish to the issue tracker"

Create the feature directory and write a spec or issue file under `.scratch/`.

## When a skill says "fetch the relevant ticket"

Read the referenced `.scratch/<feature-slug>/issues/<NN>-<slug>.md` file and its `## Comments` section.

## Deliver an artifact

Write the artifact into the repository, normally under `.scratch/<feature-slug>/`, and reference it from the issue file. That committed file is the delivery; a runtime-local path is not.

## Concurrent writes

Set `Status: claimed` before editing a ticket. This tracker is intended for one writer per ticket; concurrent writes are unsupported (`n/a`), while appending comments is safe when coordinated.

## Mentions

n/a: local Markdown has no notification or mention service.

## Ask a person and wait

Append the question under the issue's `## Comments` heading. Interactive sessions can continue in place; one-shot runs have no file watcher or wakeup operation (`n/a`).

## Wayfinding operations

- **Map:** `.scratch/<effort>/map.md` with Notes, Decisions-so-far, and Fog.
- **Child ticket:** `.scratch/<effort>/issues/NN-<slug>.md` with a `Type:` line and a `Status:` line.
- **Blocking:** record `Blocked by: NN, NN`; a ticket is unblocked when every listed file is resolved.
- **Frontier:** scan the issue directory, remove blocked or claimed files, and take the first remaining number.
- **Resolve:** append `## Answer`, set `Status: resolved`, and add a context pointer to `map.md`.
