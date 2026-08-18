import { describe, expect, it } from "vitest";
import type { RepositoryRefs } from "../../platform/desktop";
import {
  branchDivergenceLabel,
  canSubmitRemoteCreate,
  canSubmitRemoteUpdate,
  groupBranches,
  isCurrentRepositoryRequest,
} from "./branches";

const refs: RepositoryRefs = {
  branches: [
    {
      name: "main",
      fullName: "refs/heads/main",
      kind: "local",
      current: true,
      oid: "a".repeat(40),
      upstream: "origin/main",
      upstreamMissing: false,
      ahead: 2,
      behind: 1,
    },
    {
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
      kind: "remote",
      current: false,
      oid: "b".repeat(40),
      upstream: null,
      upstreamMissing: false,
      ahead: 0,
      behind: 0,
    },
  ],
  remotes: [],
};

describe("branch helpers", () => {
  it("按本地与远端分组并支持搜索", () => {
    expect(groupBranches(refs).local).toHaveLength(1);
    expect(groupBranches(refs).remote).toHaveLength(1);
    expect(groupBranches(refs, "origin").local).toHaveLength(0);
    expect(groupBranches(refs, "origin").remote[0].name).toBe("origin/main");
  });

  it("只接受当前仓库和当前请求的异步结果", () => {
    expect(isCurrentRepositoryRequest("/repo-a", "/repo-a", 3, 3)).toBe(true);
    expect(isCurrentRepositoryRequest("/repo-b", "/repo-a", 3, 3)).toBe(false);
    expect(isCurrentRepositoryRequest("/repo-a", "/repo-a", 4, 3)).toBe(false);
  });

  it("生成人类可读的 ahead/behind 文案", () => {
    expect(branchDivergenceLabel(refs.branches[0])).toBe("领先 2 · 落后 1");
    expect(branchDivergenceLabel({ ...refs.branches[0], upstreamMissing: true })).toBe(
      "上游已丢失",
    );
  });

  it("只允许提交完整的远端创建表单", () => {
    expect(canSubmitRemoteCreate("origin", "https://github.com/acme/repo.git")).toBe(true);
    expect(canSubmitRemoteCreate("  ", "https://github.com/acme/repo.git")).toBe(false);
    expect(canSubmitRemoteCreate("origin", "  ")).toBe(false);
  });

  it("远端编辑必须包含 URL 变更或重置 Push 地址", () => {
    expect(canSubmitRemoteUpdate("", "", false)).toBe(false);
    expect(canSubmitRemoteUpdate("https://github.com/acme/new.git", "", false)).toBe(true);
    expect(canSubmitRemoteUpdate("", "git@github.com:acme/new.git", false)).toBe(true);
    expect(canSubmitRemoteUpdate("", "", true)).toBe(true);
  });
});
