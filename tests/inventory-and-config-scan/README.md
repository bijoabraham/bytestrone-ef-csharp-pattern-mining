# inventory-and-config-scan fixture

This directory-snapshot fixture exercises the per-.cs blocker-detection path
(`ef_migration_blocker`, `ef_idbset_usages`, etc.) the normal way, via
`npm test` / `codemod jssg test`.

It does **not** exercise `scanInventoryOnce()`'s whole-directory `fs` walk
(`total_projects`, `legacy_csproj_count`, `ef_version`, `ef_config_surface`).
`codemod jssg test` runs each fixture file through the codemod in isolation —
`readdirSync(".")` sees no sibling files there, even though the same code
correctly walks the real target directory under `codemod workflow run`. This
is a limitation of the `jssg test` snapshot harness, not the scan logic.

The inventory/config-surface scan is verified separately, end-to-end, by
`npm run test:inventory-scan` (`scripts/verify-inventory-scan.mjs`), which
runs a real `codemod workflow run --target ./tests/inventory-and-config-scan/input`
and asserts the expected metrics appear in its output. Run that whenever you
change `scanInventoryOnce()`, `walk()`, or any of the `scan*` helpers in
`scripts/codemod.ts` — `npm test` alone will not catch regressions there.
