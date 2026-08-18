import { describe, expect, it } from "vitest";
import {
  assertProductionBundleExcludesWebMock,
  WEB_MOCK_SENTINELS,
} from "./production-bundle-policy.mjs";

describe("production bundle policy", () => {
  it("accepts bundles without browser mock data", () => {
    expect(() =>
      assertProductionBundleExcludesWebMock([
        { path: "dist/assets/index.js", contents: "const applicationName = 'git-knot';" },
      ]),
    ).not.toThrow();
  });

  it.each(WEB_MOCK_SENTINELS)("rejects the web mock sentinel %s", (sentinel) => {
    expect(() =>
      assertProductionBundleExcludesWebMock([
        { path: "dist/assets/index.js", contents: `const mockData = ${JSON.stringify(sentinel)};` },
      ]),
    ).toThrow("webMockBridge");
  });
});
