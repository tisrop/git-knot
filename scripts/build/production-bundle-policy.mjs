export const WEB_MOCK_SENTINELS = [
  "browser-preview",
  "/Users/demo/projects/git-knot",
  "feature/workspace-actions",
];

export function assertProductionBundleExcludesWebMock(assets) {
  const contaminatedAssets = [];

  for (const asset of assets) {
    const matchedSentinels = WEB_MOCK_SENTINELS.filter((sentinel) =>
      asset.contents.includes(sentinel),
    );
    if (matchedSentinels.length > 0) {
      contaminatedAssets.push(`${asset.path} (${matchedSentinels.join(", ")})`);
    }
  }

  if (contaminatedAssets.length > 0) {
    throw new Error(`生产 bundle 包含 webMockBridge 演示数据：${contaminatedAssets.join("、")}`);
  }
}
