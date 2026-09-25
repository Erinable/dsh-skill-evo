# @dsh-skill-evo/dsh-bundle

Installable DSH observer bundle. It records committed `session/event` facts to
`$DSH_HOME/skill-evolution/events.jsonl`.

## Local development

Install the bundle as a symlink so source changes are visible to the profile:

```bash
dsh plugin --profile web add \
  '@dsh-skill-evo/dsh-bundle@link:/absolute/path/to/packages/dsh-bundle'
```

After editing the bundle, restart DSH to reload the module. Reinstall only when
the package manifest or dependency graph changes. The `file:` protocol installs
a copied package and is intended for isolated verification or release-like
checks.

By default, events are recorded as `agent-step`. Integrations that have access
to concrete Skill catalog or loader callbacks may pass a synchronous
`mapEvent(session, event, { id })` function in the bundle config. The mapper
must return a `DshObservationInput`-compatible object, such as
`catalog-visible`, `skill-loaded`, or `user-follow-up`. Returning `undefined`
keeps the default `agent-step` observation. Mapper failures are logged and also
fall back to the default observation.

The bundle does not infer Skill impact, generate proposals, modify Skill files,
or publish versions.
