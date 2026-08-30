import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../../platform/desktop";
import {
  buildCommitGraphRows,
  buildCommitFileTreeEntries,
  appendUniqueCommitsWithLimit,
  buildSplitDiffRows,
  commitFileStatusLabel,
  formatCommitDate,
  isAddedFileDiff,
  isCurrentRepositoryPath,
  LruCache,
  mergeRefreshedHistoryPage,
  parseUnifiedDiff,
  patchForFile,
  shortCommitOid,
} from "./history";

function commit(oid: string, parentOids: string[]): CommitSummary {
  return {
    oid,
    parentOids,
    authorName: "Test",
    authorEmail: "test@example.invalid",
    authoredAt: "2026-08-17T10:00:00+08:00",
    subject: oid,
  };
}

describe("LruCache", () => {
  it("evicts the least recently used entry at capacity", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("first", 1);
    cache.set("second", 2);

    expect(cache.get("first")).toBe(1);
    cache.set("third", 3);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(1);
    expect(cache.get("third")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("treats replacement as recent and supports clearing", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("first", 1);
    cache.set("second", 2);
    cache.set("first", 10);
    cache.set("third", 3);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(10);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("rejects invalid capacities", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});

describe("history presentation helpers", () => {
  it("shortens full commit object ids", () => {
    expect(shortCommitOid("0123456789abcdef")).toBe("01234567");
  });

  it("limits appended commits to a soft history cap", () => {
    const current = [commit("one", [])];
    const result = appendUniqueCommitsWithLimit(
      current,
      [commit("two", []), commit("three", [])],
      2,
    );

    expect(result.commits.map((item) => item.oid)).toEqual(["one", "two"]);
    expect(result.limitReached).toBe(true);
  });

  it("keeps the loaded tail when a background refresh finds new commits", () => {
    const current = [commit("c", []), commit("b", []), commit("a", [])];
    const result = mergeRefreshedHistoryPage(current, [commit("d", []), commit("c", [])], 100);

    expect(result.commits.map((item) => item.oid)).toEqual(["d", "c", "b", "a"]);
    expect(result.replaced).toBe(false);
  });

  it("returns the same array when a background refresh changes nothing", () => {
    const current = [commit("c", []), commit("b", []), commit("a", [])];
    const result = mergeRefreshedHistoryPage(current, [commit("c", []), commit("b", [])], 100);

    expect(result.commits).toBe(current);
    expect(result.replaced).toBe(false);
  });

  it("drops commits a rewrite removed from the top of history", () => {
    const current = [commit("c", []), commit("b", []), commit("a", [])];
    const result = mergeRefreshedHistoryPage(current, [commit("b", []), commit("a", [])], 100);

    expect(result.commits.map((item) => item.oid)).toEqual(["b", "a"]);
    expect(result.replaced).toBe(false);
  });

  it("replaces the list when the refreshed page shares no commit", () => {
    const current = [commit("c", []), commit("b", [])];
    const result = mergeRefreshedHistoryPage(current, [commit("z", []), commit("y", [])], 100);

    expect(result.commits.map((item) => item.oid)).toEqual(["z", "y"]);
    expect(result.replaced).toBe(true);
  });

  it("replaces an empty list without claiming a merge", () => {
    const result = mergeRefreshedHistoryPage([], [commit("a", [])], 100);

    expect(result.commits.map((item) => item.oid)).toEqual(["a"]);
    expect(result.replaced).toBe(true);
  });

  it("honours the soft limit while merging", () => {
    const current = [commit("c", []), commit("b", []), commit("a", [])];
    const result = mergeRefreshedHistoryPage(current, [commit("d", []), commit("c", [])], 3);

    expect(result.commits.map((item) => item.oid)).toEqual(["d", "c", "b"]);
  });

  it("maps name-status codes to readable labels", () => {
    expect(commitFileStatusLabel("R100")).toBe("重命名");
    expect(commitFileStatusLabel("M")).toBe("修改");
    expect(commitFileStatusLabel("X")).toBe("X");
  });

  it("builds a stable directory tree for changed files", () => {
    const entries = buildCommitFileTreeEntries([
      { status: "M", path: "src/pages/Home.tsx", originalPath: null },
      { status: "A", path: "README.md", originalPath: null },
      { status: "M", path: "src/app.ts", originalPath: null },
      { status: "D", path: "tests/app.test.ts", originalPath: null },
    ]);

    expect(
      entries.map((entry) =>
        entry.kind === "directory"
          ? `directory:${entry.depth}:${entry.path}`
          : `file:${entry.depth}:${entry.file.path}`,
      ),
    ).toEqual([
      "directory:0:src",
      "directory:1:src/pages",
      "file:2:src/pages/Home.tsx",
      "file:1:src/app.ts",
      "directory:0:tests",
      "file:1:tests/app.test.ts",
      "file:0:README.md",
    ]);
  });

  it("keeps invalid dates visible instead of hiding them", () => {
    expect(formatCommitDate("not-a-date")).toBe("not-a-date");
  });

  it("只接受当前仓库的异步结果", () => {
    expect(isCurrentRepositoryPath("/repo-a", "/repo-a")).toBe(true);
    expect(isCurrentRepositoryPath("/repo-b", "/repo-a")).toBe(false);
  });

  it("lays out a merge commit and rejoins its side lane", () => {
    const rows = buildCommitGraphRows([
      commit("merge", ["main-parent", "side-parent"]),
      commit("side-parent", ["base"]),
      commit("main-parent", ["base"]),
      commit("base", []),
    ]);

    expect(rows[0]).toMatchObject({ merge: true, nodeLane: 0, nodeTone: "local" });
    expect(rows[0]?.segments.filter((line) => line.start === "node")).toHaveLength(2);
    expect(rows[0]?.expansionLines).toEqual([
      { lane: 0, tone: "local" },
      { lane: 1, tone: "branch-rose" },
    ]);
    expect(rows[1]).toMatchObject({ nodeLane: 1, nodeTone: "branch-rose" });
    expect(rows[2]).toMatchObject({ nodeLane: 0, nodeTone: "local" });
    expect(rows[3]).toMatchObject({ nodeLane: 0, nodeTone: "local" });
    expect(rows[3]?.segments).toContainEqual({
      connectToNode: true,
      end: "node",
      fromLane: 1,
      start: "top",
      toLane: 0,
      tone: "branch-rose",
      type: "curve",
    });
  });

  it("renders a lone root as a solid terminal node without a redundant stem", () => {
    const continuous = buildCommitGraphRows([commit("root", [])]);
    const filtered = buildCommitGraphRows([commit("root", [])], false);

    for (const rows of [continuous, filtered]) {
      expect(rows[0]).toMatchObject({ nodeLane: 0, nodeTone: "local", segments: [] });
    }

    const connectedRows = buildCommitGraphRows([commit("child", ["root"]), commit("root", [])]);
    expect(connectedRows[1]?.segments).toContainEqual({
      end: "node",
      lane: 0,
      start: "top",
      tone: "local",
      type: "line",
    });

    const filteredChild = buildCommitGraphRows(
      [commit("filtered-child", ["hidden-parent"])],
      false,
    )[0]!;
    expect(filteredChild.segments).toEqual([]);
  });

  it("inherits stable tones from upstream and current branch lanes", () => {
    const rows = buildCommitGraphRows(
      [
        commit("upstream-tip", ["current-tip"]),
        commit("current-tip", ["base"]),
        commit("base", []),
      ],
      true,
      { currentOid: "current-tip", selectedOid: null, upstreamOid: "upstream-tip" },
    );

    expect(rows.map((row) => row.nodeTone)).toEqual(["remote", "local", "local"]);
    expect(rows[0]?.expansionLines).toEqual([{ lane: 0, tone: "remote" }]);
    expect(rows[1]?.expansionLines).toEqual([{ lane: 0, tone: "local" }]);
  });

  it("parses unified diff line numbers and change counts", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -4,3 +4,4 @@ export function example() {",
        " context",
        "-old value",
        "+new value",
        "+another value",
      ].join("\n"),
    );

    expect(diff).toMatchObject({ additions: 2, deletions: 1 });
    expect(diff.lines.filter((line) => line.kind === "context")[0]).toMatchObject({
      oldLine: 4,
      newLine: 4,
      content: "context",
    });
    expect(diff.lines.filter((line) => line.kind === "deletion")[0]).toMatchObject({
      oldLine: 5,
      newLine: null,
      content: "old value",
    });
    expect(diff.lines.filter((line) => line.kind === "addition")).toMatchObject([
      { oldLine: null, newLine: 5, content: "new value" },
      { oldLine: null, newLine: 6, content: "another value" },
    ]);
  });

  it("pairs deletion and addition blocks into side-by-side rows", () => {
    const diff = parseUnifiedDiff(
      [
        "@@ -8,4 +8,3 @@",
        " context before",
        "-old first",
        "-old second",
        "+new first",
        " context after",
      ].join("\n"),
    );

    const rows = buildSplitDiffRows(diff);
    expect(rows[1]).toMatchObject({
      kind: "code",
      old: { kind: "context", lineNumber: 8, content: "context before" },
      new: { kind: "context", lineNumber: 8, content: "context before" },
    });
    expect(rows[2]).toMatchObject({
      kind: "code",
      old: { kind: "deletion", lineNumber: 9, content: "old first" },
      new: { kind: "addition", lineNumber: 9, content: "new first" },
    });
    expect(rows[3]).toMatchObject({
      kind: "code",
      old: { kind: "deletion", lineNumber: 10, content: "old second" },
      new: null,
    });
    expect(rows[4]).toMatchObject({
      kind: "code",
      old: { kind: "context", lineNumber: 11, content: "context after" },
      new: { kind: "context", lineNumber: 10, content: "context after" },
    });
  });

  it("keeps file metadata and no-newline markers out of line counts", () => {
    const diff = parseUnifiedDiff(
      ["new file mode 100644", "@@ -0,0 +1 @@", "+hello", "\\ No newline at end of file"].join(
        "\n",
      ),
    );

    expect(diff.lines.map((line) => line.kind)).toEqual(["file", "hunk", "addition", "meta"]);
    expect(diff).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("identifies only true newly added file patches for a single-column diff", () => {
    const added = parseUnifiedDiff(
      [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+export const value = true;",
      ].join("\n"),
    );
    const additionOnlyModification = parseUnifiedDiff(
      [
        "diff --git a/existing.ts b/existing.ts",
        "--- a/existing.ts",
        "+++ b/existing.ts",
        "@@ -1 +1,2 @@",
        " existing",
        "+added",
      ].join("\n"),
    );
    const deleted = parseUnifiedDiff(
      [
        "diff --git a/removed.ts b/removed.ts",
        "deleted file mode 100644",
        "--- a/removed.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed",
      ].join("\n"),
    );

    expect(isAddedFileDiff(added)).toBe(true);
    expect(isAddedFileDiff(additionOnlyModification)).toBe(false);
    expect(isAddedFileDiff(deleted)).toBe(false);
  });

  it("does not imply missing topology for filtered history", () => {
    const rows = buildCommitGraphRows([commit("tip", ["hidden"]), commit("base", [])], false);
    expect(rows).toEqual([
      { expansionLines: [], merge: false, nodeLane: 0, nodeTone: "local", segments: [] },
      { expansionLines: [], merge: false, nodeLane: 0, nodeTone: "local", segments: [] },
    ]);
  });
});

describe("patchForFile", () => {
  const patch = [
    "diff --git a/src/first.ts b/src/first.ts",
    "--- a/src/first.ts",
    "+++ b/src/first.ts",
    "@@ -1 +1 @@",
    "-old first",
    "+new first",
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 90%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -1 +1 @@",
    "-old name",
    "+new name",
    "diff --git a/src/removed.ts b/src/removed.ts",
    "deleted file mode 100644",
    "--- a/src/removed.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed",
  ].join("\n");

  it("returns only the selected file section", () => {
    const selected = patchForFile(patch, "src/first.ts");
    expect(selected).toContain("+new first");
    expect(selected).not.toContain("new name");
  });

  it("matches renamed files by current or original path", () => {
    expect(patchForFile(patch, "src/new-name.ts", "src/old-name.ts")).toContain(
      "rename from src/old-name.ts",
    );
    expect(patchForFile(patch, "src/old-name.ts")).toContain("rename to src/new-name.ts");
  });

  it("matches deleted files and returns an empty string for unknown files", () => {
    expect(patchForFile(patch, "src/removed.ts")).toContain("+++ /dev/null");
    expect(patchForFile(patch, "src/missing.ts")).toBe("");
    expect(patchForFile("", "src/first.ts")).toBe("");
  });
});
