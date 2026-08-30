import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GUIDE_START = "<!-- git-knot-download-guide:start -->";
const GUIDE_END = "<!-- git-knot-download-guide:end -->";

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}不能为空`);
  }
}

function uniqueAsset(assets, label, predicate) {
  const matches = assets.filter(
    (asset) => typeof asset?.name === "string" && predicate(asset.name),
  );
  if (matches.length !== 1) throw new Error(`${label}无法唯一匹配 Release 资源`);
  return matches[0];
}

function optionalUniqueAsset(assets, label, predicate) {
  const matches = assets.filter(
    (asset) => typeof asset?.name === "string" && predicate(asset.name),
  );
  if (matches.length > 1) throw new Error(`${label}存在多个 Release 资源`);
  return matches[0] ?? null;
}

function assetUrl(repository, tag, asset) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
}

function downloadLink({ label, detail, repository, tag, asset }) {
  return `[${label} ${detail}](${assetUrl(repository, tag, asset)})`;
}

function stripExistingGuide(body) {
  const start = body.indexOf(GUIDE_START);
  const end = body.indexOf(GUIDE_END);
  if (start === -1 && end === -1) return body.trim();
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Release notes 中的下载引导标记不完整");
  }
  if (body.indexOf(GUIDE_START, start + GUIDE_START.length) !== -1) {
    throw new Error("Release notes 中存在多个下载引导起始标记");
  }
  if (body.indexOf(GUIDE_END, end + GUIDE_END.length) !== -1) {
    throw new Error("Release notes 中存在多个下载引导结束标记");
  }
  return `${body.slice(0, start)}${body.slice(end + GUIDE_END.length)}`.trim();
}

export function buildReleaseDownloadGuide({ body, assets, repository, tag }) {
  if (typeof body !== "string") throw new Error("Release notes 必须是字符串");
  if (!Array.isArray(assets)) throw new Error("Release assets 必须是数组");
  assertNonEmptyString(repository, "repository");
  assertNonEmptyString(tag, "tag");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository 格式无效");
  }

  const macArm = uniqueAsset(assets, "macOS Apple Silicon DMG", (name) =>
    /(?:aarch64|arm64)\.dmg$/i.test(name),
  );
  const macIntel = uniqueAsset(assets, "macOS Intel DMG", (name) =>
    /(?:x64|x86_64)\.dmg$/i.test(name),
  );
  const windowsExe = uniqueAsset(assets, "Windows EXE 安装包", (name) =>
    /(?:setup|installer).*\.exe$/i.test(name),
  );
  const windowsPortable = uniqueAsset(assets, "Windows 便携版 ZIP", (name) =>
    /_x64-portable\.zip$/i.test(name),
  );
  const windowsMsi = optionalUniqueAsset(assets, "Windows MSI", (name) => /\.msi$/i.test(name));
  const linuxAppImage = uniqueAsset(assets, "Linux AppImage", (name) => /\.AppImage$/i.test(name));
  const linuxDeb = optionalUniqueAsset(assets, "Linux DEB", (name) => /\.deb$/i.test(name));
  const linuxRpm = optionalUniqueAsset(assets, "Linux RPM", (name) => /\.rpm$/i.test(name));

  const link = (label, detail, asset) => downloadLink({ label, detail, repository, tag, asset });
  const windows = [link("EXE", "x64", windowsExe)];
  if (windowsMsi) windows.push(link("MSI", "x64", windowsMsi));
  windows.push(link("ZIP", "x64 便携版", windowsPortable));
  const linux = [link("AppImage", "x64", linuxAppImage)];
  if (linuxDeb) linux.push(link("DEB", "x64", linuxDeb));
  if (linuxRpm) linux.push(link("RPM", "x64", linuxRpm));

  const guide = [
    GUIDE_START,
    "**按设备选择下载：**",
    "",
    "| 系统 | 安装包 |",
    "| --- | --- |",
    `| macOS | ${link("DMG", "Apple Silicon", macArm)}<br>${link("DMG", "Intel", macIntel)} |`,
    `| Windows | ${windows.join("<br>")} |`,
    `| Linux | ${linux.join("<br>")} |`,
    GUIDE_END,
  ].join("\n");
  const notes = stripExistingGuide(body);
  return notes ? `${guide}\n\n${notes}\n` : `${guide}\n`;
}

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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [release, assets] = await Promise.all([
    readFile(options.release, "utf8").then(JSON.parse),
    readFile(options.assets, "utf8").then(JSON.parse),
  ]);
  const body = buildReleaseDownloadGuide({
    body: release.body ?? "",
    assets,
    repository: options.repository,
    tag: options.tag,
  });
  await writeFile(options.output, body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
