import type { BranchInfo, RepositoryRefs } from "../../platform/desktop";

export interface BranchGroups {
  local: BranchInfo[];
  remote: BranchInfo[];
}

export function groupBranches(refs: RepositoryRefs | null, query = ""): BranchGroups {
  const normalized = query.trim().toLocaleLowerCase();
  const groups: BranchGroups = { local: [], remote: [] };
  if (!refs) return groups;

  for (const branch of refs.branches) {
    if (normalized && !branch.name.toLocaleLowerCase().includes(normalized)) continue;
    groups[branch.kind].push(branch);
  }
  return groups;
}

export function isCurrentRepositoryRequest(
  activeRepositoryPath: string,
  repositoryPath: string,
  activeRequest: number,
  requestId: number,
) {
  return activeRepositoryPath === repositoryPath && activeRequest === requestId;
}

export function branchDivergenceLabel(branch: BranchInfo) {
  if (branch.upstreamMissing) return "上游已丢失";
  const parts: string[] = [];
  if (branch.ahead > 0) parts.push(`领先 ${branch.ahead}`);
  if (branch.behind > 0) parts.push(`落后 ${branch.behind}`);
  return parts.join(" · ");
}

export function canSubmitRemoteCreate(name: string, fetchUrl: string) {
  return Boolean(name.trim() && fetchUrl.trim());
}

export function canSubmitRemoteUpdate(fetchUrl: string, pushUrl: string, resetPushUrl: boolean) {
  return Boolean(fetchUrl.trim() || pushUrl.trim() || resetPushUrl);
}
