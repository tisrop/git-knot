import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateGithubRelease,
  verifyGithubReleaseSignatures,
} from "./github-release-validation.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`命令参数无效：${name ?? "<empty>"}`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(required(options, "metadata"), "utf8"));
  const assets = JSON.parse(await readFile(required(options, "assets"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(required(options, "tauri-config"), "utf8"));
  const manifest = validateGithubRelease({
    metadata,
    assets,
    repository: required(options, "repository"),
    tag: required(options, "tag"),
    version: required(options, "version"),
    portableAssetName: options["portable-asset"],
  });
  await verifyGithubReleaseSignatures({
    manifest,
    artifactsDirectory: required(options, "artifacts"),
    publicKey: tauriConfig.plugins?.updater?.pubkey,
    minisignBinary: options.minisign ?? "minisign",
  });
  const output = options.output;
  if (output) {
    await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
