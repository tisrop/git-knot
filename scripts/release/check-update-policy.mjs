import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertGitHubActionsPinned,
  assertReleaseWorkflowPermissions,
  assertUpdaterEnabled,
} from "./update-policy.mjs";

async function main(root = process.cwd()) {
  const capabilitiesDirectory = resolve(root, "src-tauri/capabilities");
  const [tauriConfig, cargoToml, packageJson, releaseWorkflow, ciWorkflow, capabilityFileNames] =
    await Promise.all([
      readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
      readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, ".github/workflows/release.yml"), "utf8"),
      readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
      readdir(capabilitiesDirectory),
    ]);
  const capabilities = await Promise.all(
    capabilityFileNames.sort().map(async (fileName) => ({
      fileName,
      config: fileName.endsWith(".json")
        ? JSON.parse(await readFile(resolve(capabilitiesDirectory, fileName), "utf8"))
        : null,
    })),
  );
  assertUpdaterEnabled({ tauriConfig, cargoToml, packageJson, capabilities });
  assertGitHubActionsPinned(releaseWorkflow);
  assertGitHubActionsPinned(ciWorkflow);
  assertReleaseWorkflowPermissions(releaseWorkflow);
  process.stdout.write("GitHub Release updater 与 CI workflow 正式配置检查通过\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
