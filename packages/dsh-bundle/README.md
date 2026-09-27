# @dsh-skill-evo/dsh-bundle

Installable DSH observer bundle. It records committed `session/event` facts to
`$DSH_HOME/skill-evolution/events.jsonl`.

## Local development

Build the local dependencies before installing the bundle. Run these commands
in order from the repository root:

```bash
(cd packages/skill-evolution && npm install && npm run build)
(cd packages/dsh-adapter && npm install && npm run build)
(cd packages/dsh-bundle && npm install)
```

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

The bundle and the `dsh-skill-evolution` executable are adapters over the same
core maintenance operations. Both parse their own input, call the core
operation, and render its result; proposal lookup, transitions, evaluation
artifacts, validation, and publication checks therefore have the same behavior.
The bundle does not infer Skill impact from arbitrary runtime events, and these
commands remain outside the model tool catalog.

In a DSH session, the bundle contributes the human slash commands
`/skill-evolution observe`, `/skill-evolution failures`,
`/skill-evolution metrics`, `/skill-evolution health`,
`/skill-evolution repair`, `/skill-evolution feedback`,
`/skill-evolution propose`, `/skill-evolution evaluate`,
`/skill-evolution accept`, `/skill-evolution reject`,
`/skill-evolution defer`, `/skill-evolution promote`, and
`/skill-evolution rollback`. The session workspace is the default evolution
root. The equivalent executable commands are:

```bash
dsh-skill-evolution observe --root /path/to/project
dsh-skill-evolution failures --root /path/to/project --format markdown
dsh-skill-evolution feedback --root /path/to/project --session SESSION --kind incorrect --skill api-debugging --note "遗漏代理超时配置"
dsh-skill-evolution propose --root /path/to/project --skill api-debugging --base-file SKILL.md --candidate-file candidate.md --proposed-version 1.1.0 --intent "Add timeout diagnosis"
dsh-skill-evolution evaluate --root /path/to/project --proposal proposal-id --cases cases.json
dsh-skill-evolution accept --root /path/to/project --proposal proposal-id --reason "Reviewed evaluation"
dsh-skill-evolution promote --root /path/to/project --proposal proposal-id --scope project
dsh-skill-evolution rollback --root /path/to/project --skill api-debugging --version 1.0.0
dsh-skill-evolution repair --root /path/to/project
dsh-skill-evolution rotate --root /path/to/project --max-bytes 10485760 --retention-days 30
```

`evaluate` writes the artifact to
`.skill-evolution/evaluations/<proposal-root>.json` by default. `promote` selects
the latest unexpired artifact for that root; pass `--evaluation PATH` only when
using an explicit artifact. Valid publication scopes are `explicit-only`,
`project`, `user`, and `stable`.

The complete bundle flow keeps a quoted multi-word intent as one value and
uses the same root-based defaults:

```text
/skill-evolution propose --skill api-debugging --base-file SKILL.md --candidate-file candidate.md --proposed-version 1.1.0 --intent "Add timeout diagnosis"
/skill-evolution evaluate --proposal proposal-id --cases cases.json
/skill-evolution accept --proposal proposal-id --reason "Reviewed evaluation"
/skill-evolution promote --proposal proposal-id --scope project --dry-run true
/skill-evolution promote --proposal proposal-id --scope project
```
