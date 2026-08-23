import { describe, expect, it } from "vitest";
import type { RepositoryStatus } from "../../platform/desktop";
import {
  groupWorkspaceChanges,
  pathspecsForChange,
  workspaceEntryKey,
  workspaceFileType,
  workspaceMutationBlocked,
} from "./workspace";

const status: RepositoryStatus = {
  root: "/repo",
  branch: { head: "main", oid: "abc", upstream: null, ahead: 0, behind: 0 },
  changes: [
    {
      path: "both.txt",
      originalPath: null,
      indexStatus: "M",
      worktreeStatus: "M",
      kind: "ordinary",
    },
    {
      path: "new.txt",
      originalPath: null,
      indexStatus: null,
      worktreeStatus: null,
      kind: "untracked",
    },
    {
      path: "conflict.txt",
      originalPath: null,
      indexStatus: "U",
      worktreeStatus: "U",
      kind: "unmerged",
    },
  ],
};

describe("workspace groups", () => {
  it("同一文件可以同时出现在暂存与未暂存分组", () => {
    const groups = groupWorkspaceChanges(status);
    expect(groups.staged.map(workspaceEntryKey)).toEqual(["staged:both.txt"]);
    expect(groups.unstaged.map(workspaceEntryKey)).toEqual([
      "unstaged:both.txt",
      "unstaged:new.txt",
    ]);
    expect(groups.conflicted.map(workspaceEntryKey)).toEqual(["unstaged:conflict.txt"]);
  });

  it("刷新状态期间阻止工作区 mutation", () => {
    expect(workspaceMutationBlocked(true, null)).toBe(true);
    expect(workspaceMutationBlocked(false, "stage")).toBe(true);
    expect(workspaceMutationBlocked(false, null)).toBe(false);
  });

  it("重命名写操作同时携带原路径和新路径", () => {
    expect(
      pathspecsForChange({
        path: "new-name.txt",
        originalPath: "old-name.txt",
        indexStatus: "R",
        worktreeStatus: null,
        kind: "renamed",
      }),
    ).toEqual(["old-name.txt", "new-name.txt"]);
  });

  it.each([
    ["src-tauri/src/platform/gitlab.rs", "RS"],
    ["src/pages/PrNewPage.vue", "VUE"],
    ["src/pages/__tests__/PrNewPage.spec.ts", "TS"],
    ["src/components/LongExtension.component", "COMP"],
    [".gitignore", "GIT"],
    [".oxfmt.json", "JSN"],
    ["docs/workbench-diff.png", "PNG"],
    ["index.html", "HTM"],
    ["pnpm-lock.yaml", "YML"],
    ["scripts/check-release.mjs", "MJS"],
    ["LICENSE", "TXT"],
  ])("为 %s 生成紧凑文件类型标签 %s", (path, fileType) => {
    expect(workspaceFileType(path)).toBe(fileType);
  });
});
