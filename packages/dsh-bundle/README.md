# @dsh-skill-evo/dsh-bundle

Installable DSH observer bundle. It records committed `session/event` facts to
`$DSH_HOME/skill-evolution/events.jsonl`.

By default, events are recorded as `agent-step`. Integrations that have access
to concrete Skill catalog or loader callbacks may pass a synchronous
`mapEvent(session, event, { id })` function in the bundle config. The mapper
must return a `DshObservationInput`-compatible object, such as
`catalog-visible`, `skill-loaded`, or `user-follow-up`. Returning `undefined`
keeps the default `agent-step` observation. Mapper failures are logged and also
fall back to the default observation.

The bundle does not infer Skill impact, generate proposals, modify Skill files,
or publish versions.
