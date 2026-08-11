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
    if (isDir) walk(full, out);
    else out.push(full);
  }
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
      } else if (/(^|[\\/])packages\.config$/.test(file)) {
        const content = readSafe(file);
        if (content) scanPackagesConfigEfVersion(content, file);
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
