import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetNameFromReleaseUrl,
  expectedReleaseAssetUrl,
  minisignVerificationArguments,
  validateGithubRelease,
  verifyGithubReleaseSignatures,
} from "./github-release-validation.mjs";

const repository = "example/git-knot";
const tag = "v0.1.0";
const version = "0.1.0";
const encodedPublicKey = Buffer.from(
  "untrusted comment: minisign public key\nRWQFAKEPUBLICKEY\n",
).toString("base64");

function encodedSignature(name) {
  return Buffer.from(
    `untrusted comment: signature for ${name}\nRUQFAKESIGNATURE\ntrusted comment: timestamp:0\nRUQFAKEGLOBAL\n`,
  ).toString("base64");
}

function metadata() {
  const asset = (name) => ({
    url: expectedReleaseAssetUrl(repository, tag, name),
    signature: encodedSignature(name),
  });
  return {
    version,
    pub_date: "2026-08-16T00:00:00Z",
    platforms: {
      "darwin-aarch64": asset("git-knot_0.1.0_aarch64.app.tar.gz"),
      "darwin-x86_64": asset("git-knot_0.1.0_x64.app.tar.gz"),
      "linux-x86_64": asset("git-knot_0.1.0_amd64.AppImage"),
      "windows-x86_64": asset("git-knot_0.1.0_x64_en-US.msi.zip"),
    },
    portable: {
      "windows-x86_64": asset("git-knot_0.1.0_x64-portable.zip"),
    },
  };
}

function assets() {
  return [
    { name: "git-knot_0.1.0_aarch64.app.tar.gz" },
    { name: "git-knot_0.1.0_x64.app.tar.gz" },
    { name: "git-knot_0.1.0_amd64.AppImage" },
    { name: "git-knot_0.1.0_x64_en-US.msi.zip" },
    { name: "git-knot_0.1.0_x64-portable.zip" },
  ];
}

async function withArtifacts(manifest, callback) {
  const directory = await mkdtemp(join(tmpdir(), "git-knot-release-test-"));
  try {
    for (const assetName of new Set(manifest.updaterAssets.map((asset) => asset.assetName))) {
      await writeFile(join(directory, assetName), `artifact:${assetName}`);
    }
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("minisign command policy", () => {
  it("requires cryptographic verification of prehashed updater signatures", () => {
    expect(
      minisignVerificationArguments({
        artifactPath: "/release/app.tar.gz",
        publicKeyPath: "/tmp/git-knot.pub",
        signaturePath: "/tmp/app.minisig",
      }),
    ).toEqual([
      "-V",
      "-H",
      "-q",
      "-p",
      "/tmp/git-knot.pub",
      "-m",
      "/release/app.tar.gz",
      "-x",
      "/tmp/app.minisig",
    ]);
  });
});

describe("GitHub Release update validation", () => {
  it("accepts canonical GitHub updater metadata and portable asset", () => {
    expect(
      validateGithubRelease({
        metadata: metadata(),
        assets: assets(),
        repository,
        tag,
        version,
        portableAssetName: "git-knot_0.1.0_x64-portable.zip",
      }),
    ).toMatchObject({ repository, tag, version, portableAsset: "git-knot_0.1.0_x64-portable.zip" });
  });

  it("validates platform entries beyond the required minimum", () => {
    const releaseMetadata = metadata();
    const aliasName = "git-knot_0.1.0_x64_en-US.nsis.zip";
    releaseMetadata.platforms["windows-x86_64-nsis"] = {
      url: expectedReleaseAssetUrl(repository, tag, aliasName),
      signature: encodedSignature(aliasName),
    };
    const manifest = validateGithubRelease({
      metadata: releaseMetadata,
      assets: [...assets(), { name: aliasName }],
      repository,
      tag,
      version,
    });
    expect(manifest.updaterAssets.map((asset) => asset.platform)).toContain("windows-x86_64-nsis");

    releaseMetadata.platforms["windows-x86_64-nsis"].signature = "";
    expect(() =>
      validateGithubRelease({
        metadata: releaseMetadata,
        assets: [...assets(), { name: aliasName }],
        repository,
        tag,
        version,
      }),
    ).toThrow("windows-x86_64-nsis updater 签名");
  });

  it("rejects Gitee, query strings and non-canonical download URLs", () => {
    expect(() =>
      assetNameFromReleaseUrl(
        "https://gitee.com/example/git-knot/releases/download/v0.1.0/app.zip",
        repository,
        tag,
      ),
    ).toThrow("当前 GitHub 仓库");
    expect(() =>
      assetNameFromReleaseUrl(
        `${expectedReleaseAssetUrl(repository, tag, "app.zip")}?token=secret`,
        repository,
        tag,
      ),
    ).toThrow("当前 GitHub 仓库");
    expect(() =>
      assetNameFromReleaseUrl(
        "https://github.com/example/git-knot/releases/download/v0.1.0/app.zip/extra",
        repository,
        tag,
      ),
    ).toThrow("资源文件名无效");
  });

  it("rejects malformed signature, duplicate assets and version/tag mismatch", () => {
    const invalidMetadata = metadata();
    invalidMetadata.platforms["linux-x86_64"].signature = "not-base64";
    expect(() =>
      validateGithubRelease({
        metadata: invalidMetadata,
        assets: assets(),
        repository,
        tag,
        version,
      }),
    ).toThrow("Base64");

    const duplicateAssets = [...assets(), { name: "git-knot_0.1.0_x64.app.tar.gz" }];
    expect(() =>
      validateGithubRelease({
        metadata: metadata(),
        assets: duplicateAssets,
        repository,
        tag,
        version,
      }),
    ).toThrow("唯一匹配");

    expect(() =>
      validateGithubRelease({
        metadata: metadata(),
        assets: assets(),
        repository,
        tag: "v0.1.1",
        version,
      }),
    ).toThrow("必须是 v0.1.0");
  });

  it("decodes pinned keys and signatures before invoking minisign verification", async () => {
    const manifest = validateGithubRelease({
      metadata: metadata(),
      assets: assets(),
      repository,
      tag,
      version,
    });
    await withArtifacts(manifest, async (directory) => {
      const calls = [];
      await verifyGithubReleaseSignatures({
        manifest,
        artifactsDirectory: directory,
        publicKey: encodedPublicKey,
        verifier: async (input) => {
          calls.push({
            artifact: await readFile(input.artifactPath, "utf8"),
            publicKey: await readFile(input.publicKeyPath, "utf8"),
            signature: await readFile(input.signaturePath, "utf8"),
          });
        },
      });

      expect(calls).toHaveLength(4);
      expect(calls[0].artifact).toContain("artifact:git-knot");
      expect(calls[0].publicKey).toContain("minisign public key");
      expect(calls[0].signature).toContain("untrusted comment: signature");
    });
  });

  it("fails publishing validation when minisign rejects a downloaded artifact", async () => {
    const manifest = validateGithubRelease({
      metadata: metadata(),
      assets: assets(),
      repository,
      tag,
      version,
    });
    await withArtifacts(manifest, async (directory) => {
      await expect(
        verifyGithubReleaseSignatures({
          manifest,
          artifactsDirectory: directory,
          publicKey: encodedPublicKey,
          verifier: () => {
            throw new Error("minisign 拒绝该签名");
          },
        }),
      ).rejects.toThrow("签名密码学校验失败");
    });
  });
});
