// Integration smoke test for the project-inventory / config-surface scan.
//
// `codemod jssg test` sandboxes each fixture file in isolation (readdirSync
// sees no siblings), so it cannot exercise the whole-directory `fs` walk in
// scanInventoryOnce(). That walk only runs for real inside a genuine
// `codemod workflow run`, so this script drives one against the
// inventory-and-config-scan fixture and asserts the metrics it must produce.
// See tests/inventory-and-config-scan/README.md for the full explanation.

import { execFileSync } from "node:child_process";

const output = execFileSync(
  "npx",
  [
    "codemod",
    "workflow",
    "run",
    "--workflow",
    "workflow.yaml",
    "--target",
    "./tests/inventory-and-config-scan/input",
    "--dry-run",
    "--allow-fs",
    "--allow-dirty",
    "--no-interactive",
    "--format",
    "text",
  ],
  { encoding: "utf-8", shell: true },
);

const required = [
  "total_projects:",
  "legacy_csproj_count:",
  "ef_version:",
  "ef_config_surface:",
  "ef_dependency_risk:",
  "packageId=EntityFramework",
  "configType=connectionString",
  "configType=entityFrameworkSection",
  "configType=appsettingsConnectionStrings",
  // PackageReference/AssemblyReference/HintPath/packages.config sources,
  // and every risk tier, all represented in the fixture:
  "riskTier=unsupported",
  "riskTier=gac",
  "riskTier=custom-binary",
  "riskTier=requires-upgrade",
  "riskTier=deprecated",
  "packageId=System.Web",
  "packageId=Acme.Internal.Sdk",
  "packageId=Newtonsoft.Json",
  "packageId=log4net",
];

const missing = required.filter((needle) => !output.includes(needle));

if (missing.length > 0) {
  console.error("Inventory scan smoke test FAILED. Missing expected metric output:");
  for (const needle of missing) console.error(`  - ${needle}`);
  console.error("\nFull output:\n" + output);
  process.exit(1);
}

console.log("Inventory scan smoke test passed: all expected metrics present.");
