import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cargoPackageVersion, validateVersionConsistency } from "./version-consistency.mjs";

function parseArguments(argv) {
  const argumentsWithoutSeparator = argv[0] === "--" ? argv.slice(1) : argv;
  if (argumentsWithoutSeparator.length === 0) return {};
  if (
    argumentsWithoutSeparator.length === 2 &&
    argumentsWithoutSeparator[0] === "--tag" &&
    argumentsWithoutSeparator[1]
  ) {
    return { tag: argumentsWithoutSeparator[1] };
  }
  throw new Error("用法：check-version-consistency.mjs [--tag vX.Y.Z]");
}

async function main(root = process.cwd()) {
  const options = parseArguments(process.argv.slice(2));
  const [packageJson, cargoToml, tauriConfig] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8").then(JSON.parse),
  ]);
  const version = validateVersionConsistency({
    packageVersion: packageJson.version,
    cargoVersion: cargoPackageVersion(cargoToml),
    tauriVersion: tauriConfig.version,
    tag: options.tag,
  });
  process.stdout.write(`应用版本一致：${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
