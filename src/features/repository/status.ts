import type { BranchStatus, FileChange, RepositoryStatus } from "../../platform/desktop";

export interface StatusSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  clean: boolean;
}

export function summarizeRepositoryStatus(status: RepositoryStatus): StatusSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const change of status.changes) {
    if (change.kind === "untracked") untracked += 1;
    if (change.kind === "unmerged") conflicted += 1;
    if (change.indexStatus && change.indexStatus !== ".") staged += 1;
    if (change.worktreeStatus && change.worktreeStatus !== ".") unstaged += 1;
  }

  return {
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: status.changes.length === 0,
  };
}

export function isCurrentStatusRequest(activeRequest: number, requestId: number) {
  return activeRequest === requestId;
}

export function isCurrentRepositoryStatusRequest(
  activeStatusRequest: number,
  statusRequestId: number,
  activeRepositoryRequest: number,
  repositoryRequestId: number,
) {
  return (
    isCurrentStatusRequest(activeStatusRequest, statusRequestId) &&
    isCurrentStatusRequest(activeRepositoryRequest, repositoryRequestId)
  );
}

function branchStatusEquals(left: BranchStatus, right: BranchStatus) {
  return (
    left.head === right.head &&
    left.oid === right.oid &&
    left.upstream === right.upstream &&
    left.ahead === right.ahead &&
    left.behind === right.behind
  );
}

function fileChangeEquals(left: FileChange, right: FileChange) {
  return (
    left.path === right.path &&
    left.originalPath === right.originalPath &&
    left.indexStatus === right.indexStatus &&
    left.worktreeStatus === right.worktreeStatus &&
    left.kind === right.kind
  );
}

/**
 * Compares two status reads by value.
 *
 * Background refreshes must not hand React a new object when nothing changed:
 * the workspace diff and merge recovery previews react to the status object's
 * identity, so an identical-but-new object would reload them for no reason.
 */
export function repositoryStatusEquals(
  left: RepositoryStatus | null,
  right: RepositoryStatus | null,
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.root !== right.root) return false;
  if (!branchStatusEquals(left.branch, right.branch)) return false;
  if (left.changes.length !== right.changes.length) return false;
  // Git reports changes in a stable order, so a positional comparison is both
  // sufficient and cheap.
  return left.changes.every((change, index) => fileChangeEquals(change, right.changes[index]));
}
