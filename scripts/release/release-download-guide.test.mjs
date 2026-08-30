import { describe, expect, it } from "vitest";
import { buildReleaseDownloadGuide } from "./release-download-guide.mjs";

const assets = [
  { name: "git-knot_1.2.3_aarch64.dmg" },
  { name: "git-knot_1.2.3_x64.dmg" },
  { name: "git-knot_1.2.3_x64-setup.exe" },
  { name: "git-knot_1.2.3_x64_en-US.msi" },
  { name: "git-knot_1.2.3_x64-portable.zip" },
  { name: "git-knot_1.2.3_amd64.AppImage" },
  { name: "git-knot_1.2.3_amd64.deb" },
  { name: "git-knot-1.2.3-1.x86_64.rpm" },
];

describe("release download guide", () => {
  it("adds canonical per-platform download links before release notes", () => {
    const body = buildReleaseDownloadGuide({
      body: "## What's Changed\n\n- Added a feature",
      assets,
      repository: "example/git-knot",
      tag: "v1.2.3",
    });
    expect(body).toContain("按设备选择下载");
    expect(body).toContain("git-knot_1.2.3_x64-portable.zip");
    expect(body).toContain("https://github.com/example/git-knot/releases/download/v1.2.3/");
    expect(body.indexOf("按设备选择下载")).toBeLessThan(body.indexOf("What's Changed"));
  });

  it("replaces an existing guide without duplication", () => {
    const first = buildReleaseDownloadGuide({
      body: "Release notes",
      assets,
      repository: "example/git-knot",
      tag: "v1.2.3",
    });
    const second = buildReleaseDownloadGuide({
      body: first,
      assets,
      repository: "example/git-knot",
      tag: "v1.2.3",
    });
    expect(second.match(/git-knot-download-guide:start/g)).toHaveLength(1);
    expect(second).toContain("Release notes");
  });

  it("rejects an incomplete release asset set", () => {
    expect(() =>
      buildReleaseDownloadGuide({
        body: "Release notes",
        assets: assets.filter((asset) => !asset.name.endsWith("portable.zip")),
        repository: "example/git-knot",
        tag: "v1.2.3",
      }),
    ).toThrow("Windows 便携版 ZIP");
  });
});
