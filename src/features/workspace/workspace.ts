import type { FileChange, RepositoryStatus } from "../../platform/desktop";
import { fileTypeDescriptor } from "../../app/fileType";

export interface WorkspaceEntry {
  change: FileChange;
  staged: boolean;
}

export interface WorkspaceGroups {
  staged: WorkspaceEntry[];
  unstaged: WorkspaceEntry[];
  conflicted: WorkspaceEntry[];
}

function hasStatus(status: string | null) {
  return Boolean(status && status !== ".");
}

export function groupWorkspaceChanges(status: RepositoryStatus | null): WorkspaceGroups {
  const groups: WorkspaceGroups = { staged: [], unstaged: [], conflicted: [] };
  if (!status) return groups;

  for (const change of status.changes) {
    if (change.kind === "unmerged") {
      groups.conflicted.push({ change, staged: false });
      continue;
    }
    if (hasStatus(change.indexStatus)) groups.staged.push({ change, staged: true });
    if (change.kind === "untracked" || hasStatus(change.worktreeStatus)) {
      groups.unstaged.push({ change, staged: false });
    }
  }
  return groups;
}

export function pathspecsForChange(change: FileChange): string[] {
  return [
    ...new Set([change.originalPath, change.path].filter((path): path is string => Boolean(path))),
  ];
}

export function workspaceEntryKey(entry: WorkspaceEntry) {
  return `${entry.staged ? "staged" : "unstaged"}:${entry.change.path}`;
}

export function workspaceStatusLabel(change: FileChange, staged: boolean) {
  if (change.kind === "untracked") return "U";
  return (staged ? change.indexStatus : change.worktreeStatus) ?? "?";
}

export function workspaceFileType(path: string) {
  return fileTypeDescriptor(path).label;
}

export function workspaceMutationBlocked(refreshing: boolean, busyAction: string | null) {
  return refreshing || busyAction !== null;
}
