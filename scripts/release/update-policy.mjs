export const GITHUB_REPOSITORY = "tisrop/git-knot";
export const UPDATER_ENDPOINT =
  "https://github.com/tisrop/git-knot/releases/latest/download/latest.json";
export const UPDATER_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNENTIzMjVFNEVCQTYyQjcKUldTM1lycE9YakpTUFQxaHoxSjNvUkFaZklBZlRHTUJQM0JIL1lxbUkyeElmdzJjWnVyWXVtd3YK";

export const DESKTOP_CSP =
  "default-src 'self' ipc: http://ipc.localhost; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data:; font-src 'self' data:";
export const DESKTOP_DEV_CSP =
  "default-src 'self' ipc: http://ipc.localhost; script-src 'self'; style-src 'self' 'nonce-git-knot-vite-dev'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data:; font-src 'self' data:";
export const DESKTOP_CAPABILITY_PERMISSIONS = ["core:default", "dialog:allow-open"];

function exactStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

export function assertDesktopSecurityPolicy({ tauriConfig, capabilities }) {
  const security = tauriConfig?.app?.security;
  if (
    !security ||
    typeof security !== "object" ||
    Array.isArray(security) ||
    Object.keys(security).length !== 2 ||
    security.csp !== DESKTOP_CSP ||
    security.devCsp !== DESKTOP_DEV_CSP
  ) {
    throw new Error("Tauri app.security 必须保持 git-knot 的精确生产与开发 CSP 基线");
  }

  if (!Array.isArray(capabilities) || capabilities.length !== 1) {
    throw new Error("必须且只能存在一个 git-knot 桌面 capability");
  }
  const [entry] = capabilities;
  const capability = entry?.config;
  if (entry?.fileName !== "default.json" || !capability || typeof capability !== "object") {
    throw new Error("桌面 capability 必须是 capabilities/default.json");
  }
  if (capability.identifier !== "default") {
    throw new Error("桌面 capability identifier 必须为 default");
  }
  if (!exactStringSet(capability.windows, ["main"])) {
    throw new Error('桌面 capability 只能绑定窗口 ["main"]');
  }
  if (!exactStringSet(capability.permissions, DESKTOP_CAPABILITY_PERMISSIONS)) {
    throw new Error(
      `桌面 capability 权限必须恰为 ${JSON.stringify(DESKTOP_CAPABILITY_PERMISSIONS)}`,
    );
  }
}

export function assertUpdaterEnabled({ tauriConfig, cargoToml, packageJson, capabilities }) {
  if (!tauriConfig || typeof tauriConfig !== "object") {
    throw new Error("Tauri 配置无效");
  }
  assertDesktopSecurityPolicy({ tauriConfig, capabilities });
  if (tauriConfig.bundle?.active !== true) {
    throw new Error("GitHub Release 更新已启用，bundle.active 必须为 true");
  }
  if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
    throw new Error("必须生成 Tauri updater artifacts");
  }

  const updater = tauriConfig.plugins?.updater;
  if (!updater || typeof updater !== "object") {
    throw new Error("缺少 plugins.updater 正式配置");
  }
  if (updater.pubkey !== UPDATER_PUBLIC_KEY) {
    throw new Error("updater 公钥与 git-knot 正式签名公钥不一致");
  }
  if (
    !Array.isArray(updater.endpoints) ||
    updater.endpoints.length !== 1 ||
    updater.endpoints[0] !== UPDATER_ENDPOINT
  ) {
    throw new Error("updater endpoint 必须唯一指向 tisrop/git-knot GitHub Releases");
  }
  if (!/^\s*tauri-plugin-updater\s*=\s*"2(?:\.[^"]*)?"/m.test(cargoToml ?? "")) {
    throw new Error("Rust 端必须依赖 Tauri 2 updater 插件");
  }

  const frontendDependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
    ...packageJson?.optionalDependencies,
  };
  if (frontendDependencies["@tauri-apps/plugin-updater"] !== undefined) {
    throw new Error("更新能力由 Rust 命令封装，前端不能直接依赖 updater 插件");
  }

  const serializedConfig = JSON.stringify(tauriConfig).toLowerCase();
  if (serializedConfig.includes("gitee.com")) {
    throw new Error("应用更新配置不能包含 Gitee 地址");
  }
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function assertGitHubActionsPinned(workflow) {
  const unpinned = [];
  for (const line of String(workflow ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)(?:\s+#.*)?$/);
    if (!match) continue;
    const action = match[1];
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    const separator = action.lastIndexOf("@");
    const reference = separator >= 0 ? action.slice(separator + 1) : "";
    if (!FULL_COMMIT_SHA.test(reference)) unpinned.push(action);
  }
  if (unpinned.length > 0) {
    throw new Error(`GitHub Actions 必须固定到完整 commit SHA：${unpinned.join("、")}`);
  }
}

function workflowLevelContentsPermission(workflow) {
  const lines = String(workflow ?? "").split(/\r?\n/);
  const permissionsIndex = lines.findIndex((line) => line === "permissions:");
  if (permissionsIndex < 0) return null;
  for (let index = permissionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(" ")) break;
    const match = line.match(/^  contents:\s*(\w+)\s*$/);
    if (match) return match[1];
  }
  return null;
}

function jobContentsPermission(workflow, jobName) {
  const lines = String(workflow ?? "").split(/\r?\n/);
  const escapedJobName = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jobPattern = new RegExp(`^  ${escapedJobName}:\\s*$`);
  const jobIndex = lines.findIndex((line) => jobPattern.test(line));
  if (jobIndex < 0) return null;

  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [^ ]/.test(line)) break;
    if (line !== "    permissions:") continue;
    for (let permissionIndex = index + 1; permissionIndex < lines.length; permissionIndex += 1) {
      const permissionLine = lines[permissionIndex];
      if (permissionLine && !permissionLine.startsWith("      ")) break;
      const match = permissionLine.match(/^      contents:\s*(\w+)\s*$/);
      if (match) return match[1];
    }
    return null;
  }
  return null;
}

export function assertReleaseWorkflowPermissions(workflow) {
  if (workflowLevelContentsPermission(workflow) === "write") {
    throw new Error("Release workflow 不能在 workflow 级授予 contents: write");
  }

  const expectedPermissions = [
    ["validate", "read"],
    ["build", "write"],
    ["verify-and-publish", "write"],
  ];
  for (const [jobName, expected] of expectedPermissions) {
    const actual = jobContentsPermission(workflow, jobName);
    if (actual !== expected) {
      throw new Error(`Release job ${jobName} 必须设置 contents: ${expected}`);
    }
  }
}
