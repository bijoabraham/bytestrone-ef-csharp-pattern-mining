import type { Codemod } from "codemod:ast-grep";
import type { SgRoot } from "codemod:ast-grep";
import type CSharp from "codemod:ast-grep/langs/csharp";
import { useMetricAtom } from "codemod:metrics";

type AstNode = {
  kind(): string;
  text(): string;
  isNamed(): boolean;
  range(): { start: { line: number } };
  field(name: string): AstNode | null | undefined;
  children(): AstNode[];
  getMatch(name: string): AstNode | null | undefined;
  parent(): AstNode | null | undefined;
};

function lineNumber(node: AstNode): string {
  return String(node.range().start.line + 1);
}

// --- Legacy EF6 API usage (granular, one metric per pattern) ---
const objectContextUsages = useMetricAtom("ef_objectcontext_usages");
const dbContextUsages = useMetricAtom("ef_dbcontext_usages");
const idbSetUsages = useMetricAtom("ef_idbset_usages");
const dbSetUsages = useMetricAtom("ef_dbset_usages");
const entityTypeConfigurationUsages = useMetricAtom("ef_entity_type_configuration_usages");
const dbConfigurationUsages = useMetricAtom("ef_dbconfiguration_usages");
const executeSqlCommandUsages = useMetricAtom("ef_execute_sql_command_usages");
const executeSqlQueryUsages = useMetricAtom("ef_execute_sql_query_usages");
const setInitializerUsages = useMetricAtom("ef_set_initializer_usages");
const virtualNavProps = useMetricAtom("ef_virtual_nav_props");
const dbInterceptionUsages = useMetricAtom("ef_db_interception_usages");

// --- Unified blocker rollup (one row per legacy-API hit, tagged for dashboard grouping) ---
const migrationBlocker = useMetricAtom("ef_migration_blocker");

// --- Project inventory (one row per .csproj file) ---
const totalProjects = useMetricAtom("total_projects");
const legacyCsprojCount = useMetricAtom("legacy_csproj_count");
const efVersion = useMetricAtom("ef_version");

// --- Configuration surface area (App.config/Web.config/appsettings*.json) ---
const configSurface = useMetricAtom("ef_config_surface");

// --- NuGet/GAC dependency risk (every package reference, not just EF) ---
const dependencyRisk = useMetricAtom("ef_dependency_risk");

// --- Lines of code per file (sizing signal for effort/cost formulas) ---
const locInventory = useMetricAtom("ef_loc_inventory");

// --- Summable total LOC. ef_loc_inventory's `loc` is a string cardinality
// tag (a dimension), not a numeric measure, so a dashboard SUM() over it
// sums row counts, not the tag values. This metric instead increments by
// the actual line count per file (via MetricAtom.increment's `amount`
// param), so SUM(ef_total_loc) across its rows equals the true total LOC. ---
const totalLoc = useMetricAtom("ef_total_loc");

// --- Pre-filtered high-risk dependency count. ef_dependency_risk's
// `riskTier` is also a cardinality tag, and dashboard Formula widgets need
// an IN-list filter (riskTier in {unsupported, gac, custom-binary,
// requires-upgrade}) to total "high risk" deps, which isn't reliably
// expressible there. This metric pre-applies that exact filter at emission
// time so SUM(ef_high_risk_dependency_count) gives the total directly. ---
const highRiskDependencyCount = useMetricAtom("ef_high_risk_dependency_count");

interface LineCounts {
  totalLines: number;
  nonBlankLines: number;
}

function countLines(source: string): LineCounts {
  // totalLines counts "\n" characters, matching `wc -l` exactly (not
  // source.split("\n").length, which is off by one: split() counts
  // segments, i.e. newlines + 1, for every file regardless of whether it
  // ends with a trailing newline).
  let totalLines = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") totalLines++;
  }

  let nonBlank = 0;
  for (const line of source.split("\n")) {
    if (line.trim().length > 0) nonBlank++;
  }

  return { totalLines, nonBlankLines: nonBlank };
}

type BlockerSeverity = "critical" | "warning";

function reportBlocker(blockerType: string, severity: BlockerSeverity, file: string, linenumber: string) {
  migrationBlocker.increment({ blockerType, severity, file, linenumber });
}

function isSdkStyleCsproj(content: string): boolean {
  return /<Project[^>]*\sSdk\s*=/.test(content);
}

function scanCsprojEfVersion(content: string, file: string) {
  const pkgRefRe = /<PackageReference\s+Include="(EntityFramework|Microsoft\.EntityFrameworkCore[^"]*)"\s+Version="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pkgRefRe.exec(content))) {
    efVersion.increment({ packageId: m[1], version: m[2], file, source: "PackageReference" });
  }

  // (?=[",]) anchors on exactly "EntityFramework", not related assemblies
  // like "EntityFramework.SqlServer" or "EntityFramework.SqlServerCompact".
  const refRe = /<Reference\s+Include="EntityFramework(?=[",])(?:,\s*Version=([\d.]+))?/g;
  while ((m = refRe.exec(content))) {
    efVersion.increment({ packageId: "EntityFramework", version: m[1] ?? "unknown", file, source: "AssemblyReference" });
  }
}

function scanPackagesConfigEfVersion(content: string, file: string) {
  const re = /<package\s+id="(EntityFramework)"\s+version="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    efVersion.increment({ packageId: m[1], version: m[2], file, source: "packages.config" });
  }
}

// ---------------------------------------------------------------------------
// NuGet/GAC dependency risk classification.
//
// Compatibility knowledge base adapted from the community `dotnet-nuget-
// dependency-mining` package's shared/nuget-compatibility.ts, retargeted at
// EF6-to-EF-Core-8 migrations. Kept as plain regex over raw file text rather
// than a dedicated `language: "xml"` js-ast-grep step: on this platform,
// `language: "xml"` requires the engine to dynamically fetch and register a
// tree-sitter grammar at runtime, which was observed to fail outright on
// Windows (parser registration denied by the OS) — a fragility this avoids
// entirely by never touching the XML parser.
// ---------------------------------------------------------------------------

type RiskTier = "supported" | "requires-upgrade" | "deprecated" | "unsupported" | "custom-binary" | "gac";
type RiskLevel = "low" | "medium" | "high" | "critical";
type DependencySource = "PackageReference" | "packages.config" | "AssemblyReference" | "HintPath";

interface PackageCompatibility {
  riskTier: RiskTier;
  risk: RiskLevel;
  targetVersion: string;
}

const KNOWN_PACKAGES = new Map<string, PackageCompatibility>([
  ["EntityFramework", { riskTier: "unsupported", risk: "high", targetVersion: "Microsoft.EntityFrameworkCore 8.x" }],
  ["EntityFramework.SqlServer", { riskTier: "unsupported", risk: "high", targetVersion: "Microsoft.EntityFrameworkCore.SqlServer 8.x" }],
  ["EntityFramework.SqlServerCompact", { riskTier: "unsupported", risk: "high", targetVersion: "No direct EF Core equivalent — SQL Server CE is discontinued" }],
  ["Newtonsoft.Json", { riskTier: "requires-upgrade", risk: "low", targetVersion: "13.0.3" }],
  ["Autofac", { riskTier: "requires-upgrade", risk: "low", targetVersion: "8.0.0" }],
  ["Ninject", { riskTier: "requires-upgrade", risk: "medium", targetVersion: "3.3.x (verify .NET 8 support)" }],
  ["Unity", { riskTier: "deprecated", risk: "medium", targetVersion: "Microsoft.Extensions.DependencyInjection" }],
  ["log4net", { riskTier: "deprecated", risk: "medium", targetVersion: "Serilog / Microsoft.Extensions.Logging (optional)" }],
  ["elmah", { riskTier: "deprecated", risk: "medium", targetVersion: "Microsoft.Extensions.Logging + hosted diagnostics" }],
  ["Microsoft.Owin", { riskTier: "unsupported", risk: "high", targetVersion: "ASP.NET Core middleware" }],
  ["Microsoft.Owin.Hosting", { riskTier: "unsupported", risk: "high", targetVersion: "ASP.NET Core host" }],
  ["Microsoft.AspNet.WebApi.OwinSelfHost", { riskTier: "unsupported", risk: "high", targetVersion: "ASP.NET Core host" }],
  ["Microsoft.AspNet.WebApi.Core", { riskTier: "unsupported", risk: "high", targetVersion: "Microsoft.AspNetCore.Mvc" }],
  ["Microsoft.AspNet.Mvc", { riskTier: "unsupported", risk: "high", targetVersion: "Microsoft.AspNetCore.Mvc" }],
  ["System.ServiceModel", { riskTier: "unsupported", risk: "high", targetVersion: "CoreWCF / gRPC" }],
  ["WebGrease", { riskTier: "deprecated", risk: "low", targetVersion: "Remove — bundling handled by modern build tooling" }],
]);

const FACADE_PACKAGES = new Set(["NETStandard.Library", "System.Memory", "System.Buffers", "Microsoft.NETCore.Platforms"]);

const GAC_REFERENCES = new Set(["System.Web", "System.Web.Http", "System.Web.Mvc", "System.Web.Extensions", "System.Configuration", "mscorlib"]);

// Tiers counted toward ef_high_risk_dependency_count. Excludes "supported"
// (already fine) and "deprecated" (works today, replacement is optional) —
// everything else needs action before or during the EF Core 8 migration.
const HIGH_RISK_TIERS = new Set<RiskTier>(["unsupported", "gac", "custom-binary", "requires-upgrade"]);

function classifyPackage(packageId: string, source: DependencySource): PackageCompatibility {
  // A recognized package name is more specific/actionable guidance than a
  // structural heuristic based on how it happened to be referenced, so name
  // recognition wins even if e.g. EntityFramework shows up as a bare
  // AssemblyReference or via HintPath (both common for pre-PackageReference
  // projects).
  const known = KNOWN_PACKAGES.get(packageId);
  if (known) return known;
  if (source === "AssemblyReference" || GAC_REFERENCES.has(packageId)) {
    return { riskTier: "gac", risk: "critical", targetVersion: "NuGet / ASP.NET Core equivalent" };
  }
  if (source === "HintPath") {
    return { riskTier: "custom-binary", risk: "high", targetVersion: "Review vendor SDK for .NET 8 support" };
  }
  if (FACADE_PACKAGES.has(packageId)) {
    return { riskTier: "deprecated", risk: "medium", targetVersion: "Remove (framework facade package)" };
  }
  if (packageId.startsWith("Microsoft.AspNetCore.") || packageId.startsWith("Microsoft.EntityFrameworkCore")) {
    return { riskTier: "supported", risk: "low", targetVersion: "current" };
  }
  return { riskTier: "requires-upgrade", risk: "medium", targetVersion: "Verify .NET 8 / EF Core 8 compatibility" };
}

function emitDependencyRisk(packageId: string, version: string, source: DependencySource, file: string) {
  const compat = classifyPackage(packageId, source);
  dependencyRisk.increment({
    packageId,
    version: version || "unknown",
    source,
    file,
    riskTier: compat.riskTier,
    risk: compat.risk,
    targetVersion: compat.targetVersion,
  });
  if (HIGH_RISK_TIERS.has(compat.riskTier)) {
    highRiskDependencyCount.increment({ packageId, riskTier: compat.riskTier, file });
  }
}

function scanCsprojDependencies(content: string, file: string) {
  const pkgRefRe = /<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pkgRefRe.exec(content))) {
    const packageId = m[1];
    const version = m[2];
    if (!packageId || !version) continue;
    emitDependencyRisk(packageId, version, "PackageReference", file);
  }

  // Old-style <Reference Include="Pkg, Version=X, Culture=..., PublicKeyToken=...">
  // either self-closing (bare, GAC-resolved) or wrapping a <HintPath> child
  // (a local/vendored binary). Handled as two separate, unambiguous regexes
  // rather than one pattern with a "/>|>...</Reference>" alternation: an
  // earlier version combined them behind a lazy [^>]*?, and on a large real
  // .csproj with many <Reference> entries that shape caused catastrophic
  // backtracking severe enough to hang the whole workflow (60s+ with no
  // progress). Splitting removes the ambiguity the backtracking came from —
  // each regex only ever matches its own well-defined tag shape.
  const selfClosingRefRe = /<Reference\s+Include="([^"]+)"\s*\/>/g;
  while ((m = selfClosingRefRe.exec(content))) {
    const include = m[1];
    if (!include) continue;
    emitReferenceDependency(include, "AssemblyReference", file);
  }

  const blockRefRe = /<Reference\s+Include="([^"]+)"\s*>([\s\S]*?)<\/Reference>/g;
  while ((m = blockRefRe.exec(content))) {
    const include = m[1];
    if (!include) continue;
    const inner = m[2] ?? "";
    const source: DependencySource = /<HintPath>/.test(inner) ? "HintPath" : "AssemblyReference";
    emitReferenceDependency(include, source, file);
  }
}

function emitReferenceDependency(include: string, source: DependencySource, file: string) {
  const packageId = (include.split(",")[0] ?? include).trim();
  const versionMatch = /Version=([\d.]+)/.exec(include);
  const version = versionMatch?.[1] ?? "";
  emitDependencyRisk(packageId, version, source, file);
}

function scanPackagesConfigDependencies(content: string, file: string) {
  const re = /<package\s+id="([^"]+)"\s+version="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const packageId = m[1];
    const version = m[2];
    if (!packageId || !version) continue;
    emitDependencyRisk(packageId, version, "packages.config", file);
  }
}

function scanConfigSurface(content: string, file: string) {
  const connRe = /<add\s+name="([^"]+)"[^>]*connectionString=/g;
  let m: RegExpExecArray | null;
  while ((m = connRe.exec(content))) {
    configSurface.increment({ configType: "connectionString", name: m[1], file });
  }
  if (/<entityFramework\b/.test(content)) {
    configSurface.increment({ configType: "entityFrameworkSection", name: "entityFramework", file });
  }
  if (/"ConnectionStrings"\s*:/.test(content)) {
    configSurface.increment({ configType: "appsettingsConnectionStrings", name: "ConnectionStrings", file });
  }
}

function isPackagesConfig(filepath: string): boolean {
  return /(^|[\\/])packages\.config$/i.test(filepath);
}

function isAppOrWebConfig(filepath: string): boolean {
  return /(^|[\\/])(App|Web)\.config$/.test(filepath) || /appsettings(\..+)?\.json$/.test(filepath);
}

function scanCsFile(root: SgRoot<CSharp>, filepath: string) {
  const lineCounts = countLines(root.source());
  locInventory.increment({
    file: filepath,
    loc: String(lineCounts.nonBlankLines),
    totalLines: String(lineCounts.totalLines),
  });
  totalLoc.increment({ file: filepath }, lineCounts.nonBlankLines);

  const rootNode = root.root();

  // --- ObjectContext usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^ObjectContext$" } })) {
    const ln = lineNumber(node);
    objectContextUsages.increment({ filepath, linenumber: ln, explanation: "Legacy EF6 ObjectContext usage. Migrate to EF Core DbContext." });
    reportBlocker("ObjectContext", "critical", filepath, ln);
  }

  // --- DbContext usages (already EF Core-compatible, informational only) ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbContext$" } })) {
    dbContextUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "EF DbContext usage found. Verify compatibility with EF Core." });
  }

  // --- IDbSet<T> usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^IDbSet$" } })) {
    const ln = lineNumber(node);
    idbSetUsages.increment({ filepath, linenumber: ln, explanation: "Legacy IDbSet usage. Migrate to DbSet in EF Core." });
    reportBlocker("IDbSet", "warning", filepath, ln);
  }

  // --- DbSet<T> usages (already EF Core-compatible, informational only) ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbSet$" } })) {
    dbSetUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "EF DbSet usage found. Verify compatibility with EF Core." });
  }

  // --- EntityTypeConfiguration<T> usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^EntityTypeConfiguration$" } })) {
    const ln = lineNumber(node);
    entityTypeConfigurationUsages.increment({ filepath, linenumber: ln, explanation: "Legacy EntityTypeConfiguration usage. Migrate to IEntityTypeConfiguration in EF Core." });
    reportBlocker("EntityTypeConfiguration", "warning", filepath, ln);
  }

  // --- DbConfiguration usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbConfiguration$" } })) {
    const ln = lineNumber(node);
    dbConfigurationUsages.increment({ filepath, linenumber: ln, explanation: "Legacy DbConfiguration usage. Code-based configuration must be moved to DbContext.OnConfiguring or DI." });
    reportBlocker("DbConfiguration", "critical", filepath, ln);
  }

  // --- Database.ExecuteSqlCommand ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^ExecuteSqlCommand$" } })) {
    const ln = lineNumber(node);
    executeSqlCommandUsages.increment({ filepath, linenumber: ln, explanation: "Raw SQL execution. Migrate to ExecuteSqlRaw or ExecuteSqlInterpolated in EF Core." });
    reportBlocker("ExecuteSqlCommand", "critical", filepath, ln);
  }

  // --- Database.SqlQuery<T> ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^SqlQuery$" } })) {
    const ln = lineNumber(node);
    executeSqlQueryUsages.increment({ filepath, linenumber: ln, explanation: "Raw SQL query execution. Migrate to FromSqlRaw or FromSqlInterpolated in EF Core." });
    reportBlocker("SqlQuery", "critical", filepath, ln);
  }

  // --- Database.SetInitializer ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^SetInitializer$" } })) {
    const ln = lineNumber(node);
    setInitializerUsages.increment({ filepath, linenumber: ln, explanation: "Database initializer usage. EF Core does not support Database.SetInitializer. Migrate to explicitly creating the database." });
    reportBlocker("SetInitializer", "critical", filepath, ln);
  }

  // --- Virtual navigation properties ---
  for (const node of rootNode.findAll({ rule: { kind: "modifier", regex: "^virtual$" } })) {
    if (node.parent()?.kind() === "property_declaration") {
      const ln = lineNumber(node);
      virtualNavProps.increment({ filepath, linenumber: ln, explanation: "Virtual property detected. Check if this is for lazy loading, which requires Microsoft.EntityFrameworkCore.Proxies in EF Core." });
      reportBlocker("VirtualNavigationProperty", "warning", filepath, ln);
    }
  }

  // --- DbInterception.Add ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbInterception$" } })) {
    const ln = lineNumber(node);
    dbInterceptionUsages.increment({ filepath, linenumber: ln, explanation: "Legacy DbInterception usage. Migrate to EF Core Interceptors." });
    reportBlocker("DbInterception", "critical", filepath, ln);
  }
}

// ---------------------------------------------------------------------------
// Entry point. `workflow.yaml`'s include glob matches **/*.cs *and*
// **/*.csproj / packages.config / App.config / Web.config /
// appsettings*.json under the same `language: "csharp"` step — the C#
// parser is never touched for the non-.cs files (only root.source(), the
// raw text), which is safe (verified: the engine invokes the codemod
// function per matched file regardless of whether its content parses as
// C#). This replaces an earlier design where a single lock-guarded file did
// a manual whole-repo `fs` walk to find these same files: that walk (625ms-
// 1.5s locally against a ~4,500 file repo) exceeded the hosted Insights
// platform's per-file execution budget, so total_projects/legacy_csproj_
// count/ef_version/ef_config_surface/ef_dependency_risk never got emitted
// there even though the same package worked fine via local `codemod
// workflow run`. Letting the engine's own native per-file walker invoke
// this codemod separately per config file spreads that cost across many
// small, independent invocations instead of one large blocking one.
// ---------------------------------------------------------------------------

const codemod: Codemod<CSharp> = async (root) => {
  const filepath = root.relativeFilename();

  if (filepath.endsWith(".cs")) {
    scanCsFile(root, filepath);
    return null;
  }

  const content = root.source();

  if (filepath.endsWith(".csproj")) {
    totalProjects.increment({ file: filepath });
    if (!isSdkStyleCsproj(content)) {
      legacyCsprojCount.increment({ file: filepath });
    }
    scanCsprojEfVersion(content, filepath);
    scanCsprojDependencies(content, filepath);
    return null;
  }

  if (isPackagesConfig(filepath)) {
    scanPackagesConfigEfVersion(content, filepath);
    scanPackagesConfigDependencies(content, filepath);
    return null;
  }

  if (isAppOrWebConfig(filepath)) {
    scanConfigSurface(content, filepath);
    return null;
  }

  return null;
};

export default codemod;
