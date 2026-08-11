# bytestrone-ef-csharp-pattern-mining (v1.2.1)

Read-only EF6-to-EF-Core migration mining codemod. Scans a .NET repository
and emits [Codemod Insights](https://docs.codemod.com/platform/insights)
metrics — no source files are ever modified.

## Architecture

One workflow node, one `js-ast-grep` step (`scripts/codemod.ts`), scoped to
`**/*.cs`. Everything below runs inside that single step, because
`codemod:metrics` (`useMetricAtom`) is only available inside a `js-ast-grep`
step's per-file execution — it is not available in a separate `run:`/
`jssg exec` step. That constraint is why inventory/config scanning happens
via a lock-guarded one-time `fs` walk inside the same step, rather than a
second step (see comments in `scripts/codemod.ts`).

## Emitted metrics

### Per-pattern legacy API usage (one row per hit, `{filepath, linenumber, explanation}`)

| Metric | Pattern |
| --- | --- |
| `ef_objectcontext_usages` | `ObjectContext` subclassing |
| `ef_dbcontext_usages` | `DbContext` usage (informational — already EF Core-compatible) |
| `ef_idbset_usages` | `IDbSet<T>` |
| `ef_dbset_usages` | `DbSet<T>` usage (informational — already EF Core-compatible) |
| `ef_entity_type_configuration_usages` | `EntityTypeConfiguration<T>` |
| `ef_dbconfiguration_usages` | `DbConfiguration` |
| `ef_execute_sql_command_usages` | `Database.ExecuteSqlCommand` |
| `ef_execute_sql_query_usages` | `Database.SqlQuery<T>` |
| `ef_set_initializer_usages` | `Database.SetInitializer` |
| `ef_virtual_nav_props` | `virtual` navigation properties |
| `ef_db_interception_usages` | `DbInterception.Add` |

### Unified blocker rollup

`ef_migration_blocker` — one row per legacy-API hit (excludes the two
informational/already-compatible patterns above), cardinality
`{blockerType, severity, file, linenumber}`.

| Severity | blockerType values |
| --- | --- |
| `critical` | `ObjectContext`, `DbConfiguration`, `ExecuteSqlCommand`, `SqlQuery`, `SetInitializer`, `DbInterception` |
| `warning` | `IDbSet`, `EntityTypeConfiguration`, `VirtualNavigationProperty` |

Use this metric for a single "all blockers" table or timeseries widget,
grouped/filtered by `blockerType` or `severity`. Use the per-pattern metrics
above for detail widgets on one specific pattern.

### Project inventory (emitted once per scan, cardinality varies per metric)

| Metric | Cardinality | Notes |
| --- | --- | --- |
| `total_projects` | `{file}` | One row per `.csproj` found |
| `legacy_csproj_count` | `{file}` | Subset of the above using the pre-SDK MSBuild format (no `Sdk=` attribute on `<Project>`) |
| `ef_version` | `{packageId, version, file, source}` | `source` is `PackageReference`, `AssemblyReference` (old-style `<Reference Include="EntityFramework, Version=...">`), or `packages.config` |

### Configuration surface area

`ef_config_surface` — cardinality `{configType, name, file}`. `configType` is
one of `connectionString` (from `App.config`/`Web.config`
`<connectionStrings>`), `entityFrameworkSection` (an `<entityFramework>`
block), or `appsettingsConnectionStrings` (a `"ConnectionStrings"` key in
`appsettings*.json`).

### NuGet/GAC dependency risk

`ef_dependency_risk` — every package reference found across
`<PackageReference>` (SDK-style `.csproj`), `packages.config`, and old-style
`<Reference Include="...">` elements (both bare — GAC-resolved — and
`<HintPath>`-backed local/vendored binaries), cardinality
`{packageId, version, source, file, riskTier, risk, targetVersion}`.

`source` is `PackageReference`, `packages.config`, `AssemblyReference` (bare
old-style `<Reference>`, no `<HintPath>`), or `HintPath`.

`riskTier` is one of:

| riskTier | Meaning |
| --- | --- |
| `supported` | Already `Microsoft.AspNetCore.*`/`Microsoft.EntityFrameworkCore*` — no action needed |
| `requires-upgrade` | Known-compatible package, needs a version bump (e.g. `Newtonsoft.Json`) or an unrecognized package worth a manual check |
| `deprecated` | Still works but has a preferred modern replacement (e.g. `log4net` → `Serilog`), or a framework facade package that should just be removed |
| `unsupported` | No direct .NET 8 equivalent exists; requires a rewrite (e.g. `EntityFramework` itself, `System.ServiceModel`/WCF, OWIN middleware) |
| `custom-binary` | A `<HintPath>`-referenced local/vendored DLL not recognized by name — needs a manual compatibility check with the vendor |
| `gac` | A bare `<Reference>` to a Global Assembly Cache-resident framework assembly (e.g. `System.Web`) with no NuGet equivalent shipped — needs an ASP.NET Core replacement |

The compatibility knowledge base (`KNOWN_PACKAGES`/`FACADE_PACKAGES`/
`GAC_REFERENCES` in `scripts/codemod.ts`) is adapted from the community
`dotnet-nuget-dependency-mining` package's `shared/nuget-compatibility.ts`,
retargeted at EF6-to-EF-Core-8 migrations, and kept as plain regex over raw
file text — like the rest of this file's inventory scan — rather than a
dedicated `language: "xml"` js-ast-grep step. `language: "xml"` requires the
engine to dynamically fetch and register a tree-sitter grammar at runtime,
which was observed to fail outright on this Windows dev machine (parser
registration denied by the OS); this metric avoids that fragility entirely by
never touching the XML parser. A package name always takes priority over the
structural `gac`/`custom-binary` heuristics when recognized — e.g.
`EntityFramework` classifies as `unsupported` regardless of whether it's
referenced via `PackageReference`, `packages.config`, or an old-style bare
`<Reference>`.

## Known limitations

The inventory/config scan only fires while at least one `.cs` file exists in
the target repo (the workflow step is only invoked per matched `.cs` file).
A `.csproj`-only repo with zero `.cs` files would not trigger it. This is
believed to be true of essentially every real EF6 codebase.

**Hosted platform per-file execution budget.** The Codemod Insights
hosted platform enforces a per-file execution budget (observed ~200ms) that
local `codemod workflow run` does not. On a large repo (e.g. NopCommerce,
~4,500 files), `scanInventoryOnce()`'s whole-directory `fs` walk took
625ms-1.5s (highly variable — OS-level I/O noise, not something JS-level
tuning bounds reliably), and the file that wins the scan lock will exceed
the hosted budget. Two mitigations are in place: `readdirSync(...,
{withFileTypes: true})` to avoid a `statSync` per entry, and
double-checked locking so files arriving after the scan completes see that
immediately instead of blocking on `acquireLock` — this cut collateral
damage on NopCommerce from 12 blocked files down to 1 (the lock winner
itself, which still risks the hosted timeout on large repos). The
underlying fix — validated but not yet implemented — is to stop doing a
manual `fs` walk entirely and instead broaden the workflow's `include` glob
to also match `.csproj`/`packages.config`/`*.config`/`appsettings*.json`
directly, letting the engine's own native file walker invoke this codemod
separately per config file (confirmed safe: the C# parser is never touched
for those files, only `readFileSync`). That distributes the cost across
many small per-file invocations instead of one large blocking one.

## Testing

```bash
npm test              # jssg snapshot tests + inventory-scan smoke test
npm run check-types
```

`npm test` runs both `codemod jssg test` (per-pattern and blocker-detection
snapshots under `tests/`) and `test:inventory-scan`
(`scripts/verify-inventory-scan.mjs`), a real `codemod workflow run` against
`tests/inventory-and-config-scan/input`. The second one is necessary because
`codemod jssg test` sandboxes each fixture file in isolation and cannot
exercise the whole-directory `fs` walk the inventory/config scan depends on
— see `tests/inventory-and-config-scan/README.md` for details. Run
`test:inventory-scan` explicitly whenever you touch `scanInventoryOnce()` or
its helpers.

## Composite scores (readiness, risk, effort) are not emitted here

`codemod:metrics` only supports `increment()` — there is no settable gauge,
and (per the constraint above) no way to compute a value from multiple
metrics at once inside the script. Composite scores like "EF Core 8
readiness %" or "estimated story points" are weighted formulas over *several*
of the raw metrics above, so they belong in the Insights dashboard's Formula
widgets, not in this codemod. See the assessment bundle's README
(`bytestrone-ef-migration-assessment-bundle`) for the documented formula
recipes that consume these raw metrics.

## Execution

```bash
# Run locally against a target .NET repo
npx codemod workflow run --workflow workflow.yaml --target path/to/your/dotnet-repo --allow-fs

# Publish to registry
npx codemod login
npx codemod publish
```
