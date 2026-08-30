import type * as Domain from "./generated/domain";

export type * from "./generated/domain";

export interface ProjectApi {
  list(): Promise<Domain.Project[]>;
  pickRepository(): Promise<string | null>;
  pickCloneParentDirectory(): Promise<string | null>;
  pickScanParentDirectory(): Promise<string | null>;
  add(path: string): Promise<Domain.Project>;
  scan(parentDirectory: string): Promise<Domain.Project[]>;
  remove(id: string): Promise<void>;
  updateMetadata(input: Domain.ProjectMetadataUpdateInput): Promise<Domain.Project>;
  clone(remoteUrl: string, parentDirectory: string): Promise<Domain.CloneOperationStarted>;
}

export interface RepositoryApi {
  gitVersion(): Promise<Domain.GitVersion>;
  status(path: string): Promise<Domain.RepositoryStatus>;
  history(path: string, query: Domain.HistoryQuery): Promise<Domain.HistoryPage>;
  commit(path: string, oid: string): Promise<Domain.CommitDetails>;
  commitImageDiff(
    path: string,
    oid: string,
    filePath: string,
    originalPath: string | null,
  ): Promise<Domain.ImageDiff | null>;
  worktreeDiff(path: string, filePath: string, staged: boolean): Promise<Domain.WorktreeDiff>;
  conflictDetails(path: string, filePath: string): Promise<Domain.ConflictDetails>;
  resolveConflict(
    path: string,
    filePath: string,
    input: Domain.ConflictResolutionInput,
  ): Promise<Domain.RepositoryMutationResult>;
  previewMergeRecovery(path: string): Promise<Domain.MergeRecoveryPreview | null>;
  continueMergeRecovery(
    path: string,
    input: Domain.MergeRecoveryInput,
  ): Promise<Domain.RepositoryMutationResult>;
  abortMergeRecovery(
    path: string,
    input: Domain.MergeRecoveryInput,
  ): Promise<Domain.RepositoryMutationResult>;
  refs(path: string): Promise<Domain.RepositoryRefs>;
  worktrees(path: string): Promise<Domain.RepositoryWorktrees>;
  createLinkedWorktree(
    path: string,
    input: Domain.WorktreeCreateInput,
  ): Promise<Domain.RepositoryWorktrees>;
  lockWorktree(path: string, input: Domain.WorktreeLockInput): Promise<Domain.RepositoryWorktrees>;
  unlockWorktree(
    path: string,
    input: Domain.WorktreeUnlockInput,
  ): Promise<Domain.RepositoryWorktrees>;
  pruneWorktrees(
    path: string,
    input: Domain.WorktreePruneInput,
  ): Promise<Domain.RepositoryWorktrees>;
  previewRemoteEdit(path: string, name: string): Promise<Domain.RemoteEditPreview>;
  previewRemoteDelete(path: string, name: string): Promise<Domain.RemoteDeletePreview>;
  createRemote(
    path: string,
    input: Domain.RemoteCreateInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  updateRemote(
    path: string,
    input: Domain.RemoteUpdateInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  deleteRemote(
    path: string,
    input: Domain.RemoteDeleteInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  previewLocalMerge(path: string, targetFullName: string): Promise<Domain.LocalMergePreview>;
  previewRevert(path: string, targetOid: string): Promise<Domain.RevertCommitPreview>;
  revertCommit(
    path: string,
    input: Domain.RevertCommitInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  previewCherryPick(path: string, targetOid: string): Promise<Domain.CherryPickCommitPreview>;
  cherryPickCommit(
    path: string,
    input: Domain.CherryPickCommitInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  previewResetCommit(
    path: string,
    selectedOid: string,
    mode: Domain.ResetCommitMode,
  ): Promise<Domain.ResetCommitPreview>;
  resetCommit(
    path: string,
    input: Domain.ResetCommitInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  tags(path: string): Promise<Domain.RepositoryTags>;
  stashes(path: string): Promise<Domain.RepositoryStashes>;
  submodules(path: string): Promise<Domain.RepositorySubmodules>;
  stage(path: string, paths: string[]): Promise<Domain.RepositoryMutationResult>;
  stageAll(path: string): Promise<Domain.RepositoryMutationResult>;
  unstage(path: string, paths: string[]): Promise<Domain.RepositoryMutationResult>;
  unstageAll(path: string): Promise<Domain.RepositoryMutationResult>;
  discardFiles(path: string, filePaths: string[]): Promise<Domain.RepositoryMutationResult>;
  switchBranch(path: string, fullName: string): Promise<Domain.RepositoryRefsMutationResult>;
  createBranch(path: string, name: string): Promise<Domain.RepositoryRefsMutationResult>;
  createBranchAtCommit(
    path: string,
    input: Domain.BranchCreateAtCommitInput,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  deleteBranch(
    path: string,
    fullName: string,
    allowUnmerged: boolean,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  mergeLocalBranch(
    path: string,
    targetFullName: string,
    strategy: Domain.LocalMergeStrategy,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  createTag(
    path: string,
    name: string,
    targetOid: string,
    message: string | null,
  ): Promise<Domain.RepositoryTagsMutationResult>;
  deleteTag(path: string, fullName: string): Promise<Domain.RepositoryTagsMutationResult>;
  pushTag(path: string, input: Domain.RemoteTagPushInput): Promise<Domain.GitOperationStarted>;
  previewRemoteTagDelete(
    path: string,
    input: Domain.RemoteTagDeletePreviewInput,
  ): Promise<Domain.GitOperationStarted>;
  deleteRemoteTag(
    path: string,
    input: Domain.RemoteTagDeleteInput,
  ): Promise<Domain.GitOperationStarted>;
  createStash(
    path: string,
    input: Domain.StashCreateInput,
  ): Promise<Domain.RepositoryStashesMutationResult>;
  applyStash(
    path: string,
    oid: string,
    restoreIndex: boolean,
  ): Promise<Domain.RepositoryStashesMutationResult>;
  popStash(
    path: string,
    oid: string,
    restoreIndex: boolean,
  ): Promise<Domain.RepositoryStashesMutationResult>;
  dropStash(path: string, oid: string): Promise<Domain.RepositoryStashesMutationResult>;
  createTrackingBranch(
    path: string,
    remoteFullName: string,
  ): Promise<Domain.RepositoryRefsMutationResult>;
  fetch(path: string, remoteName: string): Promise<Domain.GitOperationStarted>;
  pull(path: string): Promise<Domain.GitOperationStarted>;
  push(path: string): Promise<Domain.GitOperationStarted>;
  publishBranch(
    path: string,
    input: Domain.PublishBranchInput,
  ): Promise<Domain.GitOperationStarted>;
  pushBranchTarget(
    path: string,
    input: Domain.PushBranchTargetInput,
  ): Promise<Domain.GitOperationStarted>;
  sync(path: string): Promise<Domain.GitOperationStarted>;
  createCommit(path: string, input: Domain.CommitInput): Promise<Domain.CommitCreated>;
  previewAmendAndPush(path: string): Promise<Domain.AmendAndPushPreview>;
  amendAndPush(path: string, input: Domain.AmendAndPushInput): Promise<Domain.GitOperationStarted>;
  previewAmendCommit(path: string): Promise<Domain.AmendCommitPreview>;
  amendCommit(path: string, input: Domain.AmendCommitInput): Promise<Domain.AmendCommitCreated>;
  watchWorkspace(path: string): Promise<void>;
  unwatchWorkspace(): Promise<void>;
  subscribeWorkspaceChanges(
    listener: (event: Domain.WorkspaceChangedEvent) => void,
  ): Promise<() => void>;
}

export interface GitOperationsApi {
  subscribe(listener: (event: Domain.GitOperationEvent) => void): Promise<() => void>;
  cancel(operationId: string): Promise<boolean>;
}

export interface UpdateApi {
  check(): Promise<Domain.UpdateCheckResult>;
  downloadAndInstall(requestId: string, expectedVersion: string): Promise<void>;
  restart(): Promise<void>;
  subscribeProgress(listener: (event: Domain.UpdateProgressEvent) => void): Promise<() => void>;
}

export interface DesktopApi {
  projects: ProjectApi;
  repository: RepositoryApi;
  gitOperations: GitOperationsApi;
  updates: UpdateApi;
}
