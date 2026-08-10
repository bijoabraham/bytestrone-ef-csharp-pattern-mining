import type { Codemod } from "codemod:ast-grep";
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
};

function lineNumber(node: AstNode): string {
  return String(node.range().start.line + 1);
}

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

function findAll(rootNode: any, pattern: string): AstNode[] {
  try {
    return rootNode.findAll({ rule: { pattern } }) as AstNode[];
  } catch {
    return [];
  }
}

const codemod: Codemod<CSharp> = async (root) => {
  const rootNode = root.root();
  const filepath = root.relativeFilename();

  if (!filepath.endsWith(".cs")) return null;

  // --- ObjectContext usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^ObjectContext$" } })) {
    objectContextUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Legacy EF6 ObjectContext usage. Migrate to EF Core DbContext." });
  }

  // --- DbContext usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbContext$" } })) {
    dbContextUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "EF DbContext usage found. Verify compatibility with EF Core." });
  }

  // --- IDbSet<T> usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^IDbSet$" } })) {
    idbSetUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Legacy IDbSet usage. Migrate to DbSet in EF Core." });
  }

  // --- DbSet<T> usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbSet$" } })) {
    dbSetUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "EF DbSet usage found. Verify compatibility with EF Core." });
  }

  // --- EntityTypeConfiguration<T> usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^EntityTypeConfiguration$" } })) {
    entityTypeConfigurationUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Legacy EntityTypeConfiguration usage. Migrate to IEntityTypeConfiguration in EF Core." });
  }

  // --- DbConfiguration usages ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbConfiguration$" } })) {
    dbConfigurationUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Legacy DbConfiguration usage. Code-based configuration must be moved to DbContext.OnConfiguring or DI." });
  }

  // --- Database.ExecuteSqlCommand ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^ExecuteSqlCommand$" } })) {
    executeSqlCommandUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Raw SQL execution. Migrate to ExecuteSqlRaw or ExecuteSqlInterpolated in EF Core." });
  }

  // --- Database.SqlQuery<T> ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^SqlQuery$" } })) {
    executeSqlQueryUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Raw SQL query execution. Migrate to FromSqlRaw or FromSqlInterpolated in EF Core." });
  }

  // --- Database.SetInitializer ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^SetInitializer$" } })) {
    setInitializerUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Database initializer usage. EF Core does not support Database.SetInitializer. Migrate to explicitly creating the database." });
  }

  // --- Virtual navigation properties ---
  for (const node of rootNode.findAll({ rule: { kind: "modifier", regex: "^virtual$" } })) {
    // Only count if it's within a property declaration
    if (node.parent()?.kind() === "property_declaration") {
      virtualNavProps.increment({ filepath, linenumber: lineNumber(node), explanation: "Virtual property detected. Check if this is for lazy loading, which requires Microsoft.EntityFrameworkCore.Proxies in EF Core." });
    }
  }

  // --- DbInterception.Add ---
  for (const node of rootNode.findAll({ rule: { kind: "identifier", regex: "^DbInterception$" } })) {
    dbInterceptionUsages.increment({ filepath, linenumber: lineNumber(node), explanation: "Legacy DbInterception usage. Migrate to EF Core Interceptors." });
  }

  return null;
};

export default codemod;
