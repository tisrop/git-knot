import { describe, expect, it } from "vitest";
import { cargoPackageVersion, validateVersionConsistency } from "./version-consistency.mjs";

describe("release version consistency", () => {
  it("accepts matching manifests and tag", () => {
    expect(
      validateVersionConsistency({
        packageVersion: "1.2.3",
        cargoVersion: "1.2.3",
        tauriVersion: "1.2.3",
        tag: "v1.2.3",
      }),
    ).toBe("1.2.3");
  });

  it("rejects mismatched manifests and tag", () => {
    expect(() =>
      validateVersionConsistency({
        packageVersion: "1.2.3",
        cargoVersion: "1.2.4",
        tauriVersion: "1.2.3",
      }),
    ).toThrow("应用版本不一致");
    expect(() =>
      validateVersionConsistency({
        packageVersion: "1.2.3",
        cargoVersion: "1.2.3",
        tauriVersion: "1.2.3",
        tag: "v1.2.4",
      }),
    ).toThrow("Release Tag");
  });

  it("reads the version from the Cargo package section only", () => {
    expect(
      cargoPackageVersion(
        '[package]\nname = "git-knot"\nversion = "1.2.3"\n\n[dependencies]\nfoo = "9"\n',
      ),
    ).toBe("1.2.3");
  });
});
