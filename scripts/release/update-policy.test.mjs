import { describe, expect, it } from "vitest";
import {
  assertDesktopSecurityPolicy,
  assertGitHubActionsPinned,
  assertReleaseWorkflowPermissions,
  assertUpdaterEnabled,
  DESKTOP_CAPABILITY_PERMISSIONS,
  DESKTOP_CSP,
  DESKTOP_DEV_CSP,
  UPDATER_ENDPOINT,
  UPDATER_PUBLIC_KEY,
} from "./update-policy.mjs";

function validInput() {
  return {
    tauriConfig: {
      app: { security: { csp: DESKTOP_CSP, devCsp: DESKTOP_DEV_CSP } },
      bundle: { active: true, createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: UPDATER_PUBLIC_KEY, endpoints: [UPDATER_ENDPOINT] } },
    },
    cargoToml: '[dependencies]\ntauri = "2"\ntauri-plugin-updater = "2.10.1"\n',
    packageJson: { dependencies: { "@tauri-apps/api": "2" } },
    capabilities: [
      {
        fileName: "default.json",
        config: {
          identifier: "default",
          windows: ["main"],
          permissions: [...DESKTOP_CAPABILITY_PERMISSIONS],
        },
      },
    ],
  };
}

describe("Tauri desktop security policy", () => {
  it("accepts the exact main-window capability and CSP", () => {
    const { tauriConfig, capabilities } = validInput();
    expect(() => assertDesktopSecurityPolicy({ tauriConfig, capabilities })).not.toThrow();
  });

  it("forbids unsafe inline production styles and locks navigation sinks", () => {
    expect(DESKTOP_CSP).not.toContain("'unsafe-inline'");
    expect(DESKTOP_CSP).toContain("style-src 'self'");
    expect(DESKTOP_CSP).toContain("frame-ancestors 'none'");
    expect(DESKTOP_CSP).toContain("form-action 'none'");
    expect(DESKTOP_DEV_CSP).toContain("'nonce-git-knot-vite-dev'");
    expect(DESKTOP_DEV_CSP).not.toContain("'unsafe-inline'");
  });

  it("rejects capability permission additions, removals and extra files", () => {
    const input = validInput();
    expect(() =>
      assertDesktopSecurityPolicy({
        tauriConfig: input.tauriConfig,
        capabilities: [
          {
            ...input.capabilities[0],
            config: {
              ...input.capabilities[0].config,
              permissions: [...DESKTOP_CAPABILITY_PERMISSIONS, "shell:allow-execute"],
            },
          },
        ],
      }),
    ).toThrow("权限必须恰为");
    expect(() =>
      assertDesktopSecurityPolicy({
        tauriConfig: input.tauriConfig,
        capabilities: [
          {
            ...input.capabilities[0],
            config: { ...input.capabilities[0].config, permissions: ["core:default"] },
          },
        ],
      }),
    ).toThrow("权限必须恰为");
    expect(() =>
      assertDesktopSecurityPolicy({
        tauriConfig: input.tauriConfig,
        capabilities: [...input.capabilities, input.capabilities[0]],
      }),
    ).toThrow("只能存在一个");
  });

  it("rejects CSP relaxation and additional security fields", () => {
    const input = validInput();
    expect(() =>
      assertDesktopSecurityPolicy({
        capabilities: input.capabilities,
        tauriConfig: {
          ...input.tauriConfig,
          app: {
            security: {
              csp: `${DESKTOP_CSP} script-src 'unsafe-eval'`,
              devCsp: DESKTOP_DEV_CSP,
            },
          },
        },
      }),
    ).toThrow("CSP 基线");
    expect(() =>
      assertDesktopSecurityPolicy({
        capabilities: input.capabilities,
        tauriConfig: {
          ...input.tauriConfig,
          app: {
            security: {
              csp: DESKTOP_CSP,
              devCsp: DESKTOP_DEV_CSP,
              freezePrototype: false,
            },
          },
        },
      }),
    ).toThrow("CSP 基线");
  });
});

describe("GitHub Release updater policy", () => {
  it("accepts the exact signed GitHub Release configuration", () => {
    expect(() => assertUpdaterEnabled(validInput())).not.toThrow();
  });

  it("rejects disabled bundles and incomplete updater configuration", () => {
    expect(() =>
      assertUpdaterEnabled({
        ...validInput(),
        tauriConfig: {
          ...validInput().tauriConfig,
          bundle: { active: false, createUpdaterArtifacts: true },
        },
      }),
    ).toThrow("bundle.active");
    expect(() =>
      assertUpdaterEnabled({
        ...validInput(),
        tauriConfig: {
          ...validInput().tauriConfig,
          bundle: { active: true, createUpdaterArtifacts: true },
          plugins: undefined,
        },
      }),
    ).toThrow("正式配置");
  });

  it("rejects wrong keys, endpoints and direct frontend updater access", () => {
    expect(() =>
      assertUpdaterEnabled({
        ...validInput(),
        tauriConfig: {
          ...validInput().tauriConfig,
          plugins: { updater: { pubkey: "wrong", endpoints: [UPDATER_ENDPOINT] } },
        },
      }),
    ).toThrow("正式签名公钥");
    expect(() =>
      assertUpdaterEnabled({
        ...validInput(),
        tauriConfig: {
          ...validInput().tauriConfig,
          plugins: {
            updater: {
              pubkey: UPDATER_PUBLIC_KEY,
              endpoints: ["https://github.com/other/git-knot/releases/latest/download/latest.json"],
            },
          },
        },
      }),
    ).toThrow("GitHub Releases");
    expect(() =>
      assertUpdaterEnabled({
        ...validInput(),
        packageJson: {
          dependencies: {
            "@tauri-apps/api": "2",
            "@tauri-apps/plugin-updater": "2",
          },
        },
      }),
    ).toThrow("不能直接依赖");
  });
});

describe("GitHub Actions supply-chain policy", () => {
  it("accepts remote actions pinned to full commit SHAs", () => {
    expect(() =>
      assertGitHubActionsPinned(`
steps:
  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  - uses: ./local-action
  - uses: docker://alpine:3.22
`),
    ).not.toThrow();
  });

  it("rejects mutable action tags and branches", () => {
    expect(() =>
      assertGitHubActionsPinned(`
steps:
  - uses: actions/checkout@v4
  - uses: dtolnay/rust-toolchain@stable
`),
    ).toThrow("完整 commit SHA");
  });
});

describe("GitHub Actions release permissions policy", () => {
  const leastPrivilegeWorkflow = `
permissions:
  contents: read
jobs:
  validate:
    permissions:
      contents: read
  build:
    permissions:
      contents: write
  verify-and-publish:
    permissions:
      contents: write
`;

  it("accepts read-only validation and job-scoped release writes", () => {
    expect(() => assertReleaseWorkflowPermissions(leastPrivilegeWorkflow)).not.toThrow();
  });

  it("rejects workflow-wide write access", () => {
    expect(() =>
      assertReleaseWorkflowPermissions(
        leastPrivilegeWorkflow.replace("contents: read", "contents: write"),
      ),
    ).toThrow("workflow 级");
  });

  it("rejects validate write access and missing publisher write access", () => {
    expect(() =>
      assertReleaseWorkflowPermissions(
        leastPrivilegeWorkflow.replace(
          "validate:\n    permissions:\n      contents: read",
          "validate:\n    permissions:\n      contents: write",
        ),
      ),
    ).toThrow("validate");
    expect(() =>
      assertReleaseWorkflowPermissions(
        leastPrivilegeWorkflow.replace(
          "verify-and-publish:\n    permissions:\n      contents: write",
          "verify-and-publish:\n    permissions:\n      contents: read",
        ),
      ),
    ).toThrow("verify-and-publish");
  });
});
