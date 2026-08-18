import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AmendCommitCreated,
  AmendCommitInput,
  AmendCommitPreview,
  BranchCreateAtCommitInput,
  CherryPickCommitInput,
  CherryPickCommitPreview,
  DesktopApi,
  CloneOperationStarted,
  CommitCreated,
  CommitDetails,
  CommitInput,
  ConflictDetails,
  ConflictResolutionInput,
  GitVersion,
  GitOperationEvent,
  GitOperationStarted,
  HistoryPage,
  ImageDiff,
  LocalMergePreview,
  MergeRecoveryInput,
  MergeRecoveryPreview,
  Project,
  ProjectMetadataUpdateInput,
  RemoteCreateInput,
  RemoteDeleteInput,
  RemoteDeletePreview,
  RemoteEditPreview,
  RemoteTagDeleteInput,
  RemoteTagDeletePreviewInput,
  RemoteTagPushInput,
  RemoteUpdateInput,
  RepositoryRefs,
  RepositoryRefsMutationResult,
  RepositoryMutationResult,
  RepositoryStashes,
  RepositoryStashesMutationResult,
  RepositorySubmodules,
  RepositoryStatus,
  RepositoryTags,
  RepositoryTagsMutationResult,
  RevertCommitInput,
  RevertCommitPreview,
  WorktreeCreateInput,
  WorktreeDiff,
  WorktreeLockInput,
  WorktreePruneInput,
  RepositoryWorktrees,
  ResetCommitInput,
  ResetCommitMode,
  ResetCommitPreview,
  UpdateCheckResult,
  UpdateProgressEvent,
  WorktreeUnlockInput,
} from "./contract";

export const tauriBridge: DesktopApi = {
  projects: {
    list: () => invoke<Project[]>("project_list"),
    async pickRepository() {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择 Git 仓库",
      });
      return typeof selected === "string" ? selected : null;
    },
    async pickCloneParentDirectory() {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择克隆目标文件夹",
      });
      return typeof selected === "string" ? selected : null;
    },
    async pickScanParentDirectory() {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择要扫描的父目录",
      });
      return typeof selected === "string" ? selected : null;
    },
    add: (path) => invoke<Project>("project_add", { path }),
    scan: (parentDirectory) => invoke<Project[]>("project_scan", { rootPath: parentDirectory }),
    remove: (id) => invoke<void>("project_remove", { id }),
    updateMetadata: (input: ProjectMetadataUpdateInput) =>
      invoke<Project>("project_update_metadata", { input }),
    clone: (remoteUrl, parentDirectory) =>
      invoke<CloneOperationStarted>("project_clone_start", { remoteUrl, parentDirectory }),
  },
  repository: {
    gitVersion: () => invoke<GitVersion>("git_version"),
    status: (path) => invoke<RepositoryStatus>("repository_status", { path }),
    history: (path, query) => invoke<HistoryPage>("repository_history", { path, query }),
    commit: (path, oid) => invoke<CommitDetails>("repository_commit", { path, oid }),
    commitImageDiff: (path, oid, filePath, originalPath) =>
      invoke<ImageDiff | null>("repository_commit_image_diff", {
        path,
        oid,
        filePath,
        originalPath,
      }),
    worktreeDiff: (path, filePath, staged) =>
      invoke<WorktreeDiff>("repository_worktree_diff", { path, filePath, staged }),
    conflictDetails: (path, filePath) =>
      invoke<ConflictDetails>("repository_conflict_details", { path, filePath }),
    resolveConflict: (path, filePath, input: ConflictResolutionInput) =>
      invoke<RepositoryMutationResult>("repository_resolve_conflict", {
        path,
        filePath,
        input,
      }),
    previewMergeRecovery: (path) =>
      invoke<MergeRecoveryPreview | null>("repository_preview_merge_recovery", { path }),
    continueMergeRecovery: (path, input: MergeRecoveryInput) =>
      invoke<RepositoryMutationResult>("repository_continue_merge_recovery", { path, input }),
    abortMergeRecovery: (path, input: MergeRecoveryInput) =>
      invoke<RepositoryMutationResult>("repository_abort_merge_recovery", { path, input }),
    refs: (path) => invoke<RepositoryRefs>("repository_refs", { path }),
    worktrees: (path) => invoke<RepositoryWorktrees>("repository_worktrees", { path }),
    createLinkedWorktree: (path, input: WorktreeCreateInput) =>
      invoke<RepositoryWorktrees>("repository_create_linked_worktree", { path, input }),
    lockWorktree: (path, input: WorktreeLockInput) =>
      invoke<RepositoryWorktrees>("repository_lock_worktree", { path, input }),
    unlockWorktree: (path, input: WorktreeUnlockInput) =>
      invoke<RepositoryWorktrees>("repository_unlock_worktree", { path, input }),
    pruneWorktrees: (path, input: WorktreePruneInput) =>
      invoke<RepositoryWorktrees>("repository_prune_worktrees", { path, input }),
    previewRemoteEdit: (path, name) =>
      invoke<RemoteEditPreview>("repository_preview_remote_edit", { path, name }),
    previewRemoteDelete: (path, name) =>
      invoke<RemoteDeletePreview>("repository_preview_remote_delete", { path, name }),
    createRemote: (path, input: RemoteCreateInput) =>
      invoke<RepositoryRefsMutationResult>("repository_create_remote", { path, input }),
    updateRemote: (path, input: RemoteUpdateInput) =>
      invoke<RepositoryRefsMutationResult>("repository_update_remote", { path, input }),
    deleteRemote: (path, input: RemoteDeleteInput) =>
      invoke<RepositoryRefsMutationResult>("repository_delete_remote", { path, input }),
    previewLocalMerge: (path, targetFullName) =>
      invoke<LocalMergePreview>("repository_preview_local_merge", { path, targetFullName }),
    previewRevert: (path, targetOid) =>
      invoke<RevertCommitPreview>("repository_preview_revert", { path, targetOid }),
    revertCommit: (path, input: RevertCommitInput) =>
      invoke<RepositoryRefsMutationResult>("repository_revert_commit", { path, input }),
    previewCherryPick: (path, targetOid) =>
      invoke<CherryPickCommitPreview>("repository_preview_cherry_pick", { path, targetOid }),
    cherryPickCommit: (path, input: CherryPickCommitInput) =>
      invoke<RepositoryRefsMutationResult>("repository_cherry_pick_commit", { path, input }),
    previewResetCommit: (path, selectedOid, mode: ResetCommitMode) =>
      invoke<ResetCommitPreview>("repository_preview_reset_commit", {
        path,
        selectedOid,
        mode,
      }),
    resetCommit: (path, input: ResetCommitInput) =>
      invoke<RepositoryRefsMutationResult>("repository_reset_commit", { path, input }),
    tags: (path) => invoke<RepositoryTags>("repository_tags", { path }),
    stashes: (path) => invoke<RepositoryStashes>("repository_stashes", { path }),
    submodules: (path) => invoke<RepositorySubmodules>("repository_submodules", { path }),
    stage: (path, paths) => invoke<RepositoryMutationResult>("repository_stage", { path, paths }),
    stageAll: (path) => invoke<RepositoryMutationResult>("repository_stage_all", { path }),
    unstage: (path, paths) =>
      invoke<RepositoryMutationResult>("repository_unstage", { path, paths }),
    unstageAll: (path) => invoke<RepositoryMutationResult>("repository_unstage_all", { path }),
    discardFiles: (path, filePaths) =>
      invoke<RepositoryMutationResult>("repository_discard_files", { path, filePaths }),
    switchBranch: (path, fullName) =>
      invoke<RepositoryRefsMutationResult>("repository_switch_branch", { path, fullName }),
    createBranch: (path, name) =>
      invoke<RepositoryRefsMutationResult>("repository_create_branch", { path, name }),
    createBranchAtCommit: (path, input: BranchCreateAtCommitInput) =>
      invoke<RepositoryRefsMutationResult>("repository_create_branch_at_commit", {
        path,
        input,
      }),
    deleteBranch: (path, fullName, allowUnmerged) =>
      invoke<RepositoryRefsMutationResult>("repository_delete_branch", {
        path,
        fullName,
        allowUnmerged,
      }),
    mergeLocalBranch: (path, targetFullName, strategy) =>
      invoke<RepositoryRefsMutationResult>("repository_merge_local_branch", {
        path,
        targetFullName,
        strategy,
      }),
    createTag: (path, name, targetOid, message) =>
      invoke<RepositoryTagsMutationResult>("repository_create_tag", {
        path,
        name,
        targetOid,
        message,
      }),
    deleteTag: (path, fullName) =>
      invoke<RepositoryTagsMutationResult>("repository_delete_tag", { path, fullName }),
    pushTag: (path, input: RemoteTagPushInput) =>
      invoke<GitOperationStarted>("repository_push_tag_start", { path, input }),
    previewRemoteTagDelete: (path, input: RemoteTagDeletePreviewInput) =>
      invoke<GitOperationStarted>("repository_preview_remote_tag_delete_start", { path, input }),
    deleteRemoteTag: (path, input: RemoteTagDeleteInput) =>
      invoke<GitOperationStarted>("repository_delete_remote_tag_start", { path, input }),
    createStash: (path, input) =>
      invoke<RepositoryStashesMutationResult>("repository_create_stash", { path, input }),
    applyStash: (path, oid, restoreIndex) =>
      invoke<RepositoryStashesMutationResult>("repository_apply_stash", {
        path,
        oid,
        restoreIndex,
      }),
    popStash: (path, oid, restoreIndex) =>
      invoke<RepositoryStashesMutationResult>("repository_pop_stash", {
        path,
        oid,
        restoreIndex,
      }),
    dropStash: (path, oid) =>
      invoke<RepositoryStashesMutationResult>("repository_drop_stash", { path, oid }),
    createTrackingBranch: (path, remoteFullName) =>
      invoke<RepositoryRefsMutationResult>("repository_create_tracking_branch", {
        path,
        remoteFullName,
      }),
    fetch: (path, remoteName) =>
      invoke<GitOperationStarted>("repository_fetch_start", { path, remoteName }),
    pull: (path) => invoke<GitOperationStarted>("repository_pull_start", { path }),
    push: (path) => invoke<GitOperationStarted>("repository_push_start", { path }),
    sync: (path) => invoke<GitOperationStarted>("repository_sync_start", { path }),
    createCommit: (path, input: CommitInput) =>
      invoke<CommitCreated>("repository_create_commit", { path, input }),
    previewAmendCommit: (path) =>
      invoke<AmendCommitPreview>("repository_preview_amend_commit", { path }),
    amendCommit: (path, input: AmendCommitInput) =>
      invoke<AmendCommitCreated>("repository_amend_commit", { path, input }),
  },
  gitOperations: {
    async subscribe(listener) {
      return listen<GitOperationEvent>("git-operation://status", (event) =>
        listener(event.payload),
      );
    },
    cancel: (operationId) => invoke<boolean>("repository_operation_cancel", { operationId }),
  },
  updates: {
    check: () => invoke<UpdateCheckResult>("update_check"),
    downloadAndInstall: (requestId, expectedVersion) =>
      invoke<void>("update_download_and_install", { requestId, expectedVersion }),
    restart: () => invoke<void>("update_restart"),
    async subscribeProgress(listener) {
      return listen<UpdateProgressEvent>("update://progress", (event) => listener(event.payload));
    },
  },
};
