# Vibecheck

This is a passive ledger of agent work. Preserve the nine-tool protocol, compact status, immutable history, and SQLite schema compatibility.

Use strict TypeScript throughout source, tests, and build scripts. Do not use `any`, type assertions (including `as const`), non-null assertions, or compiler suppression comments. Validate external input with schemas and infer types from those schemas. Use concrete domain types inside the application.

Run `bun run build:release` after changing runtime source or dependencies, then `bun run verify` before handing off a change. Verification rejects a stale bundled runtime. Runtime behavior must pass under Bun and compiled JavaScript on Node. Do not add a Python runtime or build dependency.

The root agent owns the plan and dependency graph in `docs/migration-plan.md`. Delegates implement bounded assigned work and do not create separate plans or graphs.
