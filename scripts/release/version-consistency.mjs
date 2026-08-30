export function validateVersionConsistency({ packageVersion, cargoVersion, tauriVersion, tag }) {
  const versions = [packageVersion, cargoVersion, tauriVersion];
  if (versions.some((version) => typeof version !== "string" || version.length === 0)) {
    throw new Error("应用 manifest 版本不能为空");
  }
  if (new Set(versions).size !== 1) {
    throw new Error(
      `应用版本不一致：package.json=${packageVersion}, Cargo.toml=${cargoVersion}, tauri.conf.json=${tauriVersion}`,
    );
  }
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    throw new Error(`Release Tag 必须是 v${packageVersion}，实际为 ${tag}`);
  }
  return packageVersion;
}

export function cargoPackageVersion(cargoToml) {
  const packageSection =
    String(cargoToml).match(/^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
}
