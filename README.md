# bytestrone-ef-csharp-pattern-mining (v1.6.0)

Read-only EF6-to-EF-Core migration mining codemod. Scans a .NET repository
and emits [Codemod Insights](https://docs.codemod.com/platform/insights)
metrics — no source files are ever modified.

## Architecture

One workflow node, one `js-ast-grep` step (`scripts/codemod.ts`), `language:
"csharp"`. The `include` glob matches `**/*.cs` **and** `**/*.csproj`,
`packages.config`, `App.config`, `Web.config`, `appsettings*.json` — the
engine's own native file walker invokes this codemod separately for each
matched file, regardless of type. The C# parser is never touched for the
non-.cs files (confirmed safe: the engine happily invokes the codemod
function for them without erroring); only `root.source()` (raw text) is
used, which is all the `.csproj`/config parsing needs.

Every file emits its own metrics independently — there is no shared state,
no lock, no whole-repo `fs` walk. This is the second design for the
inventory/config/dependency-risk metrics; see [Known
limitations](#known-limitations) for why the first one (a lock-guarded
whole-repo `fs` walk on one file's invocation) had to be replaced.

## Default Insights dashboard

`insights/default-template.json` is what Registry's **View impact on repo**
button uses to generate a dashboard for this package — an undocumented
(as of this writing) file-based convention: a JSON dashboard spec at that
exact path, with a `repo` repository template variable and a
`packageReference: {"type": "self", "workflowName": "main", "stepName":
"..."}` block self-referencing this package's own workflow/step. Every
query-backed widget's `repositoryReference` points at the `repo` variable,
so no repo is hardcoded in the template.

It ships the full 17-widget "EF6 to EF Core Migration Assessment" dashboard
(blocker trends, dependency-risk table, largest-files table,
CODEOWNER rollup, risk/readiness scores, and the Estimated Effort/Cost
formulas described under [Dashboard formulas](#composite-scores-readiness-risk-effort-are-not-emitted-here)),
not the generic per-metric overview a package gets by default. Edit this
file directly to change what **View impact on repo** generates — it's
versioned and published like any other file in the package.

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

### Project inventory (one row per matched file, cardinality varies per metric)

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

`ef_high_risk_dependency_count` — a pre-filtered companion to
`ef_dependency_risk`, one row per dependency whose `riskTier` is
`unsupported`, `gac`, `custom-binary`, or `requires-upgrade` (i.e. everything
except `supported` and `deprecated`), cardinality `{packageId, riskTier,
file}`. Exists because dashboard Formula widgets need an IN-list filter
(`riskTier in {...}`) to total "high risk" deps from `ef_dependency_risk`
directly, which isn't reliably expressible there — this metric applies that
exact filter at emission time, so a plain `SUM(ef_high_risk_dependency_count)`
gives the total.

### Lines of code

`ef_loc_inventory` — one row per `.cs` file, cardinality `{file, loc,
totalLines}` (`loc` = non-blank line count, `totalLines` = including blanks).
Good for a "largest source files" table, but `loc`/`totalLines` are string
cardinality *tags* here, not numeric measures — a dashboard `SUM()` over this
metric sums row counts (1 per file), not the tag values.

`ef_total_loc` — a summable companion, one row per `.cs` file, cardinality
`{file}`, incremented by the file's actual non-blank line count (via
`MetricAtom.increment`'s `amount` parameter) instead of the default 1. A
plain `SUM(ef_total_loc)` therefore gives the true total LOC across the
scanned files — the metric this repo's effort/cost dashboard formulas
actually need, e.g. `effort_days = (SUM(ef_total_loc) / 4000) + ...` —
modeled on the community `dotnet-loc-inventory` metric.

## Known limitations

Every matched file (`.cs`, `.csproj`, `packages.config`, `App.config`,
`Web.config`, `appsettings*.json`) emits its own metrics independently via
the engine's native `include`-glob per-file dispatch — no shared state, no
lock, no whole-repo `fs` walk. (An earlier design used a lock-guarded
whole-repo `fs` walk for the inventory/config/dependency-risk metrics;
it was replaced in v1.4.0 after failing on the hosted platform's per-file
execution budget — see git history on `scanInventoryOnce()` for the full
postmortem if you need it.) A ".csproj-only repo with zero `.cs` files
wouldn't get scanned" limitation from that earlier design is also gone —
every matched file now emits its own metrics regardless of what else is in
the repo.

Re-verified locally against real NopCommerce with the published v1.4.0
package: `total_projects`/`legacy_csproj_count` = 31, `ef_migration_blocker`
= 270 (64 critical / 206 warning), `ef_dependency_risk` = 1067, zero new
errors beyond the 9 pre-existing "stream did not contain valid UTF-8" read
failures (unrelated to this architecture — a small number of files in that
repo are genuinely not valid UTF-8). **Hosted-platform re-verification is
still outstanding** — that's the one environment the previous design's
failure ever actually showed up in; re-index the real Insights dashboard and
confirm `total_projects`, `legacy_csproj_count`, `ef_version`,
`ef_config_surface`, `ef_dependency_risk`, and their Formula widgets
populate before treating this as fully confirmed.

**Local CLI runs are not a reliable proxy for hosted-platform behavior** for
anything touching `fs`/runtime APIs. v1.2.1 briefly tried
`readdirSync(dir, { withFileTypes: true })`; it worked locally but crashed
the hosted runtime 100% of the time (`Dirent.name` came back `undefined`
there — different LLRT/`fs` build), reverted in v1.2.2. Verify against a
real hosted dashboard run before considering any `fs`/timing-sensitive
change safe.

## Testing

```bash
npm test              # jssg snapshot tests + inventory-scan smoke test
npm run check-types
```

`npm test` runs both `codemod jssg test` (per-pattern and blocker-detection
snapshots under `tests/`) and `test:inventory-scan`
(`scripts/verify-inventory-scan.mjs`), a real `codemod workflow run` against
`tests/inventory-and-config-scan/input`. Each file's metrics are emitted
independently now (no shared state to worry about), but `codemod jssg
test`'s directory-fixture snapshotting only ever captured metrics.json next
to the `.cs` file in this fixture, not next to the `.csproj`/config files
tested alongside it — observed both before and after the v1.4.0 rewrite, so
it's a test-harness quirk rather than anything about the scan design. The
real `codemod workflow run` in `test:inventory-scan` is what actually
verifies the `.csproj`/`packages.config`/`App.config`/`appsettings.json`
metrics; run it explicitly whenever you touch that part of
`scripts/codemod.ts` — see `tests/inventory-and-config-scan/README.md` for
details.

`codemod jssg test`'s directory-fixture discovery only looks one level deep
under `./tests` — a case directory needs `input.*`/`expected.*` (or
`input/`/`expected/`) directly inside it. Nesting cases one level deeper
(e.g. `tests/csharp-patterns/positive/`) makes them silently invisible to
`npm test` even though the files are valid fixtures — this happened here
once (`csharp-patterns/positive` and `.../negative` ran 0 times for a while
after the test script was broadened from a scoped path to the whole `tests/`
directory) until the directories were flattened to
`tests/csharp-patterns-positive/` and `tests/csharp-patterns-negative/`.
Keep new fixture directories flat under `tests/`.

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
