import type { BranchInfo, RepositoryRefs } from "../../platform/desktop";

export interface RemoteBranchTarget {
  branchName: string;
  fullName: string;
  oid: string;
  remoteName: string;
  shortName: string;
}

export function remoteBranchTargets(refs: RepositoryRefs): RemoteBranchTarget[] {
  const remotesBySpecificity = [...refs.remotes].sort(
    (left, right) => right.name.length - left.name.length,
  );
  return refs.branches
    .filter((branch) => branch.kind === "remote")
    .flatMap((branch) => {
      const remote = remotesBySpecificity.find((candidate) =>
        branch.fullName.startsWith(`refs/remotes/${candidate.name}/`),
      );
      if (!remote) return [];
      const branchName = branch.fullName.slice(`refs/remotes/${remote.name}/`.length);
      if (!branchName) return [];
      return [
        {
          branchName,
          fullName: branch.fullName,
          oid: branch.oid,
          remoteName: remote.name,
          shortName: branch.name,
        },
      ];
    })
    .sort((left, right) =>
      left.remoteName === right.remoteName
        ? left.branchName.localeCompare(right.branchName)
        : left.remoteName.localeCompare(right.remoteName),
    );
}

export function currentUpstreamTarget(
  branch: BranchInfo,
  targets: RemoteBranchTarget[],
): RemoteBranchTarget | null {
  if (!branch.upstream || branch.upstreamMissing) return null;
  return targets.find((target) => target.shortName === branch.upstream) ?? null;
}
