import type { RepositoryStatus } from "../../platform/desktop";

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
