import { describe, expect, it } from "vitest";
import type { RepositoryStatus } from "../../platform/desktop";
import {
  isCurrentRepositoryStatusRequest,
  isCurrentStatusRequest,
  summarizeRepositoryStatus,
} from "./status";

describe("summarizeRepositoryStatus", () => {
  it("分别统计暂存、未暂存、未跟踪与冲突文件", () => {
    const status: RepositoryStatus = {
      root: "/repo",
      branch: { head: "main", oid: "abc", upstream: "origin/main", ahead: 1, behind: 2 },
      changes: [
        {
          path: "src/a.ts",
          originalPath: null,
          indexStatus: "M",
          worktreeStatus: ".",
          kind: "ordinary",
        },
        {
          path: "src/b.ts",
          originalPath: null,
          indexStatus: ".",
          worktreeStatus: "M",
          kind: "ordinary",
        },
        {
          path: "notes.txt",
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

    expect(summarizeRepositoryStatus(status)).toEqual({
      staged: 2,
      unstaged: 2,
      untracked: 1,
      conflicted: 1,
      clean: false,
    });
  });
});

describe("status request sequencing", () => {
  it("rejects a load response after a mutation invalidates its request id", () => {
    const loadRequestId = 4;
    const activeRequestAfterMutation = loadRequestId + 1;

    expect(isCurrentStatusRequest(loadRequestId, loadRequestId)).toBe(true);
    expect(isCurrentStatusRequest(activeRequestAfterMutation, loadRequestId)).toBe(false);
  });

  it("rejects a shared response invalidated for the repository", () => {
    expect(isCurrentRepositoryStatusRequest(8, 8, 3, 3)).toBe(true);
    expect(isCurrentRepositoryStatusRequest(8, 8, 4, 3)).toBe(false);
  });

  it("rejects a repository response after the selected status request changes", () => {
    expect(isCurrentRepositoryStatusRequest(9, 8, 3, 3)).toBe(false);
  });
});
