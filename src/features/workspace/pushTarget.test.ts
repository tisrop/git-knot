import { describe, expect, it } from "vitest";
import type { BranchInfo, RepositoryRefs } from "../../platform/desktop";
import { currentUpstreamTarget, remoteBranchTargets } from "./pushTarget";

const refs: RepositoryRefs = {
  remotes: [
    { name: "origin", fetchUrl: "", pushUrl: "", pushUrlOverridden: false },
    { name: "team/origin", fetchUrl: "", pushUrl: "", pushUrlOverridden: false },
  ],
  branches: [
    {
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
      kind: "remote",
      current: false,
      oid: "1".repeat(40),
      upstream: null,
      upstreamMissing: false,
      ahead: 0,
      behind: 0,
    },
    {
      name: "team/origin/release/v1",
      fullName: "refs/remotes/team/origin/release/v1",
      kind: "remote",
      current: false,
      oid: "2".repeat(40),
      upstream: null,
      upstreamMissing: false,
      ahead: 0,
      behind: 0,
    },
  ],
};

describe("push target options", () => {
  it("按最长 Remote 名解析远端分支", () => {
    expect(remoteBranchTargets(refs)).toEqual([
      expect.objectContaining({ remoteName: "origin", branchName: "main" }),
      expect.objectContaining({ remoteName: "team/origin", branchName: "release/v1" }),
    ]);
  });

  it("使用当前有效 upstream 作为默认目标", () => {
    const branch: BranchInfo = {
      name: "main",
      fullName: "refs/heads/main",
      kind: "local",
      current: true,
      oid: "3".repeat(40),
      upstream: "origin/main",
      upstreamMissing: false,
      ahead: 1,
      behind: 0,
    };
    expect(currentUpstreamTarget(branch, remoteBranchTargets(refs))).toMatchObject({
      remoteName: "origin",
      branchName: "main",
    });
    expect(
      currentUpstreamTarget({ ...branch, upstreamMissing: true }, remoteBranchTargets(refs)),
    ).toBeNull();
  });
});
