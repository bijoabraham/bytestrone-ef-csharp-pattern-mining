# inventory-and-config-scan fixture

This directory-snapshot fixture exercises the per-.cs blocker-detection path
(`ef_migration_blocker`, `ef_idbset_usages`, etc.) the normal way, via
`npm test` / `codemod jssg test`.

It does **not** exercise the `.csproj`/`packages.config`/`App.config`/
`appsettings.json` metrics (`total_projects`, `legacy_csproj_count`,
`ef_version`, `ef_config_surface`, `ef_dependency_risk`), even though each
of those files is included in the fixture and does get its own invocation
under `codemod jssg test` (they show up as separate named test cases).
`codemod jssg test`'s directory-fixture snapshotting only ever captured a
`metrics.json` next to the `.cs` file here, not next to the other files —
observed both before and after the v1.4.0 rewrite that removed the old
whole-directory `fs` walk this fixture originally existed to route around,
so it's a snapshot-harness quirk, not something about how the scan works.

The `.csproj`/config metrics are verified separately, end-to-end, by
`npm run test:inventory-scan` (`scripts/verify-inventory-scan.mjs`), which
runs a real `codemod workflow run --target ./tests/inventory-and-config-scan/input`
and asserts the expected metrics appear in its output. Run that whenever you
change the `scan*` helpers in `scripts/codemod.ts` — `npm test` alone will
not catch regressions there.
