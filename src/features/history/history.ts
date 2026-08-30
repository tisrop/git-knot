import type { CommitFileChange, CommitSummary } from "../../platform/desktop";

export class LruCache<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("LRU cache capacity must be a positive integer");
    }
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }

  get(key: Key): Value | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as Value;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: Key, value: Value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.maxEntries) return;

    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

export const COMMIT_GRAPH_BRANCH_TONES = [
  "branch-rose",
  "branch-cyan",
  "branch-violet",
  "branch-amber",
  "branch-green",
] as const;

export type CommitGraphTone =
  | "local"
  | "remote"
  | "primary"
  | "synced"
  | "plain"
  | (typeof COMMIT_GRAPH_BRANCH_TONES)[number];

export interface CommitGraphContext {
  currentOid: string | null;
  selectedOid: string | null;
  upstreamOid: string | null;
}

export type CommitGraphSegment =
  | {
      end: "node" | "bottom";
      lane: number;
      start: "top" | "node";
      tone: CommitGraphTone;
      type: "line";
    }
  | {
      connectToNode?: boolean;
      end: "node" | "bottom";
      fromLane: number;
      merge?: boolean;
      start: "top" | "node";
      toLane: number;
      tone: CommitGraphTone;
      type: "curve";
    };

export interface CommitGraphRowLayout {
  expansionLines: Array<{ lane: number; tone: CommitGraphTone }>;
  merge: boolean;
  nodeLane: number;
  nodeTone: CommitGraphTone;
  segments: CommitGraphSegment[];
}

interface CommitGraphLane {
  id: string;
  tone: CommitGraphTone;
}

export type CommitFileTreeEntry =
  | {
      depth: number;
      kind: "directory";
      name: string;
      path: string;
    }
  | {
      depth: number;
      file: CommitFileChange;
      kind: "file";
    };

interface CommitFileTreeDirectory {
  directories: Map<string, CommitFileTreeDirectory>;
  files: CommitFileChange[];
  name: string;
  path: string;
}

export function buildCommitFileTreeEntries(files: CommitFileChange[]): CommitFileTreeEntry[] {
  const root: CommitFileTreeDirectory = {
    directories: new Map(),
    files: [],
    name: "",
    path: "",
  };

  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;

    let directory = root;
    for (const part of parts) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [], name: part, path };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }

  const entries: CommitFileTreeEntry[] = [];
  const appendDirectory = (directory: CommitFileTreeDirectory, depth: number) => {
    const directories = [...directory.directories.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const child of directories) {
      entries.push({ depth, kind: "directory", name: child.name, path: child.path });
      appendDirectory(child, depth + 1);
    }

    const directoryFiles = [...directory.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const file of directoryFiles) entries.push({ depth, file, kind: "file" });
  };

  appendDirectory(root, 0);
  return entries;
}

export type UnifiedDiffLineKind = "file" | "hunk" | "context" | "addition" | "deletion" | "meta";

export interface UnifiedDiffLine {
  content: string;
  kind: UnifiedDiffLineKind;
  newLine: number | null;
  oldLine: number | null;
}

export interface UnifiedDiff {
  additions: number;
  deletions: number;
  lines: UnifiedDiffLine[];
}

export type SplitDiffCellKind = "context" | "addition" | "deletion";

export interface SplitDiffCell {
  content: string;
  kind: SplitDiffCellKind;
  lineNumber: number;
}

export type SplitDiffRow =
  | {
      content: string;
      kind: "file" | "hunk" | "meta";
      new: null;
      old: null;
    }
  | {
      content: null;
      kind: "code";
      new: SplitDiffCell | null;
      old: SplitDiffCell | null;
    };

export interface AppendCommitsResult {
  commits: CommitSummary[];
  limitReached: boolean;
}

export function appendUniqueCommitsWithLimit(
  current: CommitSummary[],
  incoming: CommitSummary[],
  limit: number,
): AppendCommitsResult {
  const existing = new Set(current.map((commit) => commit.oid));
  const next = [...current];
  for (const commit of incoming) {
    if (existing.has(commit.oid)) continue;
    if (next.length >= limit) break;
    existing.add(commit.oid);
    next.push(commit);
  }
  return { commits: next, limitReached: next.length >= limit };
}

export interface RefreshedHistoryResult {
  commits: CommitSummary[];
  /** True when the reloaded page shares no commit with the loaded list, so the
   * already-loaded tail was discarded and pagination has to restart. */
  replaced: boolean;
}

/**
 * Merges a freshly reloaded first page into the already-loaded list.
 *
 * A background refresh only re-reads page 0, so it must splice that page onto
 * whatever the user had paged in without resetting their scroll position. The
 * reloaded page is authoritative for the part of history it covers: the tail is
 * kept only from the point where the two lists meet again, which drops commits
 * that a rewrite removed instead of leaving them stranded above their
 * replacements.
 *
 * When the two lists share nothing (a switch to unrelated history), the fresh
 * page replaces the list entirely.
 */
export function mergeRefreshedHistoryPage(
  current: CommitSummary[],
  refreshed: CommitSummary[],
  limit: number,
): RefreshedHistoryResult {
  if (current.length === 0) {
    return { commits: refreshed, replaced: true };
  }

  const refreshedOids = new Set(refreshed.map((commit) => commit.oid));
  const rejoinIndex = current.findIndex((commit) => refreshedOids.has(commit.oid));
  if (rejoinIndex === -1) {
    return { commits: refreshed, replaced: true };
  }

  const tail = current
    .slice(rejoinIndex)
    .filter((commit) => !refreshedOids.has(commit.oid))
    .slice(0, Math.max(0, limit - refreshed.length));
  const commits = [...refreshed, ...tail];
  // Keep the previous array identity when nothing moved, so downstream graph
  // and list memos are not invalidated by an unchanged background refresh.
  const unchanged =
    commits.length === current.length &&
    commits.every((commit, index) => commit.oid === current[index].oid);
  return { commits: unchanged ? current : commits, replaced: false };
}

export function parseUnifiedDiff(patch: string): UnifiedDiff {
  const lines: UnifiedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      lines.push({ content: rawLine, kind: "hunk", oldLine: null, newLine: null });
      continue;
    }

    if (inHunk && rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      lines.push({ content: rawLine.slice(1), kind: "addition", oldLine: null, newLine });
      additions += 1;
      newLine += 1;
      continue;
    }

    if (inHunk && rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      lines.push({ content: rawLine.slice(1), kind: "deletion", oldLine, newLine: null });
      deletions += 1;
      oldLine += 1;
      continue;
    }

    if (inHunk && rawLine.startsWith(" ")) {
      lines.push({ content: rawLine.slice(1), kind: "context", oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("\\ No newline at end of file")) {
      lines.push({ content: rawLine, kind: "meta", oldLine: null, newLine: null });
      continue;
    }

    const isFileMetadata =
      rawLine.startsWith("diff --git ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ") ||
      rawLine.startsWith("new file mode ") ||
      rawLine.startsWith("deleted file mode ") ||
      rawLine.startsWith("old mode ") ||
      rawLine.startsWith("new mode ") ||
      rawLine.startsWith("similarity index ") ||
      rawLine.startsWith("rename from ") ||
      rawLine.startsWith("rename to ") ||
      rawLine.startsWith("copy from ") ||
      rawLine.startsWith("copy to ") ||
      rawLine.startsWith("Binary files ");
    lines.push({
      content: rawLine,
      kind: isFileMetadata ? "file" : "meta",
      oldLine: null,
      newLine: null,
    });
  }

  return { additions, deletions, lines };
}

export function isAddedFileDiff(diff: UnifiedDiff) {
  if (diff.deletions > 0) return false;
  return diff.lines.some(
    (line) =>
      line.kind === "file" &&
      (line.content.startsWith("new file mode ") || line.content === "--- /dev/null"),
  );
}

export function buildSplitDiffRows(diff: UnifiedDiff): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let index = 0;

  while (index < diff.lines.length) {
    const line = diff.lines[index]!;

    if (line.kind === "addition" || line.kind === "deletion") {
      const deletions: UnifiedDiffLine[] = [];
      const additions: UnifiedDiffLine[] = [];
      while (index < diff.lines.length) {
        const changedLine = diff.lines[index]!;
        if (changedLine.kind !== "addition" && changedLine.kind !== "deletion") break;
        if (changedLine.kind === "deletion") deletions.push(changedLine);
        else additions.push(changedLine);
        index += 1;
      }

      const rowCount = Math.max(deletions.length, additions.length);
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const deletion = deletions[rowIndex];
        const addition = additions[rowIndex];
        rows.push({
          content: null,
          kind: "code",
          old: deletion
            ? {
                content: deletion.content,
                kind: "deletion",
                lineNumber: deletion.oldLine!,
              }
            : null,
          new: addition
            ? {
                content: addition.content,
                kind: "addition",
                lineNumber: addition.newLine!,
              }
            : null,
        });
      }
      continue;
    }

    if (line.kind === "context") {
      rows.push({
        content: null,
        kind: "code",
        old: { content: line.content, kind: "context", lineNumber: line.oldLine! },
        new: { content: line.content, kind: "context", lineNumber: line.newLine! },
      });
    } else {
      rows.push({ content: line.content, kind: line.kind, old: null, new: null });
    }
    index += 1;
  }

  return rows;
}

export function isCurrentRepositoryPath(activeRepositoryPath: string, repositoryPath: string) {
  return activeRepositoryPath === repositoryPath;
}

export function shortCommitOid(oid: string) {
  return oid.slice(0, 8);
}

export function commitFileStatusLabel(status: string) {
  const kind = status.charAt(0);
  if (kind === "A") return "新增";
  if (kind === "D") return "删除";
  if (kind === "M") return "修改";
  if (kind === "R") return "重命名";
  if (kind === "C") return "复制";
  if (kind === "T") return "类型变化";
  return status || "变化";
}

function patchSectionMatchesFile(section: string, path: string, originalPath: string | null) {
  const candidates = [path, originalPath].filter((value): value is string => Boolean(value));
  const lines = section.split("\n");
  const headerLines = lines.slice(0, Math.min(lines.length, 12));

  return candidates.some((candidate) =>
    headerLines.some(
      (line) =>
        line === `+++ b/${candidate}` ||
        line === `--- a/${candidate}` ||
        line === `rename from ${candidate}` ||
        line === `rename to ${candidate}` ||
        line.includes(` a/${candidate} b/${candidate}`) ||
        line.endsWith(` a/${candidate}`) ||
        line.endsWith(` b/${candidate}`),
    ),
  );
}

export function patchForFile(patch: string, path: string, originalPath: string | null = null) {
  if (!patch.trim() || !path) return "";
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  return (
    sections.find((section) => patchSectionMatchesFile(section, path, originalPath))?.trimEnd() ??
    ""
  );
}

export function formatCommitDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function buildCommitGraphRows(
  commits: CommitSummary[],
  continuous = true,
  context: CommitGraphContext = { currentOid: null, selectedOid: null, upstreamOid: null },
): CommitGraphRowLayout[] {
  const rowTones = buildCommitGraphTones(commits, context);
  if (!continuous) {
    return commits.map((commit) => ({
      expansionLines: [],
      merge: false,
      nodeLane: 0,
      nodeTone: normalizeCommitGraphTone(rowTones.get(commit.oid)),
      segments: [],
    }));
  }

  const visibleOids = new Set(commits.map((commit) => commit.oid));
  const commitsByOid = new Map(commits.map((commit) => [commit.oid, commit]));
  let previousOutputLanes: CommitGraphLane[] = [];
  let branchToneIndex = 0;

  return commits.map((commit) => {
    const parents = commit.parentOids.filter((oid) => visibleOids.has(oid));
    const inputLanes = previousOutputLanes.map((lane) => ({ ...lane }));
    const inputIndex = inputLanes.findIndex((lane) => lane.id === commit.oid);
    const nodeLane = inputIndex >= 0 ? inputIndex : inputLanes.length;
    const directTone = commitGraphRefTone(commit.oid, context);
    const inheritedTone = normalizeCommitGraphTone(rowTones.get(commit.oid));
    const outputLanes: CommitGraphLane[] = [];
    let firstParentAdded = false;

    if (parents.length > 0) {
      for (const lane of inputLanes) {
        if (lane.id === commit.oid) {
          if (!firstParentAdded) {
            outputLanes.push({
              id: parents[0]!,
              tone: normalizeCommitGraphTone(directTone ?? lane.tone),
            });
            firstParentAdded = true;
          }
          continue;
        }
        outputLanes.push({ ...lane });
      }
    } else {
      for (const lane of inputLanes) {
        if (lane.id !== commit.oid) outputLanes.push({ ...lane });
      }
    }

    for (
      let parentIndex = firstParentAdded ? 1 : 0;
      parentIndex < parents.length;
      parentIndex += 1
    ) {
      const parentOid = parents[parentIndex]!;
      const parentCommit = commitsByOid.get(parentOid);
      const parentTone =
        parentIndex === 0
          ? (directTone ?? rowTones.get(commit.oid))
          : parentCommit
            ? commitGraphRefTone(parentCommit.oid, context)
            : undefined;
      outputLanes.push({
        id: parentOid,
        tone: normalizeCommitGraphTone(parentTone ?? commitGraphBranchTone(branchToneIndex)),
      });
      if (!parentTone) {
        branchToneIndex += 1;
      }
    }

    const nodeTone = normalizeCommitGraphTone(
      outputLanes[nodeLane]?.tone ?? inputLanes[nodeLane]?.tone ?? directTone ?? inheritedTone,
    );
    const segments: CommitGraphSegment[] = [];
    const expansionLines = new Map<number, { lane: number; tone: CommitGraphTone }>();
    let outputLaneIndex = 0;

    for (let index = 0; index < inputLanes.length; index += 1) {
      const inputLane = inputLanes[index]!;
      if (inputLane.id === commit.oid) {
        if (index !== nodeLane) {
          segments.push({
            connectToNode: true,
            end: "node",
            fromLane: index,
            start: "top",
            toLane: nodeLane,
            tone: inputLane.tone,
            type: "curve",
          });
        } else {
          outputLaneIndex += 1;
        }
        continue;
      }

      while (
        outputLaneIndex < outputLanes.length &&
        outputLanes[outputLaneIndex]?.id === commit.oid
      ) {
        outputLaneIndex += 1;
      }

      if (
        outputLaneIndex < outputLanes.length &&
        inputLane.id === outputLanes[outputLaneIndex]?.id
      ) {
        if (index === outputLaneIndex) {
          segments.push({
            end: "bottom",
            lane: index,
            start: "top",
            tone: inputLane.tone,
            type: "line",
          });
        } else {
          segments.push({
            end: "bottom",
            fromLane: index,
            start: "top",
            toLane: outputLaneIndex,
            tone: inputLane.tone,
            type: "curve",
          });
        }
        expansionLines.set(outputLaneIndex, {
          lane: outputLaneIndex,
          tone: inputLane.tone,
        });
        outputLaneIndex += 1;
      }
    }

    if (inputIndex >= 0) {
      segments.push({
        end: "node",
        lane: nodeLane,
        start: "top",
        tone: inputLanes[inputIndex]!.tone,
        type: "line",
      });
    }

    if (parents.length > 0) {
      const outputTone = outputLanes[nodeLane]?.tone ?? nodeTone;
      segments.push({
        end: "bottom",
        lane: nodeLane,
        start: "node",
        tone: outputTone,
        type: "line",
      });
      expansionLines.set(nodeLane, { lane: nodeLane, tone: outputTone });

      for (let parentIndex = 1; parentIndex < parents.length; parentIndex += 1) {
        const parentLane = findLastCommitGraphLane(outputLanes, parents[parentIndex]!);
        if (parentLane < 0 || parentLane === nodeLane) continue;
        const tone = outputLanes[parentLane]!.tone;
        segments.push({
          end: "bottom",
          fromLane: nodeLane,
          merge: true,
          start: "node",
          toLane: parentLane,
          tone,
          type: "curve",
        });
        expansionLines.set(parentLane, { lane: parentLane, tone });
      }
    }

    previousOutputLanes = outputLanes;
    return {
      expansionLines: [...expansionLines.values()].sort((left, right) => left.lane - right.lane),
      merge: commit.parentOids.length > 1,
      nodeLane,
      nodeTone,
      segments,
    };
  });
}

function buildCommitGraphTones(
  commits: CommitSummary[],
  context: CommitGraphContext,
): Map<string, CommitGraphTone> {
  const tones = new Map<string, CommitGraphTone>();
  let activeTone: CommitGraphTone = "plain";
  for (const commit of commits) {
    const tone: CommitGraphTone = commitGraphRefTone(commit.oid, context) ?? activeTone;
    tones.set(commit.oid, tone);
    if (tone !== "plain") activeTone = tone;
  }
  return tones;
}

function commitGraphRefTone(oid: string, context: CommitGraphContext): CommitGraphTone | undefined {
  const current = context.currentOid === oid;
  const upstream = context.upstreamOid === oid;
  if (current && upstream) return "synced";
  if (current) return "local";
  if (upstream) return "remote";
  if (context.selectedOid === oid) return "primary";
  return undefined;
}

function normalizeCommitGraphTone(tone: CommitGraphTone | undefined): CommitGraphTone {
  return tone && tone !== "plain" ? tone : "local";
}

function commitGraphBranchTone(index: number): CommitGraphTone {
  return COMMIT_GRAPH_BRANCH_TONES[Math.max(0, index - 1) % COMMIT_GRAPH_BRANCH_TONES.length];
}

function findLastCommitGraphLane(lanes: CommitGraphLane[], id: string) {
  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    if (lanes[index]?.id === id) return index;
  }
  return -1;
}
