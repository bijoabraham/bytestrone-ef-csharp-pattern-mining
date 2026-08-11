import type { Codemod } from "codemod:ast-grep";
import type CSharp from "codemod:ast-grep/langs/csharp";
import { useMetricAtom } from "codemod:metrics";
import { acquireLock, getState, setState } from "codemod:workflow";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

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

// --- Project inventory (emitted once per repo scan, not per .cs file) ---
const totalProjects = useMetricAtom("total_projects");
const legacyCsprojCount = useMetricAtom("legacy_csproj_count");
const efVersion = useMetricAtom("ef_version");

// --- Configuration surface area (App.config/Web.config/appsettings*.json) ---
const configSurface = useMetricAtom("ef_config_surface");

// --- NuGet/GAC dependency risk (every package reference, not just EF) ---
const dependencyRisk = useMetricAtom("ef_dependency_risk");

type BlockerSeverity = "critical" | "warning";

function reportBlocker(blockerType: string, severity: BlockerSeverity, file: string, linenumber: string) {
  migrationBlocker.increment({ blockerType, severity, file, linenumber });
}

// ---------------------------------------------------------------------------
// Project inventory + configuration-surface scan.
//
// This runs against the whole target directory via plain `fs`, independent of
// the per-.cs-file AST walk below. It only needs to happen once per workflow
// run, so the first file invocation to grab the "ef-inventory-scan" lock does
// the scan; every other (possibly parallel) file invocation is a no-op here.
// See jssg-runtime-capabilities docs: codemod:metrics has no cross-step or
// "after all files" hook, so this must stay inside the single js-ast-grep
// step rather than a separate `run:` step.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", "build", ".git", "packages", "TestResults"]);

function walk(dir: string, out: string[]) {
  // Deliberately NOT readdirSync(dir, { withFileTypes: true }): that works
  // fine under local `codemod workflow run`, but on the hosted Insights
  // platform's runtime, Dirent.name came back `undefined`, which crashed
  // join(dir, entry.name) with "Error converting from js 'undefined' into
  // type 'string'" and failed 100% of files. Plain readdirSync + statSync
  // is slower but is the version actually verified working on both
  // local and hosted runtimes.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(full, out);
    } else if (isRelevantInventoryFile(entry)) {
      out.push(full);
    }
  }
}

function isRelevantInventoryFile(name: string): boolean {
  if (name.endsWith(".csproj")) return true;
  if (name.toLowerCase() === "packages.config") return true;
  if (name === "App.config" || name === "Web.config") return true;
  if (/^appsettings(\..+)?\.json$/.test(name)) return true;
  return false;
}

function readSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
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
// EF6-to-EF-Core-8 migrations. Kept as plain regex over raw file text (like
// the rest of this file's inventory scan) rather than a dedicated `language:
// "xml"` js-ast-grep step: on this platform, `language: "xml"` requires the
// engine to dynamically fetch and register a tree-sitter grammar at runtime,
// which was observed to fail outright on Windows (parser registration denied
// by the OS) — a fragility this avoids entirely by never touching the XML
// parser.
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

function scanInventoryOnce() {
  // Fast path, no lock: once the scan has finished, every later file sees
  // this immediately and returns without ever touching acquireLock (which
  // would otherwise block it for the full duration of someone else's scan).
  // Only files that start concurrently with the very first one still race
  // for the lock below — that's an unavoidable minimum, not something this
  // check can eliminate.
  if (getState<boolean>("efInventoryScanned")) return;

  const release = acquireLock("ef-inventory-scan");
  try {
    if (getState<boolean>("efInventoryScanned")) return;
    setState("efInventoryScanned", true);

    const files: string[] = [];
    walk(".", files);

    for (const file of files) {
      if (file.endsWith(".csproj")) {
        totalProjects.increment({ file });
        const content = readSafe(file);
        if (!content) continue;
        if (!isSdkStyleCsproj(content)) {
          legacyCsprojCount.increment({ file });
        }
        scanCsprojEfVersion(content, file);
        scanCsprojDependencies(content, file);
      } else if (/(^|[\\/])packages\.config$/.test(file)) {
        const content = readSafe(file);
        if (content) {
          scanPackagesConfigEfVersion(content, file);
          scanPackagesConfigDependencies(content, file);
        }
      } else if (/(^|[\\/])(App|Web)\.config$/.test(file) || /appsettings(\..+)?\.json$/.test(file)) {
        const content = readSafe(file);
        if (content) scanConfigSurface(content, file);
      }
    }
  } finally {
    release();
  }
}

const codemod: Codemod<CSharp> = async (root) => {
  scanInventoryOnce();

  const filepath = root.relativeFilename();
  if (!filepath.endsWith(".cs")) return null;

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

  return null;
};

export default codemod;
