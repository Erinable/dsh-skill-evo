# Repository Guidelines

## Project Structure & Module Organization

This repository contains research documentation and three independently packaged Node modules:

- `packages/skill-evolution/`: core evidence, JSONL storage, exposure views, and adoption validation.
- `packages/dsh-adapter/`: DSH runtime fact translation into core observations.
- `packages/dsh-bundle/`: installable DSH observer bundle and `cordis.patch.yml` integration.
- `packages/skill-evolution/bin/`: stable maintenance CLI (`observe`, `propose`, `evaluate`, `accept`, `promote`, `rollback`, `repair`, `rotate`).
- `docs/`, `research/`, and `skill-进化设计-MVP.md`: architecture, mechanism, and research notes.
- Each package keeps implementation in `src/` (where applicable) and tests in `tests/`.

Keep DSH-specific integration in the adapter or bundle; keep the core package independent of DSH internals.

## Build, Test, and Development Commands

Run commands from the repository root with the package-specific prefix because there is no root workspace manifest. Install dependencies with `npm install` in the package you are changing.

```bash
npm --prefix packages/skill-evolution run build  # compile TypeScript to lib/
npm --prefix packages/dsh-adapter test           # run Vitest tests
npm --prefix packages/skill-evolution test       # run core Vitest tests
npm --prefix packages/dsh-bundle test            # run node:test bundle tests
npm --prefix packages/dsh-adapter run build    # compile adapter declarations and runtime
```

Build both TypeScript packages before publishing or checking generated declarations. The bundle is exercised directly from its JavaScript entry point.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules, NodeNext resolution, and two-space indentation. Match the existing style: single quotes, semicolon-free statements, trailing commas where useful, and explicit types at public boundaries. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and descriptive kebab-case package or skill names. Test files follow `*.spec.ts` or `*.spec.mjs`.

No formatter or linter is configured; keep changes consistent with neighboring files and rely on `tsc` and tests for validation.

## Testing Guidelines

Add focused regression coverage beside the package being changed. Vitest is used by `skill-evolution` and `dsh-adapter`; `dsh-bundle` uses Node’s built-in `node:test` runner. Use temporary directories for filesystem tests and verify idempotency, event mapping, and stale-content behavior where relevant.

## Commit & Pull Request Guidelines

Use short Conventional Commit subjects such as `feat:`, `test:`, or `docs:` followed by an imperative description. Keep commits focused. Pull requests should explain the behavior or research change, identify affected packages, link relevant design context or issues, and include the exact test/build commands run. Include screenshots only when documenting a visual or UI change.
