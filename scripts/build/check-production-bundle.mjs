import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProductionBundleExcludesWebMock } from "./production-bundle-policy.mjs";

async function collectJavaScriptAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await collectJavaScriptAssets(path)));
    } else if (entry.isFile() && [".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
      assets.push({ path, contents: await readFile(path, "utf8") });
    }
  }

  return assets;
}

async function main(root = process.cwd()) {
  const assets = await collectJavaScriptAssets(resolve(root, "dist"));
  assertProductionBundleExcludesWebMock(assets);
  process.stdout.write("生产 bundle 未包含 webMockBridge 演示数据\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
