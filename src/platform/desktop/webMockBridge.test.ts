import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, FileChange, GitOperationEvent, HistoryQuery } from "./contract";
import {
  applyMockDiscard,
  applyMockDiscards,
  isValidMockBranchName,
  isValidMockTagName,
  webMockBridge,
} from "./webMockBridge";

afterEach(() => {
  vi.useRealTimers();
});

function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "file.txt",
    originalPath: null,
    indexStatus: null,
    worktreeStatus: "M",
    kind: "ordinary",
    ...overrides,
  };
}

function historyQuery(overrides: Partial<HistoryQuery> = {}): HistoryQuery {
  return {
    offset: 0,
    limit: 100,
    refFullName: null,
    search: "",
    author: "",
    after: null,
    before: null,
    filePath: null,
    ...overrides,
  };
}

describe("web mock discard", () => {
  it("删除仅存在于工作区的变更", () => {
    expect(applyMockDiscard(change())).toBeNull();
    expect(applyMockDiscard(change({ kind: "untracked", worktreeStatus: null }))).toBeNull();
  });

  it("保留同一文件的已暂存版本", () => {
    expect(applyMockDiscard(change({ indexStatus: "M" }))).toEqual(
      change({ indexStatus: "M", worktreeStatus: null }),
    );
  });

  it("拒绝冲突与仅暂存文件", () => {
    expect(() =>
      applyMockDiscard(change({ kind: "unmerged", indexStatus: "U", worktreeStatus: "U" })),
    ).toThrow("冲突文件不能直接放弃");
    expect(() => applyMockDiscard(change({ indexStatus: "A", worktreeStatus: null }))).toThrow(
      "没有可放弃的未暂存更改",
    );
  });

  it("批量操作先校验完整列表并保留未请求的更改", () => {
    const changes = [
      change({ path: "tracked.txt" }),
      change({ path: "untracked.txt", kind: "untracked", worktreeStatus: null }),
      change({ path: "keep.txt" }),
    ];

    expect(applyMockDiscards(changes, ["tracked.txt", "untracked.txt"])).toEqual([
      change({ path: "keep.txt" }),
    ]);
    expect(() =>
      applyMockDiscards(
        [
          change({ path: "tracked.txt" }),
          change({ path: "staged.txt", indexStatus: "A", worktreeStatus: null }),
        ],
        ["tracked.txt", "staged.txt"],
      ),
    ).toThrow("没有可放弃的未暂存更改");
    expect(() => applyMockDiscards(changes, ["tracked.txt", "tracked.txt"])).toThrow(
      "重复文件路径",
    );
  });

  it("拒绝空列表、超限列表、过期路径和冲突文件", () => {
    const changes = [change({ path: "tracked.txt" })];

    expect(() => applyMockDiscards(changes, [])).toThrow("1 到 256");
    expect(() =>
      applyMockDiscards(
        changes,
        Array.from({ length: 257 }, (_, index) => `file-${index}.txt`),
      ),
    ).toThrow("1 到 256");
    expect(() => applyMockDiscards(changes, ["missing.txt"])).toThrow("请刷新后重试");
    expect(() =>
      applyMockDiscards(
        [change({ path: "conflict.txt", kind: "unmerged", worktreeStatus: "U" })],
        ["conflict.txt"],
      ),
    ).toThrow("冲突文件不能直接放弃");
  });
});

describe("web mock branch validation", () => {
  it("接受常见分支名并拒绝 Git 明确禁止的格式", () => {
    expect(isValidMockBranchName("feature/safe-branch")).toBe(true);
    for (const invalid of ["", "bad branch", "bad..branch", "-option", "topic.lock"]) {
      expect(isValidMockBranchName(invalid)).toBe(false);
    }
  });
});

describe("web mock tag validation", () => {
  it("接受常见标签名并拒绝超长或 Git 禁止的格式", () => {
    expect(isValidMockTagName("v1.0.0-rc.1")).toBe(true);
    expect(isValidMockTagName("release/2026-08-17")).toBe(true);
    for (const invalid of [
      "",
      "bad tag",
      ".hidden",
      "release/.hidden",
      "bad..tag",
      "topic.lock",
      "bad~tag",
      "a".repeat(256),
    ]) {
      expect(isValidMockTagName(invalid)).toBe(false);
    }
  });
});

describe("web mock submodule inventory", () => {
  it("返回只读清单并隔离调用方修改", async () => {
    const path = "/Users/demo/projects/git-knot";
    const first = await webMockBridge.repository.submodules(path);

    expect(first.gitmodulesPresent).toBe(true);
    expect(first.submodules).toContainEqual(
      expect.objectContaining({
        path: "vendor/design-system",
        state: "clean",
        configured: true,
      }),
    );
    expect(first.submodules).toContainEqual(
      expect.objectContaining({
        path: "vendor/legacy",
        state: "uninitialized",
        configured: true,
      }),
    );

    first.submodules[0]!.state = "unsafe";
    first.submodules[0]!.conflictOids.push("c".repeat(40));

    const second = await webMockBridge.repository.submodules(path);
    expect(second.submodules[0]).toMatchObject({ state: "clean", conflictOids: [] });
  });
});

describe("web mock history filtering and pagination", () => {
  const path = "/Users/demo/projects/git-knot";

  it("返回受限分页元数据并按 offset 继续读取", async () => {
    const firstPage = await webMockBridge.repository.history(path, historyQuery({ limit: 1 }));
    expect(firstPage.commits).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextOffset).toBe(1);

    const secondPage = await webMockBridge.repository.history(
      path,
      historyQuery({ offset: firstPage.nextOffset, limit: 1 }),
    );
    expect(secondPage.commits).toHaveLength(1);
    expect(secondPage.commits[0]?.subject).toContain("bootstrap");
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextOffset).toBe(2);
  });

  it("按提交信息、作者、日期和精确文件路径筛选", async () => {
    const messagePage = await webMockBridge.repository.history(
      path,
      historyQuery({ search: "HISTORY VIEW" }),
    );
    expect(messagePage.commits.map((commit) => commit.subject)).toEqual([
      "feat: add repository history view",
    ]);

    const authorPage = await webMockBridge.repository.history(
      path,
      historyQuery({ author: "DEV@EXAMPLE.COM" }),
    );
    expect(authorPage.commits).toHaveLength(2);

    const datePage = await webMockBridge.repository.history(
      path,
      historyQuery({ after: "2026-08-16", before: "2026-08-16" }),
    );
    expect(datePage.commits).toHaveLength(2);

    const pathPage = await webMockBridge.repository.history(
      path,
      historyQuery({ filePath: "src/features/history/HistoryView.tsx" }),
    );
    expect(pathPage.commits.map((commit) => commit.subject)).toEqual([
      "feat: add repository history view",
    ]);
  });

  it("仅允许使用已存在的完整分支、远端跟踪分支或标签作为历史范围", async () => {
    const branchPage = await webMockBridge.repository.history(
      path,
      historyQuery({ refFullName: "refs/heads/feature/workspace-actions" }),
    );
    expect(branchPage.commits.map((commit) => commit.subject)).toEqual([
      "feat: bootstrap Tauri workspace",
    ]);

    await expect(
      webMockBridge.repository.history(path, historyQuery({ refFullName: "HEAD~1" })),
    ).rejects.toMatchObject({ code: "invalid_history_ref" });
    await expect(
      webMockBridge.repository.history(path, historyQuery({ refFullName: "refs/heads/not-found" })),
    ).rejects.toMatchObject({ code: "history_ref_not_found" });
  });

  it("拒绝越界数量、无效日期范围和非仓库相对路径", async () => {
    await expect(
      webMockBridge.repository.history(path, historyQuery({ limit: 0 })),
    ).rejects.toMatchObject({ code: "invalid_history_limit" });
    await expect(
      webMockBridge.repository.history(path, historyQuery({ after: "2026-02-29" })),
    ).rejects.toMatchObject({ code: "invalid_history_date" });
    await expect(
      webMockBridge.repository.history(
        path,
        historyQuery({ after: "2026-08-17", before: "2026-08-16" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_history_date_range" });
    await expect(
      webMockBridge.repository.history(path, historyQuery({ filePath: "../outside.txt" })),
    ).rejects.toMatchObject({ code: "invalid_repository_pathspec" });
  });
});

describe("web mock local tag management", () => {
  it("创建轻量和附注标签，并返回刷新后的本地标签列表", async () => {
    const path = "/Users/demo/projects/git-knot";
    const commits = await webMockBridge.repository.history(path, historyQuery({ limit: 10 }));
    const targetOid = commits.commits[0]!.oid;
    const lightweightName = "test/lightweight-tag";
    const annotatedName = "test/annotated-tag";

    const lightweight = await webMockBridge.repository.createTag(
      path,
      lightweightName,
      targetOid,
      null,
    );
    expect(lightweight.tags.tags.find((tag) => tag.name === lightweightName)).toMatchObject({
      fullName: `refs/tags/${lightweightName}`,
      targetOid,
      annotated: false,
      taggerDate: null,
    });

    const annotated = await webMockBridge.repository.createTag(
      path,
      annotatedName,
      targetOid,
      "Release candidate\nIncludes the local tag slice.",
    );
    expect(annotated.tags.tags.find((tag) => tag.name === annotatedName)).toMatchObject({
      fullName: `refs/tags/${annotatedName}`,
      targetOid,
      annotated: true,
      subject: "Release candidate",
    });
    expect(
      annotated.tags.tags.find((tag) => tag.name === annotatedName)?.taggerDate,
    ).not.toBeNull();

    await expect(
      webMockBridge.repository.createTag(path, annotatedName, targetOid, null),
    ).rejects.toThrow("已存在");
    await webMockBridge.repository.deleteTag(path, `refs/tags/${lightweightName}`);
    await webMockBridge.repository.deleteTag(path, `refs/tags/${annotatedName}`);
  });

  it("只接受精确提交 OID、有效说明和本地标签 full ref", async () => {
    const path = "/Users/demo/projects/git-knot";
    const targetOid = (await webMockBridge.repository.history(path, historyQuery({ limit: 1 })))
      .commits[0]!.oid;
    const name = "test/delete-boundary";

    await expect(
      webMockBridge.repository.createTag(path, "bad tag", targetOid, null),
    ).rejects.toThrow("标签名不合法");
    await expect(
      webMockBridge.repository.createTag(path, "test/missing-target", "HEAD", null),
    ).rejects.toThrow("目标提交已不存在");
    await expect(
      webMockBridge.repository.createTag(path, "test/empty-message", targetOid, "   "),
    ).rejects.toThrow("说明不能为空");
    await expect(
      webMockBridge.repository.createTag(
        path,
        "test/oversized-message",
        targetOid,
        "界".repeat(22_000),
      ),
    ).rejects.toThrow("64 KiB");

    await webMockBridge.repository.createTag(path, name, targetOid, null);
    await expect(webMockBridge.repository.deleteTag(path, `refs/heads/${name}`)).rejects.toThrow(
      "只能删除已读取的本地标签",
    );
    await expect(
      webMockBridge.repository.deleteTag(path, "refs/tags/test/missing"),
    ).rejects.toThrow("已不存在");

    const deleted = await webMockBridge.repository.deleteTag(path, `refs/tags/${name}`);
    expect(deleted.tags.tags.some((tag) => tag.name === name)).toBe(false);
  });
});

describe("web mock local stash management", () => {
  it("按精确 OID 创建、应用、弹出和删除储藏并返回最新状态", async () => {
    const path = "/Users/demo/projects/git-knot";
    const before = await webMockBridge.repository.status(path);
    expect(before.changes.length).toBeGreaterThan(0);

    const created = await webMockBridge.repository.createStash(path, {
      message: "Save preview work",
      includeUntracked: true,
      keepIndex: false,
    });
    const first = created.stashes.stashes[0]!;
    expect(first).toMatchObject({ selector: "stash@{0}" });
    expect(first.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(created.status.changes).toHaveLength(0);

    const applied = await webMockBridge.repository.applyStash(path, first.oid, false);
    expect(applied.stashes.stashes.some((stash) => stash.oid === first.oid)).toBe(true);
    expect(applied.status.changes.length).toBe(before.changes.length);
    expect(applied.status.changes.every((change) => change.indexStatus === null)).toBe(true);

    const secondCreated = await webMockBridge.repository.createStash(path, {
      message: null,
      includeUntracked: true,
      keepIndex: false,
    });
    const second = secondCreated.stashes.stashes[0]!;
    const popped = await webMockBridge.repository.popStash(path, second.oid, true);
    expect(popped.stashes.stashes.some((stash) => stash.oid === second.oid)).toBe(false);
    expect(popped.status.changes.length).toBe(before.changes.length);

    const dropped = await webMockBridge.repository.dropStash(path, first.oid);
    expect(dropped.stashes.stashes).toHaveLength(0);
  });

  it("拒绝 revision、缺失 OID 和不安全说明", async () => {
    const path = "/Users/demo/projects/git-knot";
    await expect(webMockBridge.repository.applyStash(path, "stash@{0}", false)).rejects.toThrow(
      "对象标识格式无效",
    );
    await expect(webMockBridge.repository.dropStash(path, "f".repeat(40))).rejects.toThrow(
      "已不存在",
    );
    for (const message of ["   ", "line one\nline two", "x".repeat(501)]) {
      await expect(
        webMockBridge.repository.createStash(path, {
          message,
          includeUntracked: true,
          keepIndex: false,
        }),
      ).rejects.toThrow("不能超过 500 个字符");
    }
  });
});

describe("web mock fetch operation", () => {
  it("发送受控进度并支持取消", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await webMockBridge.repository.fetch("/Users/demo/projects/git-knot", "origin");

    expect(events.at(-1)?.state).toBe("queued");
    await vi.advanceTimersByTimeAsync(200);
    expect(events.some((event) => event.state === "progress" && event.percent === 64)).toBe(true);
    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)?.state).toBe("cancelled");
    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(false);
    unsubscribe();
  });

  it("拒绝已经不存在的远端", async () => {
    await expect(
      webMockBridge.repository.fetch("/Users/demo/projects/git-knot", "missing"),
    ).rejects.toThrow("该远端已不存在");
  });
});

describe("web mock pull operation", () => {
  it("发送仅快进 Pull 的完整生命周期", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await webMockBridge.repository.pull("/Users/demo/projects/git-knot");

    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "pull",
      state: "queued",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.some((event) => event.kind === "pull" && event.state === "progress")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "pull",
      state: "succeeded",
      percent: 100,
    });
    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(false);
    unsubscribe();
  });

  it("取消时保留 Pull 操作类型和仓库路径", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const path = "/Users/demo/projects/git-knot";
    const started = await webMockBridge.repository.pull(path);

    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "pull",
      state: "cancelled",
      message: "已取消 Pull",
    });
    unsubscribe();
  });
});

describe("web mock push operation", () => {
  it("发送 Push 完整生命周期并更新远端引用", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const path = "/Users/demo/projects/git-knot";
    const before = await webMockBridge.repository.refs(path);
    const currentBefore = before.branches.find(
      (branch) => branch.current && branch.kind === "local",
    );
    const remoteBefore = before.branches.find(
      (branch) => branch.kind === "remote" && branch.name === currentBefore?.upstream,
    );
    expect(currentBefore?.ahead).toBeGreaterThan(0);
    expect(remoteBefore).toBeDefined();

    const started = await webMockBridge.repository.push(path);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "push",
      state: "queued",
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(
      events.some(
        (event) => event.kind === "push" && event.state === "progress" && event.percent === 68,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "push",
      state: "succeeded",
      percent: 100,
    });
    const after = await webMockBridge.repository.refs(path);
    const currentAfter = after.branches.find((branch) => branch.current && branch.kind === "local");
    const remoteAfter = after.branches.find(
      (branch) => branch.kind === "remote" && branch.name === currentAfter?.upstream,
    );
    expect(currentAfter?.ahead).toBe(0);
    expect(remoteAfter?.oid).toBe(currentAfter?.oid);
    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(false);
    unsubscribe();
  });

  it("取消时保留 Push 操作类型和仓库路径", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const path = "/Users/demo/projects/git-knot";
    const started = await webMockBridge.repository.push(path);

    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "push",
      state: "cancelled",
      message: "已取消 Push",
    });
    unsubscribe();
  });
});

describe("web mock branch publishing", () => {
  let publishBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    publishBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("创建远端分支并设置为当前分支上游", async () => {
    vi.useFakeTimers();
    await publishBridge.repository.createBranch(path, "feature/local-only");
    const before = await publishBridge.repository.refs(path);
    const current = before.branches.find((branch) => branch.current && branch.kind === "local")!;
    expect(current.upstream).toBeNull();

    const started = await publishBridge.repository.publishBranch(path, {
      localFullName: current.fullName,
      remoteName: "origin",
      remoteBranchName: "feature/published",
      expectedLocalOid: current.oid,
    });
    expect(started.operationId).toContain("mock-publish");
    await vi.advanceTimersByTimeAsync(500);

    const after = await publishBridge.repository.refs(path);
    const publishedLocal = after.branches.find(
      (branch) => branch.current && branch.kind === "local",
    );
    expect(publishedLocal?.upstream).toBe("origin/feature/published");
    expect(after.branches).toContainEqual(
      expect.objectContaining({
        kind: "remote",
        name: "origin/feature/published",
        oid: current.oid,
      }),
    );
  });

  it("拒绝覆盖已存在的远端分支", async () => {
    vi.useFakeTimers();
    await publishBridge.repository.createBranch(path, "feature/first-local");
    let refs = await publishBridge.repository.refs(path);
    let current = refs.branches.find((branch) => branch.current && branch.kind === "local")!;
    await publishBridge.repository.publishBranch(path, {
      localFullName: current.fullName,
      remoteName: "origin",
      remoteBranchName: "feature/published",
      expectedLocalOid: current.oid,
    });
    await vi.advanceTimersByTimeAsync(500);

    await publishBridge.repository.createBranch(path, "feature/second-local");
    refs = await publishBridge.repository.refs(path);
    current = refs.branches.find((branch) => branch.current && branch.kind === "local")!;
    await expect(
      publishBridge.repository.publishBranch(path, {
        localFullName: current.fullName,
        remoteName: "origin",
        remoteBranchName: "feature/published",
        expectedLocalOid: current.oid,
      }),
    ).rejects.toThrow("远端分支已经存在");
  });
});

describe("web mock selected branch push", () => {
  let pushBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    pushBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("推送到所选现有远端分支并设置上游", async () => {
    vi.useFakeTimers();
    const refs = await pushBridge.repository.refs(path);
    const current = refs.branches.find((branch) => branch.current && branch.kind === "local")!;
    const target = refs.branches.find(
      (branch) => branch.kind === "remote" && branch.name === "origin/main",
    )!;

    const started = await pushBridge.repository.pushBranchTarget(path, {
      localFullName: current.fullName,
      remoteName: "origin",
      remoteBranchName: "main",
      expectedLocalOid: current.oid,
      expectedRemoteOid: target.oid,
    });
    expect(started.operationId).toContain("mock-push-target");
    await vi.advanceTimersByTimeAsync(500);

    const after = await pushBridge.repository.refs(path);
    expect(after.branches.find((branch) => branch.current)?.upstream).toBe("origin/main");
  });

  it("新建目标拒绝覆盖同名远端分支", async () => {
    const refs = await pushBridge.repository.refs(path);
    const current = refs.branches.find((branch) => branch.current && branch.kind === "local")!;
    await expect(
      pushBridge.repository.pushBranchTarget(path, {
        localFullName: current.fullName,
        remoteName: "origin",
        remoteBranchName: "main",
        expectedLocalOid: current.oid,
        expectedRemoteOid: null,
      }),
    ).rejects.toThrow("目标远端分支已经存在");
  });
});

describe("web mock sync operation", () => {
  it("按 Pull 后 Push 的顺序发送同步生命周期", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const path = "/Users/demo/projects/git-knot";

    const started = await webMockBridge.repository.sync(path);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "sync",
      state: "queued",
    });

    await vi.advanceTimersByTimeAsync(500);
    const progressPhases = events
      .filter((event) => event.kind === "sync" && event.state === "progress")
      .map((event) => event.phase);
    expect(progressPhases).toEqual(["receiving", "pushing"]);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "sync",
      state: "succeeded",
      percent: 100,
    });

    const refs = await webMockBridge.repository.refs(path);
    const current = refs.branches.find((branch) => branch.current && branch.kind === "local");
    const upstream = refs.branches.find(
      (branch) => branch.kind === "remote" && branch.name === current?.upstream,
    );
    expect(current).toMatchObject({ ahead: 0, behind: 0 });
    expect(upstream?.oid).toBe(current?.oid);
    unsubscribe();
  });

  it("取消时保留 Sync 操作类型和仓库路径", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const path = "/Users/demo/projects/git-knot";
    const started = await webMockBridge.repository.sync(path);

    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: path,
      kind: "sync",
      state: "cancelled",
      message: "已取消同步",
    });
    unsubscribe();
  });
});

describe("web mock remote tag operations", () => {
  it("按发布、预览和 expected-OID 删除流程管理单个远端标签", async () => {
    vi.useFakeTimers();
    const path = "/Users/demo/projects/git-knot";
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const history = await webMockBridge.repository.history(path, historyQuery({ limit: 1 }));
    const target = history.commits[0]!;
    const name = "remote-lifecycle-test";
    const fullName = `refs/tags/${name}`;
    const existing = (await webMockBridge.repository.tags(path)).tags.find(
      (tag) => tag.fullName === fullName,
    );
    if (existing) await webMockBridge.repository.deleteTag(path, fullName);
    const created = await webMockBridge.repository.createTag(path, name, target.oid, null);
    const tag = created.tags.tags.find((candidate) => candidate.fullName === fullName)!;

    const pushed = await webMockBridge.repository.pushTag(path, {
      remoteName: "origin",
      fullName,
      expectedLocalOid: tag.oid,
    });
    expect(events.at(-1)).toMatchObject({
      operationId: pushed.operationId,
      kind: "tag_push",
      state: "queued",
      remoteTagDeletePreview: null,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.at(-1)).toMatchObject({ kind: "tag_push", state: "succeeded" });

    const previewStarted = await webMockBridge.repository.previewRemoteTagDelete(path, {
      remoteName: "origin",
      fullName,
      expectedLocalOid: tag.oid,
    });
    await vi.advanceTimersByTimeAsync(400);
    const previewEvent = events.find(
      (event) => event.operationId === previewStarted.operationId && event.state === "succeeded",
    );
    expect(previewEvent?.remoteTagDeletePreview).toMatchObject({
      remoteName: "origin",
      fullName,
      localOid: tag.oid,
      remoteOid: tag.oid,
    });
    const preview = previewEvent!.remoteTagDeletePreview!;

    const deleted = await webMockBridge.repository.deleteRemoteTag(path, {
      remoteName: preview.remoteName,
      fullName: preview.fullName,
      expectedLocalOid: preview.localOid,
      expectedRemoteOid: preview.remoteOid,
      expectedToken: preview.token,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(
      events.find(
        (event) => event.operationId === deleted.operationId && event.state === "succeeded",
      ),
    ).toBeDefined();
    expect((await webMockBridge.repository.tags(path)).tags).toContainEqual(tag);

    const missingPreview = await webMockBridge.repository.previewRemoteTagDelete(path, {
      remoteName: "origin",
      fullName,
      expectedLocalOid: tag.oid,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(
      events.find(
        (event) => event.operationId === missingPreview.operationId && event.state === "failed",
      )?.message,
    ).toContain("没有同名标签");
    unsubscribe();
  });

  it("远端标签预览支持取消且不会产生确认载荷", async () => {
    vi.useFakeTimers();
    const path = "/Users/demo/projects/git-knot";
    const tag = (await webMockBridge.repository.tags(path)).tags[0]!;
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await webMockBridge.repository.previewRemoteTagDelete(path, {
      remoteName: "origin",
      fullName: tag.fullName,
      expectedLocalOid: tag.oid,
    });

    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "tag_delete_preview",
      state: "cancelled",
      remoteTagDeletePreview: null,
    });
    unsubscribe();
  });
});

describe("web mock branch creation from history", () => {
  const path = "/Users/demo/projects/git-knot";

  it("从精确提交创建本地分支但不切换当前分支", async () => {
    const before = await webMockBridge.repository.refs(path);
    const currentBefore = before.branches.find(
      (branch) => branch.kind === "local" && branch.current,
    );
    const history = await webMockBridge.repository.history(path, historyQuery({ limit: 200 }));
    const target = history.commits.at(-1)!;
    const name = "test/from-history-commit";

    const result = await webMockBridge.repository.createBranchAtCommit(path, {
      name,
      targetOid: target.oid,
    });
    expect(result.refs.branches.find((branch) => branch.name === name)).toMatchObject({
      fullName: `refs/heads/${name}`,
      kind: "local",
      current: false,
      oid: target.oid,
      upstream: null,
    });
    expect(
      result.refs.branches.find((branch) => branch.kind === "local" && branch.current)?.fullName,
    ).toBe(currentBefore?.fullName);
    expect(result.status.branch.head).toBe(currentBefore?.name);
  });

  it("拒绝 revision、缺失提交和重复分支", async () => {
    await expect(
      webMockBridge.repository.createBranchAtCommit(path, {
        name: "test/from-revision",
        targetOid: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "invalid_commit_oid" });
    await expect(
      webMockBridge.repository.createBranchAtCommit(path, {
        name: "test/from-missing",
        targetOid: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "branch_target_not_found" });
    const history = await webMockBridge.repository.history(path, historyQuery({ limit: 1 }));
    await expect(
      webMockBridge.repository.createBranchAtCommit(path, {
        name: "test/from-history-commit",
        targetOid: history.commits[0]!.oid,
      }),
    ).rejects.toMatchObject({ code: "local_branch_already_exists" });
  });
});

describe("web mock tracking branch", () => {
  it("从已读取远端分支创建并切换本地跟踪分支", async () => {
    const path = "/Users/demo/projects/git-knot";
    const remoteFullName = "refs/remotes/origin/feature/remote-preview";
    const result = await webMockBridge.repository.createTrackingBranch(path, remoteFullName);
    const local = result.refs.branches.find(
      (branch) => branch.kind === "local" && branch.name === "feature/remote-preview",
    );

    expect(local).toMatchObject({
      current: true,
      upstream: "origin/feature/remote-preview",
      upstreamMissing: false,
    });
    expect(result.status.branch.head).toBe("feature/remote-preview");
  });

  it("拒绝已存在的本地分支和非远端 full ref", async () => {
    const path = "/Users/demo/projects/git-knot";
    await expect(
      webMockBridge.repository.createTrackingBranch(path, "refs/remotes/origin/main"),
    ).rejects.toThrow("本地分支 main 已存在");
    await expect(
      webMockBridge.repository.createTrackingBranch(path, "refs/heads/main"),
    ).rejects.toThrow("只能从已读取的远端分支");
  });
});

describe("web mock local branch deletion", () => {
  it("拒绝当前、远端和不存在的分支", async () => {
    const path = "/Users/demo/projects/git-knot";
    const current = (await webMockBridge.repository.refs(path)).branches.find(
      (branch) => branch.kind === "local" && branch.current,
    );
    expect(current).toBeDefined();
    await expect(
      webMockBridge.repository.deleteBranch(path, current!.fullName, true),
    ).rejects.toThrow("不能删除当前检出的分支");
    await expect(
      webMockBridge.repository.deleteBranch(path, "refs/remotes/origin/main", true),
    ).rejects.toThrow("只能删除已读取的本地分支");
    await expect(
      webMockBridge.repository.deleteBranch(path, "refs/heads/missing", true),
    ).rejects.toThrow("该分支已不存在");
  });

  it("未合并分支必须二次确认后才删除", async () => {
    const path = "/Users/demo/projects/git-knot";
    const fullName = "refs/heads/feature/workspace-actions";
    const currentBefore = (await webMockBridge.repository.refs(path)).branches.find(
      (branch) => branch.kind === "local" && branch.current,
    );

    await expect(
      webMockBridge.repository.deleteBranch(path, fullName, false),
    ).rejects.toMatchObject({
      code: "local_branch_not_merged",
    });
    expect(
      (await webMockBridge.repository.refs(path)).branches.some(
        (branch) => branch.fullName === fullName,
      ),
    ).toBe(true);

    const result = await webMockBridge.repository.deleteBranch(path, fullName, true);
    expect(result.refs.branches.some((branch) => branch.fullName === fullName)).toBe(false);
    expect(result.status.branch.head).toBe(currentBefore?.name);
  });
});

describe("web mock local branch merge", () => {
  let mergeBridge: DesktopApi;

  beforeEach(async () => {
    vi.resetModules();
    mergeBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("要求干净工作区，并只接受已读取的非当前本地分支", async () => {
    const path = "/Users/demo/projects/git-knot";
    await expect(
      mergeBridge.repository.previewLocalMerge(path, "refs/heads/main"),
    ).rejects.toMatchObject({ code: "local_merge_dirty_worktree" });

    await mergeBridge.repository.createStash(path, {
      message: "Prepare local merge test",
      includeUntracked: true,
      keepIndex: false,
    });
    await expect(
      mergeBridge.repository.previewLocalMerge(path, "refs/remotes/origin/main"),
    ).rejects.toMatchObject({ code: "local_branch_required" });
    const current = (await mergeBridge.repository.refs(path)).branches.find(
      (branch) => branch.kind === "local" && branch.current,
    );
    expect(current).toBeDefined();
    await expect(
      mergeBridge.repository.previewLocalMerge(path, current!.fullName),
    ).rejects.toMatchObject({ code: "local_merge_same_branch" });
  });

  it("预览提交关系并执行仅快进合并", async () => {
    const path = "/Users/demo/projects/git-knot";
    await mergeBridge.repository.createStash(path, {
      message: "Prepare fast-forward merge test",
      includeUntracked: true,
      keepIndex: false,
    });
    await mergeBridge.repository.switchBranch(path, "refs/heads/feature/workspace-actions");

    const preview = await mergeBridge.repository.previewLocalMerge(path, "refs/heads/main");
    expect(preview).toMatchObject({
      targetBranch: "main",
      mode: "fast_forward",
      ahead: 0,
      behind: 1,
    });

    const result = await mergeBridge.repository.mergeLocalBranch(
      path,
      preview.targetFullName,
      "fast_forward_only",
    );
    const current = result.refs.branches.find(
      (branch) => branch.kind === "local" && branch.current,
    );
    expect(current?.oid).toBe(preview.targetOid);
    expect(result.status.changes).toHaveLength(0);
  });

  it("相同提交关系返回 up_to_date，合并保持幂等", async () => {
    const path = "/Users/demo/projects/git-knot";
    await mergeBridge.repository.createStash(path, {
      message: "Prepare up-to-date merge test",
      includeUntracked: true,
      keepIndex: false,
    });
    const before = (await mergeBridge.repository.refs(path)).branches.find(
      (branch) => branch.kind === "local" && branch.current,
    )!;
    await mergeBridge.repository.createBranch(path, "test/up-to-date-merge");
    const preview = await mergeBridge.repository.previewLocalMerge(path, before.fullName);
    expect(preview.mode).toBe("up_to_date");
    const result = await mergeBridge.repository.mergeLocalBranch(
      path,
      before.fullName,
      "create_merge_commit",
    );
    expect(
      result.refs.branches.find((branch) => branch.kind === "local" && branch.current)?.oid,
    ).toBe(preview.currentOid);
  });
});

describe("web mock project metadata", () => {
  let projectBridge: DesktopApi;

  beforeEach(async () => {
    vi.resetModules();
    projectBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("updates favorites and normalized groups", async () => {
    const [project] = await projectBridge.projects.list();
    const updated = await projectBridge.projects.updateMetadata({
      id: project.id,
      favorite: false,
      group: "  客户项目  ",
    });

    expect(updated).toMatchObject({ favorite: false, group: "客户项目" });
    expect((await projectBridge.projects.list())[0]).toMatchObject({
      favorite: false,
      group: "客户项目",
    });
  });

  it("removes only the project record", async () => {
    const [project] = await projectBridge.projects.list();
    await projectBridge.projects.remove(project.id);
    expect(await projectBridge.projects.list()).toHaveLength(0);
    await expect(projectBridge.projects.remove(project.id)).rejects.toThrow("项目不存在");
  });

  it("rejects missing projects and invalid groups", async () => {
    await expect(
      projectBridge.projects.updateMetadata({
        id: "missing",
        favorite: false,
        group: null,
      }),
    ).rejects.toThrow("项目不存在");

    const [project] = await projectBridge.projects.list();
    await expect(
      projectBridge.projects.updateMetadata({
        id: project.id,
        favorite: project.favorite,
        group: "a".repeat(41),
      }),
    ).rejects.toThrow("最多 40 个字符");
  });
});

describe("web mock clone operation", () => {
  it("发送 Clone 完整生命周期并在成功后写入项目列表", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await webMockBridge.projects.clone(
      "https://github.com/example/cloned-preview.git",
      "/Users/demo/projects",
    );

    expect(started.repositoryPath).toBe("/Users/demo/projects/cloned-preview");
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: started.repositoryPath,
      kind: "clone",
      state: "queued",
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(
      events.some(
        (event) => event.kind === "clone" && event.state === "progress" && event.percent === 64,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "clone",
      state: "succeeded",
      percent: 100,
    });
    expect((await webMockBridge.projects.list())[0]).toMatchObject({
      name: "cloned-preview",
      path: started.repositoryPath,
    });
    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(false);
    unsubscribe();
  });

  it("取消 Clone 后不写入项目列表", async () => {
    vi.useFakeTimers();
    const events: GitOperationEvent[] = [];
    const unsubscribe = await webMockBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await webMockBridge.projects.clone(
      "git@github.com:example/cancelled-preview.git",
      "/Users/demo/projects",
    );

    expect(await webMockBridge.gitOperations.cancel(started.operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      repositoryPath: started.repositoryPath,
      kind: "clone",
      state: "cancelled",
      message: "已取消克隆仓库",
    });
    expect(
      (await webMockBridge.projects.list()).some(
        (project) => project.path === "/Users/demo/projects/cancelled-preview",
      ),
    ).toBe(false);
    unsubscribe();
  });

  it("拒绝 Gitee、带查询参数和不安全协议", async () => {
    for (const remoteUrl of [
      "https://gitee.com/example/repo.git",
      "https://github.com/example/repo.git?token=secret",
      "http://github.com/example/repo.git",
    ]) {
      await expect(
        webMockBridge.projects.clone(remoteUrl, "/Users/demo/projects"),
      ).rejects.toThrow();
    }
  });
});

describe("web mock conflict resolution", () => {
  let conflictBridge: DesktopApi;

  beforeEach(async () => {
    vi.resetModules();
    conflictBridge = (await import("./webMockBridge")).webMockBridge;
  });

  async function createMockConflict(path: string) {
    const created = await conflictBridge.repository.createStash(path, {
      message: "Prepare conflict test",
      includeUntracked: true,
      keepIndex: false,
    });
    const stash = created.stashes.stashes[0]!;
    await conflictBridge.repository.applyStash(path, stash.oid, false);
    await expect(
      conflictBridge.repository.applyStash(path, stash.oid, false),
    ).rejects.toMatchObject({
      code: "stash_apply_conflict",
    });
    const status = await conflictBridge.repository.status(path);
    return status.changes.find((change) => change.kind === "unmerged")!;
  }

  it("读取固定 stage 2/3 预览并用快照 token 解决冲突", async () => {
    const path = "/Users/demo/projects/git-knot";
    const conflict = await createMockConflict(path);
    const details = await conflictBridge.repository.conflictDetails(path, conflict.path);

    expect(details).toMatchObject({
      path: conflict.path,
      current: { exists: true },
      incoming: { exists: true },
      isBinary: false,
      contentTruncated: false,
      resolvable: true,
    });
    expect(details.current.content).toContain("Git stage 2");
    expect(details.incoming.content).toContain("Git stage 3");
    expect(details.token).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      conflictBridge.repository.resolveConflict(path, conflict.path, {
        choice: "current",
        expectedToken: "00000000-0000-5000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "conflict_snapshot_changed" });

    const resolved = await conflictBridge.repository.resolveConflict(path, conflict.path, {
      choice: "incoming",
      expectedToken: details.token,
    });
    expect(resolved.status.changes.some((change) => change.kind === "unmerged")).toBe(false);
    expect(resolved.status.changes.find((change) => change.path === conflict.path)).toMatchObject({
      kind: "ordinary",
      worktreeStatus: null,
    });
    await expect(
      conflictBridge.repository.conflictDetails(path, conflict.path),
    ).rejects.toMatchObject({ code: "conflict_not_found" });
  });

  it("阻止普通暂存、取消暂存和提交绕过冲突流程", async () => {
    const path = "/Users/demo/projects/git-knot";
    const conflict = await createMockConflict(path);

    await expect(conflictBridge.repository.stage(path, [conflict.path])).rejects.toMatchObject({
      code: "conflict_resolution_required",
    });
    await expect(conflictBridge.repository.stageAll(path)).rejects.toMatchObject({
      code: "conflict_resolution_required",
    });
    await expect(conflictBridge.repository.unstage(path, [conflict.path])).rejects.toMatchObject({
      code: "conflict_resolution_required",
    });
    await expect(conflictBridge.repository.unstageAll(path)).rejects.toMatchObject({
      code: "conflict_resolution_required",
    });
    await expect(
      conflictBridge.repository.createCommit(path, { subject: "Unsafe", body: "" }),
    ).rejects.toMatchObject({ code: "conflict_resolution_required" });
  });
});

describe("web mock merge recovery", () => {
  let recoveryBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    recoveryBridge = (await import("./webMockBridge")).webMockBridge;
  });

  async function createMergeConflict() {
    const created = await recoveryBridge.repository.createStash(path, {
      message: "Prepare merge recovery",
      includeUntracked: true,
      keepIndex: false,
    });
    const stash = created.stashes.stashes[0]!;
    await recoveryBridge.repository.applyStash(path, stash.oid, false);
    await expect(
      recoveryBridge.repository.applyStash(path, stash.oid, false),
    ).rejects.toMatchObject({
      code: "stash_apply_conflict",
    });
    return (await recoveryBridge.repository.status(path)).changes.find(
      (change) => change.kind === "unmerged",
    )!;
  }

  it("使用刷新后的 token 继续已解决且已暂存的合并", async () => {
    const conflict = await createMergeConflict();
    const initial = await recoveryBridge.repository.previewMergeRecovery(path);
    expect(initial).toMatchObject({
      unresolvedConflictCount: 1,
      canContinue: false,
    });

    const details = await recoveryBridge.repository.conflictDetails(path, conflict.path);
    await recoveryBridge.repository.resolveConflict(path, conflict.path, {
      choice: "current",
      expectedToken: details.token,
    });
    await expect(
      recoveryBridge.repository.continueMergeRecovery(path, {
        expectedToken: initial!.token,
      }),
    ).rejects.toMatchObject({ code: "merge_recovery_changed" });

    const dirty = await recoveryBridge.repository.previewMergeRecovery(path);
    expect(dirty).toMatchObject({
      unresolvedConflictCount: 0,
      hasUnstagedChanges: true,
      canContinue: false,
    });
    await expect(
      recoveryBridge.repository.continueMergeRecovery(path, {
        expectedToken: dirty!.token,
      }),
    ).rejects.toMatchObject({ code: "merge_worktree_not_clean" });

    await recoveryBridge.repository.stageAll(path);
    const ready = await recoveryBridge.repository.previewMergeRecovery(path);
    expect(ready).toMatchObject({
      unresolvedConflictCount: 0,
      hasUnstagedChanges: false,
      canContinue: true,
    });
    await expect(
      recoveryBridge.repository.createCommit(path, { subject: "Unsafe bypass", body: "" }),
    ).rejects.toMatchObject({ code: "merge_recovery_required" });

    const result = await recoveryBridge.repository.continueMergeRecovery(path, {
      expectedToken: ready!.token,
    });
    expect(result.status.changes).toEqual([]);
    expect(await recoveryBridge.repository.previewMergeRecovery(path)).toBeNull();
  });

  it("校验令牌并可终止当前合并", async () => {
    await createMergeConflict();
    await expect(
      recoveryBridge.repository.abortMergeRecovery(path, { expectedToken: "invalid" }),
    ).rejects.toMatchObject({ code: "invalid_merge_recovery_token" });

    const preview = await recoveryBridge.repository.previewMergeRecovery(path);
    const result = await recoveryBridge.repository.abortMergeRecovery(path, {
      expectedToken: preview!.token,
    });
    expect(result.status.changes.some((change) => change.kind === "unmerged")).toBe(false);
    expect(await recoveryBridge.repository.previewMergeRecovery(path)).toBeNull();
  });
});

describe("web mock safe amend", () => {
  let amendBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    amendBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("预览当前提交信息、暂存数量与安全令牌", async () => {
    const preview = await amendBridge.repository.previewAmendCommit(path);

    expect(preview).toMatchObject({
      currentBranch: "main",
      headOid: "75a2a598d38c764e2c82f86d12d3f47fd1ac0801",
      currentSubject: "feat: add repository history view",
      stagedChangeCount: 1,
      blockingRefs: [],
      canAmend: true,
    });
    expect(preview.currentBody).toContain("Rust");
    expect(preview.token).toMatch(/^mock-amend-[0-9a-f]{8}$/u);
  });

  it("把暂存内容写入替换提交并保留 author、parents 与 ahead", async () => {
    const beforeRefs = await amendBridge.repository.refs(path);
    const beforeBranch = beforeRefs.branches.find((branch) => branch.current)!;
    const beforeCommit = await amendBridge.repository.commit(path, beforeBranch.oid);
    const preview = await amendBridge.repository.previewAmendCommit(path);

    const result = await amendBridge.repository.amendCommit(path, {
      subject: "feat: safely amend HEAD",
      body: "Include the staged history view update.",
      expectedToken: preview.token,
    });

    expect(result.previousOid).toBe(preview.headOid);
    expect(result.commit.oid).not.toBe(preview.headOid);
    expect(result.commit).toMatchObject({
      parentOids: beforeCommit.commit.parentOids,
      authorName: beforeCommit.commit.authorName,
      authorEmail: beforeCommit.commit.authorEmail,
      authoredAt: beforeCommit.commit.authoredAt,
      subject: "feat: safely amend HEAD",
    });
    expect(result.status.changes.some((change) => Boolean(change.indexStatus))).toBe(false);
    const afterBranch = (await amendBridge.repository.refs(path)).branches.find(
      (branch) => branch.current,
    )!;
    expect(afterBranch).toMatchObject({ oid: result.commit.oid, ahead: beforeBranch.ahead });
    expect((await amendBridge.repository.commit(path, result.commit.oid)).body).toBe(
      "Include the staged history view update.",
    );
  });

  it("已发布 HEAD 只允许修改提交并安全强推到精确上游", async () => {
    vi.useFakeTimers();
    const pushed = await amendBridge.repository.push(path);
    await vi.advanceTimersByTimeAsync(500);
    expect(await amendBridge.gitOperations.cancel(pushed.operationId)).toBe(false);

    const localPreview = await amendBridge.repository.previewAmendCommit(path);
    expect(localPreview.canAmend).toBe(false);
    const preview = await amendBridge.repository.previewAmendAndPush(path);
    expect(preview).toMatchObject({
      remoteName: "origin",
      remoteBranchName: "main",
      expectedRemoteOid: localPreview.headOid,
    });

    const events: GitOperationEvent[] = [];
    const unsubscribe = await amendBridge.gitOperations.subscribe((event) => events.push(event));
    const started = await amendBridge.repository.amendAndPush(path, {
      subject: "feat: amend published HEAD",
      body: "Guarded by an exact lease.",
      expectedToken: preview.token,
    });
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "amend_push",
      state: "queued",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.at(-1)).toMatchObject({
      operationId: started.operationId,
      kind: "amend_push",
      state: "succeeded",
    });
    const refs = await amendBridge.repository.refs(path);
    const current = refs.branches.find((branch) => branch.current)!;
    const upstream = refs.branches.find(
      (branch) => branch.kind === "remote" && branch.name === current.upstream,
    )!;
    expect(current.oid).not.toBe(preview.headOid);
    expect(upstream.oid).toBe(current.oid);
    unsubscribe();
  });

  it("允许没有暂存内容时只修改提交信息", async () => {
    await amendBridge.repository.unstageAll(path);
    const preview = await amendBridge.repository.previewAmendCommit(path);
    expect(preview.stagedChangeCount).toBe(0);

    const result = await amendBridge.repository.amendCommit(path, {
      subject: "docs: clarify commit message",
      body: "Message-only amend.",
      expectedToken: preview.token,
    });

    expect(result.commit.subject).toBe("docs: clarify commit message");
    expect(result.status.changes.some((change) => Boolean(change.indexStatus))).toBe(false);
  });

  it("暂存区变化后拒绝过期令牌且不移动 HEAD", async () => {
    const preview = await amendBridge.repository.previewAmendCommit(path);
    await amendBridge.repository.stageAll(path);

    await expect(
      amendBridge.repository.amendCommit(path, {
        subject: "feat: stale amend",
        body: "",
        expectedToken: preview.token,
      }),
    ).rejects.toMatchObject({ code: "amend_snapshot_changed" });
    const current = (await amendBridge.repository.refs(path)).branches.find(
      (branch) => branch.current,
    );
    expect(current?.oid).toBe(preview.headOid);
  });

  it("阻止冲突、进行中的 merge 与本地已知远端或标签引用", async () => {
    const stashed = await amendBridge.repository.createStash(path, {
      message: "Prepare amend blockers",
      includeUntracked: true,
      keepIndex: false,
    });
    const stash = stashed.stashes.stashes[0]!;
    await amendBridge.repository.applyStash(path, stash.oid, false);
    await expect(amendBridge.repository.applyStash(path, stash.oid, false)).rejects.toMatchObject({
      code: "stash_apply_conflict",
    });
    await expect(amendBridge.repository.previewAmendCommit(path)).rejects.toMatchObject({
      code: "conflict_resolution_required",
    });

    const conflict = (await amendBridge.repository.status(path)).changes.find(
      (change) => change.kind === "unmerged",
    )!;
    const details = await amendBridge.repository.conflictDetails(path, conflict.path);
    await amendBridge.repository.resolveConflict(path, conflict.path, {
      choice: "current",
      expectedToken: details.token,
    });
    await expect(amendBridge.repository.previewAmendCommit(path)).rejects.toMatchObject({
      code: "amend_operation_in_progress",
    });

    const recovery = await amendBridge.repository.previewMergeRecovery(path);
    await amendBridge.repository.abortMergeRecovery(path, { expectedToken: recovery!.token });
    await amendBridge.repository.createStash(path, {
      message: "Clean before branch switch",
      includeUntracked: true,
      keepIndex: false,
    });
    await amendBridge.repository.switchBranch(path, "refs/heads/feature/workspace-actions");
    const blocked = await amendBridge.repository.previewAmendCommit(path);
    expect(blocked.canAmend).toBe(false);
    expect(blocked.blockingRefs).toEqual([
      "refs/remotes/origin/feature/remote-preview",
      "refs/remotes/origin/main",
      "refs/tags/v0.1.0-preview",
    ]);
  });
});

describe("web mock remote management", () => {
  let remoteBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    remoteBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("创建、预览、更新并删除远端", async () => {
    const created = await remoteBridge.repository.createRemote(path, {
      name: "backup",
      fetchUrl: "https://github.com/example/repository.git",
      pushUrl: "git@github.com:example/repository.git",
    });
    expect(created.refs.remotes.find((remote) => remote.name === "backup")).toMatchObject({
      fetchUrl: "https://github.com/example/repository.git",
      pushUrl: "git@github.com:example/repository.git",
      pushUrlOverridden: true,
    });

    const edit = await remoteBridge.repository.previewRemoteEdit(path, "backup");
    expect(edit.token).toMatch(/^[0-9a-f-]{36}$/u);
    const updated = await remoteBridge.repository.updateRemote(path, {
      name: "backup",
      expectedToken: edit.token,
      newFetchUrl: "https://gitlab.com/example/repository.git",
      newPushUrl: null,
      resetPushUrl: true,
    });
    expect(updated.refs.remotes.find((remote) => remote.name === "backup")).toMatchObject({
      fetchUrl: "https://gitlab.com/example/repository.git",
      pushUrl: "https://gitlab.com/example/repository.git",
      pushUrlOverridden: false,
    });

    await expect(
      remoteBridge.repository.updateRemote(path, {
        name: "backup",
        expectedToken: edit.token,
        newFetchUrl: "https://github.com/example/stale.git",
        newPushUrl: null,
        resetPushUrl: false,
      }),
    ).rejects.toMatchObject({ code: "remote_snapshot_changed" });

    const deletion = await remoteBridge.repository.previewRemoteDelete(path, "backup");
    expect(deletion.affectedBranches).toEqual([]);
    const deleted = await remoteBridge.repository.deleteRemote(path, {
      name: "backup",
      expectedToken: deletion.token,
    });
    expect(deleted.refs.remotes.some((remote) => remote.name === "backup")).toBe(false);
  });

  it("拒绝不安全名称、凭据、相对路径和 Gitee 地址", async () => {
    for (const [name, fetchUrl, code] of [
      ["bad/name", "https://github.com/example/repository.git", "invalid_remote_name"],
      [
        "backup",
        "https://token@github.com/example/repository.git",
        "remote_url_credentials_forbidden",
      ],
      ["backup", "../relative/repository.git", "invalid_remote_url"],
      ["backup", "git@gitee.com:example/repository.git", "gitee_not_supported"],
    ] as const) {
      await expect(
        remoteBridge.repository.createRemote(path, { name, fetchUrl, pushUrl: null }),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe("web mock linked worktree locking", () => {
  let worktreeBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    worktreeBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("返回权威清单，并使用快照令牌锁定和解锁关联工作树", async () => {
    const initial = await worktreeBridge.repository.worktrees(path);
    expect(initial.worktrees).toHaveLength(2);
    expect(initial.worktrees[0]).toMatchObject({ isMain: true, branch: "main" });
    const linked = initial.worktrees.find((worktree) => !worktree.isMain)!;
    expect(linked).toMatchObject({ locked: false, branch: "feature/workspace-actions" });
    expect(linked.token).toMatch(/^[0-9a-f-]{36}$/u);

    const locked = await worktreeBridge.repository.lockWorktree(path, {
      worktreePath: linked.path,
      expectedToken: linked.token,
      reason: " release validation ",
    });
    const lockedLinked = locked.worktrees.find((worktree) => worktree.path === linked.path)!;
    expect(lockedLinked).toMatchObject({ locked: true, lockReason: "release validation" });
    expect(lockedLinked.token).not.toBe(linked.token);

    await expect(
      worktreeBridge.repository.unlockWorktree(path, {
        worktreePath: linked.path,
        expectedToken: linked.token,
      }),
    ).rejects.toMatchObject({ code: "worktree_snapshot_changed" });

    const unlocked = await worktreeBridge.repository.unlockWorktree(path, {
      worktreePath: lockedLinked.path,
      expectedToken: lockedLinked.token,
    });
    expect(unlocked.worktrees.find((worktree) => worktree.path === linked.path)).toMatchObject({
      locked: false,
      lockReason: null,
    });
  });

  it("只从权威候选创建 Rust 推导路径下的关联工作树", async () => {
    const initial = await worktreeBridge.repository.worktrees(path);
    expect(initial.createCandidates).toHaveLength(1);
    const candidate = initial.createCandidates[0]!;
    expect(candidate).toMatchObject({
      branch: "release/preview",
      branchFullName: "refs/heads/release/preview",
    });
    expect(candidate.targetPath).toContain("/.git-knot-worktrees/");

    await expect(
      worktreeBridge.repository.createLinkedWorktree(path, {
        branchFullName: candidate.branchFullName,
        expectedToken: "00000000-0000-5000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "worktree_create_snapshot_changed" });

    const created = await worktreeBridge.repository.createLinkedWorktree(path, {
      branchFullName: candidate.branchFullName,
      expectedToken: candidate.token,
    });
    expect(created.worktrees).toHaveLength(3);
    expect(
      created.worktrees.find((worktree) => worktree.path === candidate.targetPath),
    ).toMatchObject({
      branch: "release/preview",
      branchFullName: "refs/heads/release/preview",
      isMain: false,
    });
    expect(created.createCandidates).toHaveLength(0);

    await expect(
      worktreeBridge.repository.createLinkedWorktree(path, {
        branchFullName: candidate.branchFullName,
        expectedToken: candidate.token,
      }),
    ).rejects.toMatchObject({ code: "worktree_create_unavailable" });
  });

  it("拒绝主工作树、无效令牌和不安全锁定原因", async () => {
    const initial = await worktreeBridge.repository.worktrees(path);
    const main = initial.worktrees.find((worktree) => worktree.isMain)!;
    const linked = initial.worktrees.find((worktree) => !worktree.isMain)!;

    await expect(
      worktreeBridge.repository.lockWorktree(path, {
        worktreePath: main.path,
        expectedToken: main.token,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "main_worktree_immutable" });
    await expect(
      worktreeBridge.repository.lockWorktree(path, {
        worktreePath: linked.path,
        expectedToken: "invalid",
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_worktree_token" });
    await expect(
      worktreeBridge.repository.lockWorktree(path, {
        worktreePath: linked.path,
        expectedToken: linked.token,
        reason: "invalid\nreason",
      }),
    ).rejects.toMatchObject({ code: "invalid_worktree_lock_reason" });
  });
});

describe("web mock commit creation", () => {
  let commitBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    commitBridge = (await import("./webMockBridge")).webMockBridge;
  });

  it("为连续提交生成不同 OID，并保留各自的正文与文件", async () => {
    const before = await commitBridge.repository.history(path, historyQuery());
    const first = await commitBridge.repository.createCommit(path, {
      subject: "First preview commit",
      body: "First body",
    });

    await commitBridge.repository.stageAll(path);
    const second = await commitBridge.repository.createCommit(path, {
      subject: "Second preview commit",
      body: "Second body",
    });
    const history = await commitBridge.repository.history(path, historyQuery());
    const firstDetails = await commitBridge.repository.commit(path, first.commit.oid);
    const secondDetails = await commitBridge.repository.commit(path, second.commit.oid);
    const firstFileHistory = await commitBridge.repository.history(
      path,
      historyQuery({ filePath: "src/features/history/HistoryView.tsx" }),
    );
    const secondFileHistory = await commitBridge.repository.history(
      path,
      historyQuery({ filePath: "docs/architecture.md" }),
    );

    expect(first.commit.oid).not.toBe(second.commit.oid);
    expect(second.commit.parentOids).toEqual([first.commit.oid]);
    expect(second.status.branch.oid).toBe(second.commit.oid);
    expect(history.commits.slice(0, 2).map((commit) => commit.oid)).toEqual([
      second.commit.oid,
      first.commit.oid,
    ]);
    expect(new Set(history.commits.map((commit) => commit.oid)).size).toBe(
      before.commits.length + 2,
    );
    expect(firstDetails.body).toBe("First body");
    expect(firstDetails.files.map((file) => file.path)).toContain(
      "src/features/history/HistoryView.tsx",
    );
    expect(secondDetails.body).toBe("Second body");
    expect(firstFileHistory.commits.some((commit) => commit.oid === first.commit.oid)).toBe(true);
    expect(secondFileHistory.commits.map((commit) => commit.oid)).toContain(second.commit.oid);
    expect(secondFileHistory.commits.map((commit) => commit.oid)).not.toContain(first.commit.oid);
  });
});

describe("web mock safe commit revert", () => {
  let revertBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    revertBridge = (await import("./webMockBridge")).webMockBridge;
  });

  async function cleanWorktree() {
    await revertBridge.repository.createStash(path, {
      message: "Prepare revert test",
      includeUntracked: true,
      keepIndex: false,
    });
  }

  it("要求干净工作区，并拒绝 root 与非当前历史提交", async () => {
    const initial = await revertBridge.repository.history(path, historyQuery());
    await expect(
      revertBridge.repository.previewRevert(path, initial.commits[0]!.oid),
    ).rejects.toMatchObject({ code: "revert_dirty_worktree" });

    await cleanWorktree();
    const cleanHistory = await revertBridge.repository.history(path, historyQuery());
    const root = cleanHistory.commits.at(-1)!;
    await expect(revertBridge.repository.previewRevert(path, root.oid)).rejects.toMatchObject({
      code: "revert_merge_commit_unsupported",
    });

    const mainHead = cleanHistory.commits[0]!.oid;
    await revertBridge.repository.switchBranch(path, "refs/heads/feature/workspace-actions");
    await expect(revertBridge.repository.previewRevert(path, mainHead)).rejects.toMatchObject({
      code: "revert_target_not_in_history",
    });
  });

  it("创建新的 Revert 提交并保留原历史", async () => {
    await cleanWorktree();
    const before = await revertBridge.repository.history(path, historyQuery());
    const target = before.commits[0]!;
    const preview = await revertBridge.repository.previewRevert(path, target.oid);

    const result = await revertBridge.repository.revertCommit(path, {
      targetOid: target.oid,
      expectedToken: preview.token,
    });
    const after = await revertBridge.repository.history(path, historyQuery());

    expect(result.status.branch.oid).not.toBe(preview.currentOid);
    expect(after.commits[0]).toMatchObject({
      oid: result.status.branch.oid,
      parentOids: [preview.currentOid],
      subject: `Revert "${target.subject}"`,
    });
    expect(after.commits.some((commit) => commit.oid === target.oid)).toBe(true);
    expect(after.commits).toHaveLength(before.commits.length + 1);
  });

  it("拒绝 HEAD 变化后的过期令牌", async () => {
    await cleanWorktree();
    const history = await revertBridge.repository.history(path, historyQuery());
    const target = history.commits[0]!;
    const preview = await revertBridge.repository.previewRevert(path, target.oid);

    const stash = (await revertBridge.repository.stashes(path)).stashes[0]!;
    await revertBridge.repository.applyStash(path, stash.oid, false);
    await revertBridge.repository.stageAll(path);
    await revertBridge.repository.createCommit(path, {
      subject: "Move HEAD after preview",
      body: "",
    });
    const changedHead = (await revertBridge.repository.status(path)).branch.oid;

    await expect(
      revertBridge.repository.revertCommit(path, {
        targetOid: target.oid,
        expectedToken: preview.token,
      }),
    ).rejects.toMatchObject({ code: "revert_snapshot_changed" });
    expect((await revertBridge.repository.status(path)).branch.oid).toBe(changedHead);
  });

  it("拒绝 merge commit", async () => {
    await cleanWorktree();
    await revertBridge.repository.switchBranch(path, "refs/heads/feature/workspace-actions");
    const stash = (await revertBridge.repository.stashes(path)).stashes[0]!;
    await revertBridge.repository.applyStash(path, stash.oid, false);
    await revertBridge.repository.stageAll(path);
    await revertBridge.repository.createCommit(path, {
      subject: "Feature change",
      body: "",
    });
    await revertBridge.repository.switchBranch(path, "refs/heads/main");
    await revertBridge.repository.mergeLocalBranch(
      path,
      "refs/heads/feature/workspace-actions",
      "create_merge_commit",
    );
    const mergeHead = (await revertBridge.repository.status(path)).branch.oid!;

    await expect(revertBridge.repository.previewRevert(path, mergeHead)).rejects.toMatchObject({
      code: "revert_merge_commit_unsupported",
    });
  });
});

describe("web mock safe commit reset", () => {
  let resetBridge: DesktopApi;
  const path = "/Users/demo/projects/git-knot";

  beforeEach(async () => {
    vi.resetModules();
    resetBridge = (await import("./webMockBridge")).webMockBridge;
  });

  async function cleanWorktree() {
    await resetBridge.repository.createStash(path, {
      message: "Prepare reset test",
      includeUntracked: true,
      keepIndex: false,
    });
  }

  it("要求干净工作区，并拒绝重置远端已包含的 HEAD", async () => {
    const initial = await resetBridge.repository.history(path, historyQuery());
    await expect(
      resetBridge.repository.previewResetCommit(path, initial.commits[0]!.oid, "hard"),
    ).rejects.toMatchObject({ code: "reset_dirty_worktree" });

    await cleanWorktree();
    const mainHead = (await resetBridge.repository.status(path)).branch.oid!;
    await resetBridge.repository.switchBranch(path, "refs/heads/feature/workspace-actions");
    await expect(
      resetBridge.repository.previewResetCommit(path, mainHead, "mixed"),
    ).rejects.toMatchObject({ code: "reset_published_history" });
  });
});
