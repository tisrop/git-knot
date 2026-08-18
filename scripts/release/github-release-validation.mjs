import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
];

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}不能为空`);
  }
}

function decodeCanonicalBase64(value, label) {
  assertNonEmptyString(value, label);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label}不是有效的 Base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label}不是规范的 Base64`);
  }
  return decoded;
}

function assertPlatformName(platform) {
  assertNonEmptyString(platform, "updater 平台");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(platform)) {
    throw new Error(`updater 平台名称无效：${platform}`);
  }
}

function assertRepository(repository) {
  assertNonEmptyString(repository, "GitHub 仓库");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GitHub 仓库必须是 owner/repository 格式");
  }
}

function assertReleaseTag(tag) {
  assertNonEmptyString(tag, "Release Tag");
  if (tag.includes("/") || tag === "." || tag === "..") {
    throw new Error("Release Tag 不能包含路径分隔符");
  }
}

export function expectedReleaseAssetUrl(repository, tag, assetName) {
  assertRepository(repository);
  assertReleaseTag(tag);
  assertNonEmptyString(assetName, "Release 资源名称");
  if (basename(assetName) !== assetName || assetName.includes("\\") || assetName.includes("/")) {
    throw new Error("Release 资源名称不能包含路径分隔符");
  }
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function assetNameFromReleaseUrl(url, repository, tag, label = "Release 资源") {
  assertNonEmptyString(url, `${label}地址`);
  const expectedPrefix = `/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}地址无效`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(expectedPrefix)
  ) {
    throw new Error(`${label}必须指向当前 GitHub 仓库的当前 Tag`);
  }

  const encodedName = parsed.pathname.slice(expectedPrefix.length);
  if (!encodedName || encodedName.includes("/")) {
    throw new Error(`${label}资源文件名无效`);
  }

  let assetName;
  try {
    assetName = decodeURIComponent(encodedName);
  } catch {
    throw new Error(`${label}资源文件名编码无效`);
  }
  if (basename(assetName) !== assetName || assetName.includes("\\") || assetName.includes("/")) {
    throw new Error(`${label}资源文件名不安全`);
  }
  if (url !== expectedReleaseAssetUrl(repository, tag, assetName)) {
    throw new Error(`${label}地址不是规范的 GitHub Release 下载地址`);
  }
  return assetName;
}

function assetCounts(assets) {
  if (!Array.isArray(assets)) {
    throw new Error("Release 资源列表无效");
  }
  const counts = new Map();
  for (const asset of assets) {
    assertNonEmptyString(asset?.name, "Release 资源名称");
    counts.set(asset.name, (counts.get(asset.name) ?? 0) + 1);
  }
  return counts;
}

function assertVersionAndTag(version, tag) {
  assertNonEmptyString(version, "应用版本");
  assertReleaseTag(tag);
  if (tag !== `v${version}`) {
    throw new Error(`Release Tag 必须是 v${version}，实际为 ${tag}`);
  }
}

/**
 * Validate a Tauri updater latest.json against a GitHub Release asset listing.
 *
 * Repository, tag and asset inventory remain explicit release-time inputs so CI
 * validates the exact draft Release before publishing it.
 */
export function validateGithubRelease({
  metadata,
  assets,
  repository,
  tag,
  version,
  requiredPlatforms = DEFAULT_REQUIRED_PLATFORMS,
  portableAssetName,
}) {
  assertRepository(repository);
  assertVersionAndTag(version, tag);
  if (!metadata || typeof metadata !== "object") {
    throw new Error("latest.json 内容无效");
  }
  if (metadata.version !== version) {
    throw new Error(`latest.json 版本必须为 ${version}`);
  }
  if (typeof metadata.pub_date !== "string" || Number.isNaN(Date.parse(metadata.pub_date))) {
    throw new Error("latest.json 的 pub_date 无效");
  }

  const counts = assetCounts(assets);
  const required = Array.isArray(requiredPlatforms) ? requiredPlatforms : [];
  if (required.length === 0) {
    throw new Error("必须至少校验一个 updater 平台");
  }
  for (const platform of required) assertPlatformName(platform);
  if (new Set(required).size !== required.length) {
    throw new Error("requiredPlatforms 不能包含重复平台");
  }
  if (
    !metadata.platforms ||
    typeof metadata.platforms !== "object" ||
    Array.isArray(metadata.platforms)
  ) {
    throw new Error("latest.json 的 platforms 无效");
  }
  const metadataPlatforms = Object.keys(metadata.platforms);
  if (metadataPlatforms.length === 0) {
    throw new Error("latest.json 不包含 updater 平台");
  }
  for (const platform of required) {
    if (!Object.hasOwn(metadata.platforms, platform)) {
      throw new Error(`latest.json 缺少平台条目：${platform}`);
    }
  }

  const seenAssets = new Map();
  const updaterAssets = [];
  for (const platform of metadataPlatforms) {
    assertPlatformName(platform);
    const entry = metadata.platforms[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`latest.json 平台条目无效：${platform}`);
    }
    const signature = entry.signature;
    decodeCanonicalBase64(signature, `${platform} updater 签名`);
    const assetName = assetNameFromReleaseUrl(entry.url, repository, tag, platform);
    if (counts.get(assetName) !== 1) {
      throw new Error(`${platform} 无法唯一匹配当前 Release 资源：${assetName}`);
    }
    const existingSignature = seenAssets.get(assetName);
    if (existingSignature !== undefined && existingSignature !== signature) {
      throw new Error(`同一 updater 资源使用了不同签名：${assetName}`);
    }
    seenAssets.set(assetName, signature);
    updaterAssets.push({ platform, assetName, signature });
  }

  let portable;
  if (portableAssetName !== undefined) {
    assertNonEmptyString(portableAssetName, "Windows 便携版资源名称");
    portable = metadata.portable?.["windows-x86_64"];
    if (!portable || typeof portable !== "object") {
      throw new Error("latest.json 缺少 Windows 便携版条目");
    }
    const actualName = assetNameFromReleaseUrl(portable.url, repository, tag, "Windows 便携版");
    if (actualName !== portableAssetName || counts.get(actualName) !== 1) {
      throw new Error(`Windows 便携版资源无法唯一匹配：${portableAssetName}`);
    }
    portable = { assetName: actualName };
  } else if (metadata.portable?.["windows-x86_64"]) {
    const actualName = assetNameFromReleaseUrl(
      metadata.portable["windows-x86_64"].url,
      repository,
      tag,
      "Windows 便携版",
    );
    if (counts.get(actualName) !== 1) {
      throw new Error(`Windows 便携版资源无法唯一匹配：${actualName}`);
    }
    portable = { assetName: actualName };
  }

  return {
    repository,
    tag,
    version,
    updaterAssets,
    portableAsset: portable?.assetName ?? null,
  };
}

export function minisignVerificationArguments({ artifactPath, publicKeyPath, signaturePath }) {
  return ["-V", "-H", "-q", "-p", publicKeyPath, "-m", artifactPath, "-x", signaturePath];
}

function runMinisignVerification({ artifactPath, publicKeyPath, signaturePath, minisignBinary }) {
  const result = spawnSync(
    minisignBinary,
    minisignVerificationArguments({ artifactPath, publicKeyPath, signaturePath }),
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`未找到 minisign 可执行文件：${minisignBinary}`);
    }
    throw new Error("无法启动 minisign 验签");
  }
  if (result.status !== 0) {
    throw new Error("minisign 拒绝该签名");
  }
}

export async function verifyGithubReleaseSignatures({
  manifest,
  artifactsDirectory,
  publicKey,
  minisignBinary = "minisign",
  verifier = runMinisignVerification,
}) {
  if (!manifest || !Array.isArray(manifest.updaterAssets) || manifest.updaterAssets.length === 0) {
    throw new Error("缺少待验签的 updater 资源清单");
  }
  assertNonEmptyString(artifactsDirectory, "Updater 资源目录");
  const publicKeyBytes = decodeCanonicalBase64(publicKey, "Tauri updater 公钥");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "git-knot-release-signatures-"));
  const publicKeyPath = join(temporaryDirectory, "git-knot.pub");
  const verified = new Set();

  try {
    await writeFile(publicKeyPath, publicKeyBytes, { mode: 0o600 });
    for (const [index, updater] of manifest.updaterAssets.entries()) {
      assertPlatformName(updater?.platform);
      assertNonEmptyString(updater?.assetName, `${updater.platform} updater 资源名称`);
      if (basename(updater.assetName) !== updater.assetName) {
        throw new Error(`${updater.platform} updater 资源名称不安全`);
      }
      const verificationKey = `${updater.assetName}\0${updater.signature}`;
      if (verified.has(verificationKey)) continue;

      const artifactPath = resolve(artifactsDirectory, updater.assetName);
      const artifact = await stat(artifactPath).catch(() => null);
      if (!artifact?.isFile()) {
        throw new Error(`${updater.platform} updater 资源未下载：${updater.assetName}`);
      }
      const signaturePath = join(temporaryDirectory, `${index}.minisig`);
      await writeFile(
        signaturePath,
        decodeCanonicalBase64(updater.signature, `${updater.platform} updater 签名`),
        { mode: 0o600 },
      );
      try {
        await verifier({ artifactPath, publicKeyPath, signaturePath, minisignBinary });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${updater.platform} updater 签名密码学校验失败：${reason}`);
      }
      verified.add(verificationKey);
    }
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export { DEFAULT_REQUIRED_PLATFORMS };
