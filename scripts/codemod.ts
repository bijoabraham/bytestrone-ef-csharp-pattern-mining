import type { Codemod } from "codemod:ast-grep";
import type CSharp from "codemod:ast-grep/langs/c_sharp";
import { setState, getState, acquireLock } from "codemod:workflow";

// ============================================================
// Types
// ============================================================
interface BlockerRecord {
  blockerType: string;
  file: string;
  severity: "critical" | "warning" | "info";
}

interface EntityRecord {
  entityClass: string;
  configurationClass: string;
  file: string;
  loc: number;
}

interface FileRecord {
  file: string;
  loc: number;
  efPatternCount: number;
  blockerCount: number;
}

interface ScanState {
  totalCsFiles: number;
  totalCsLoc: number;
  efRelatedCsFiles: number;
  efRelatedCsLoc: number;
  dbContextSubclassCount: number;
  objectContextUsageCount: number;
  dbSetPropertyCount: number;
  idbSetPropertyCount: number;
  entityTypeConfigurationCount: number;
  executeSqlCommandCount: number;
  executeSqlQueryCount: number;
  setInitializerCount: number;
  virtualNavPropCount: number;
  interceptorRegistrationCount: number;
  dbConfigurationClassCount: number;
  blockers: BlockerRecord[];
  entities: EntityRecord[];
  files: FileRecord[];
}

const EMPTY_STATE: ScanState = {
  totalCsFiles: 0,
  totalCsLoc: 0,
  efRelatedCsFiles: 0,
  efRelatedCsLoc: 0,
  dbContextSubclassCount: 0,
  objectContextUsageCount: 0,
  dbSetPropertyCount: 0,
  idbSetPropertyCount: 0,
  entityTypeConfigurationCount: 0,
  executeSqlCommandCount: 0,
  executeSqlQueryCount: 0,
  setInitializerCount: 0,
  virtualNavPropCount: 0,
  interceptorRegistrationCount: 0,
  dbConfigurationClassCount: 0,
  blockers: [],
  entities: [],
  files: [],
};

const STATE_KEY = "ef-csharp-scan";

// ============================================================
// AST pattern helpers
// ============================================================
function countPattern(rootNode: any, pattern: string): number {
  try {
    return rootNode.findAll({ rule: { pattern } }).length;
  } catch {
    return 0;
  }
}

function findAll(rootNode: any, pattern: string): any[] {
  try {
    return rootNode.findAll({ rule: { pattern } });
  } catch {
    return [];
  }
}

// ============================================================
// Main transform — read-only mining, always returns null
// ============================================================
const codemod: Codemod<CSharp> = async (root) => {
  const filePath = root.filename();

  if (!filePath.endsWith(".cs")) return null;

  const source = root.source();
  const loc = source
    .split("\n")
    .filter((l: string) => l.trim().length > 0 && !l.trim().startsWith("//"))
    .length;

  const rootNode = root.root();

  let fileEfPatternCount = 0;
  let fileBlockerCount = 0;
  const fileBlockers: BlockerRecord[] = [];
  const fileEntities: EntityRecord[] = [];

  // --- ObjectContext subclass ---
  const objectContextNodes = findAll(rootNode, `class $NAME : ObjectContext`);
  const objectContextCount = objectContextNodes.length;
  if (objectContextCount > 0) {
    fileBlockers.push({ blockerType: "ObjectContext subclass", file: filePath, severity: "critical" });
    fileEfPatternCount += objectContextCount;
    fileBlockerCount += objectContextCount;
  }

  // --- DbContext subclass ---
  const dbContextCount = countPattern(rootNode, `class $NAME : DbContext`);
  fileEfPatternCount += dbContextCount;

  // --- IDbSet<T> property ---
  const idbSetCount = countPattern(rootNode, `public IDbSet<$T> $PROP { get; set; }`);
  if (idbSetCount > 0) {
    fileBlockers.push({ blockerType: "IDbSet<T> property", file: filePath, severity: "warning" });
    fileEfPatternCount += idbSetCount;
    fileBlockerCount += idbSetCount;
  }

  // --- DbSet<T> property ---
  const dbSetCount = countPattern(rootNode, `public DbSet<$T> $PROP { get; set; }`);
  fileEfPatternCount += dbSetCount;

  // --- EntityTypeConfiguration<T> (EF6) ---
  const etcNodes = findAll(rootNode, `class $NAME : EntityTypeConfiguration<$T>`);
  for (const node of etcNodes) {
    const configClass = node.getMatch("NAME")?.text() ?? "Unknown";
    const entityType = node.getMatch("T")?.text() ?? "Unknown";
    fileEntities.push({ entityClass: entityType, configurationClass: configClass, file: filePath, loc });
    fileBlockers.push({ blockerType: "EntityTypeConfiguration<T>", file: filePath, severity: "warning" });
    fileEfPatternCount += 1;
    fileBlockerCount += 1;
  }

  // --- DbConfiguration subclass ---
  const dbConfigCount = countPattern(rootNode, `class $NAME : DbConfiguration`);
  if (dbConfigCount > 0) {
    fileBlockers.push({ blockerType: "DbConfiguration subclass", file: filePath, severity: "warning" });
    fileEfPatternCount += dbConfigCount;
    fileBlockerCount += dbConfigCount;
  }

  // --- Database.ExecuteSqlCommand ---
  const execSqlCount = countPattern(rootNode, `Database.ExecuteSqlCommand($$$ARGS)`);
  if (execSqlCount > 0) {
    fileBlockers.push({ blockerType: "Database.ExecuteSqlCommand", file: filePath, severity: "critical" });
    fileEfPatternCount += execSqlCount;
    fileBlockerCount += execSqlCount;
  }

  // --- Database.SqlQuery<T> ---
  const sqlQueryCount = countPattern(rootNode, `Database.SqlQuery<$T>($$$ARGS)`);
  if (sqlQueryCount > 0) {
    fileBlockers.push({ blockerType: "Database.SqlQuery<T>", file: filePath, severity: "critical" });
    fileEfPatternCount += sqlQueryCount;
    fileBlockerCount += sqlQueryCount;
  }

  // --- Database.SetInitializer ---
  const setInitCount = countPattern(rootNode, `Database.SetInitializer<$T>($$$ARGS)`);
  if (setInitCount > 0) {
    fileBlockers.push({ blockerType: "Database.SetInitializer", file: filePath, severity: "critical" });
    fileEfPatternCount += setInitCount;
    fileBlockerCount += setInitCount;
  }

  // --- Virtual navigation properties ---
  const virtualNavCount = countPattern(rootNode, `public virtual $TYPE $PROP { get; set; }`);
  fileEfPatternCount += virtualNavCount;

  // --- DbInterception.Add ---
  const interceptorCount = countPattern(rootNode, `DbInterception.Add($$$ARGS)`);
  if (interceptorCount > 0) {
    fileBlockers.push({ blockerType: "DbInterception.Add (interceptor)", file: filePath, severity: "warning" });
    fileEfPatternCount += interceptorCount;
    fileBlockerCount += interceptorCount;
  }

  // --- Merge into shared state with lock ---
  const release = await acquireLock(STATE_KEY);
  try {
    const state: ScanState = getState<ScanState>(STATE_KEY) ?? { ...EMPTY_STATE, blockers: [], entities: [], files: [] };

    state.totalCsFiles += 1;
    state.totalCsLoc += loc;
    state.objectContextUsageCount += objectContextCount;
    state.dbContextSubclassCount += dbContextCount;
    state.idbSetPropertyCount += idbSetCount;
    state.dbSetPropertyCount += dbSetCount;
    state.entityTypeConfigurationCount += etcNodes.length;
    state.dbConfigurationClassCount += dbConfigCount;
    state.executeSqlCommandCount += execSqlCount;
    state.executeSqlQueryCount += sqlQueryCount;
    state.setInitializerCount += setInitCount;
    state.virtualNavPropCount += virtualNavCount;
    state.interceptorRegistrationCount += interceptorCount;

    if (fileEfPatternCount > 0) {
      state.efRelatedCsFiles += 1;
      state.efRelatedCsLoc += loc;
    }

    state.blockers.push(...fileBlockers);
    state.entities.push(...fileEntities);
    state.files.push({ file: filePath, loc, efPatternCount: fileEfPatternCount, blockerCount: fileBlockerCount });

    setState<ScanState>(STATE_KEY, state);
  } finally {
    release();
  }

  // Mining codemod: never modify source files
  return null;
};

export default codemod;
