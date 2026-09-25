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

The bundle has a built-in mapper for DSH's durable session events. It records
Skill catalog messages as `catalog-visible`, `skill` tool calls and results as
`skill-load-requested`, `skill-loaded`, or `skill-load-failed`, explicit
`/skill-name` injections as `skill-loaded`, and later human messages as
`user-follow-up`. Other events remain `agent-step`; ordinary tool results are
recorded as `tool-result`, and turn completion is recorded as `task-finished`.
Skill load observations include a SHA-256 hash when
the rendered Skill body is present, tool results are correlated with their
request event, and `fs/observed` events for `SKILL.md` files are recorded as
`skill-file-observed` with a SHA-256 content hash when the file can be read,
plus the filesystem version as `resourceHash`.

Integrations may pass a synchronous `mapEvent(session, event, { id })` function
in the bundle config to override this built-in mapping. The mapper must return
a `DshObservationInput`-compatible object. Returning `undefined` keeps the
generic `agent-step` fallback for that custom mapper. Mapper failures are logged
and also fall back to the generic observation.

The bundle does not infer Skill impact, generate proposals, modify Skill files,
or publish versions.
