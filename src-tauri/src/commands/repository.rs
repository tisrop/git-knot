use crate::domain::{
    AmendCommitCreated, AmendCommitInput, AmendCommitPreview, BranchCreateAtCommitInput,
    CherryPickCommitInput, CherryPickCommitPreview, CommitCreated, CommitDetails, CommitInput,
    ConflictDetails, ConflictResolutionInput, GitOperationEvent, GitOperationKind,
    GitOperationStarted, GitOperationState, HistoryPage, HistoryQuery, LocalMergePreview,
    LocalMergeStrategy, MergeRecoveryInput, MergeRecoveryPreview, RemoteCreateInput,
    RemoteDeleteInput, RemoteDeletePreview, RemoteEditPreview, RemoteTagDeleteInput,
    RemoteTagDeletePreviewInput, RemoteTagPushInput, RemoteUpdateInput, RepositoryMutationResult,
    RepositoryRefs, RepositoryRefsMutationResult, RepositoryStashes,
    RepositoryStashesMutationResult, RepositoryStatus, RepositorySubmodules, RepositoryTags,
    RepositoryTagsMutationResult, RepositoryWorktrees, ResetCommitInput, ResetCommitMode,
    ResetCommitPreview, RevertCommitInput, RevertCommitPreview, StashCreateInput,
    WorktreeCreateInput, WorktreeDiff, WorktreeLockInput, WorktreePruneInput, WorktreeUnlockInput,
    GIT_OPERATION_EVENT,
};
use crate::error::CommandError;
use crate::infrastructure::git::FetchProgress;
use crate::state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn task_error(operation: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new("git_task_failed", format!("{operation}任务失败：{error}"))
}

fn emit_operation(app: &AppHandle, event: GitOperationEvent) {
    let _ = app.emit(GIT_OPERATION_EVENT, event);
}

#[tauri::command]
pub async fn repository_status(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryStatus, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.status(&path))
        .await
        .map_err(|error| task_error("仓库状态", error))?
}

#[tauri::command]
pub async fn repository_history(
    path: String,
    query: HistoryQuery,
    state: State<'_, AppState>,
) -> Result<HistoryPage, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.history(&path, &query))
        .await
        .map_err(|error| task_error("提交历史", error))?
}

#[tauri::command]
pub async fn repository_commit(
    path: String,
    oid: String,
    state: State<'_, AppState>,
) -> Result<CommitDetails, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.commit_details(&path, &oid))
        .await
        .map_err(|error| task_error("提交详情", error))?
}

#[tauri::command]
pub async fn repository_commit_image_diff(
    path: String,
    oid: String,
    file_path: String,
    original_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<crate::domain::ImageDiff>, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.commit_image_diff(&path, &oid, &file_path, original_path.as_deref())
    })
    .await
    .map_err(|error| task_error("提交图片差异", error))?
}

#[tauri::command]
pub async fn repository_worktree_diff(
    path: String,
    file_path: String,
    staged: bool,
    state: State<'_, AppState>,
) -> Result<WorktreeDiff, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.worktree_diff(&path, &file_path, staged)
    })
    .await
    .map_err(|error| task_error("工作区差异", error))?
}

#[tauri::command]
pub async fn repository_conflict_details(
    path: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<ConflictDetails, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.conflict_details(&path, &file_path))
        .await
        .map_err(|error| task_error("冲突详情", error))?
}

#[tauri::command]
pub async fn repository_resolve_conflict(
    path: String,
    file_path: String,
    input: ConflictResolutionInput,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.resolve_conflict(&path, &file_path, &input)
    })
    .await
    .map_err(|error| task_error("解决冲突", error))?
}

#[tauri::command]
pub async fn repository_preview_merge_recovery(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<MergeRecoveryPreview>, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_merge_recovery(&path))
        .await
        .map_err(|error| task_error("预览合并恢复", error))?
}

#[tauri::command]
pub async fn repository_continue_merge_recovery(
    path: String,
    input: MergeRecoveryInput,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.continue_merge_recovery(&path, &input))
        .await
        .map_err(|error| task_error("继续合并", error))?
}

#[tauri::command]
pub async fn repository_abort_merge_recovery(
    path: String,
    input: MergeRecoveryInput,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.abort_merge_recovery(&path, &input))
        .await
        .map_err(|error| task_error("终止合并", error))?
}

#[tauri::command]
pub async fn repository_refs(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryRefs, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.refs(&path))
        .await
        .map_err(|error| task_error("分支与远端", error))?
}

#[tauri::command]
pub async fn repository_worktrees(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryWorktrees, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.worktrees(&path))
        .await
        .map_err(|error| task_error("工作树列表", error))?
}

#[tauri::command]
pub async fn repository_create_linked_worktree(
    path: String,
    input: WorktreeCreateInput,
    state: State<'_, AppState>,
) -> Result<RepositoryWorktrees, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_linked_worktree(&path, &input))
        .await
        .map_err(|error| task_error("创建关联工作树", error))?
}

#[tauri::command]
pub async fn repository_lock_worktree(
    path: String,
    input: WorktreeLockInput,
    state: State<'_, AppState>,
) -> Result<RepositoryWorktrees, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.lock_worktree(&path, &input))
        .await
        .map_err(|error| task_error("锁定关联工作树", error))?
}

#[tauri::command]
pub async fn repository_unlock_worktree(
    path: String,
    input: WorktreeUnlockInput,
    state: State<'_, AppState>,
) -> Result<RepositoryWorktrees, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.unlock_worktree(&path, &input))
        .await
        .map_err(|error| task_error("解锁关联工作树", error))?
}

#[tauri::command]
pub async fn repository_prune_worktrees(
    path: String,
    input: WorktreePruneInput,
    state: State<'_, AppState>,
) -> Result<RepositoryWorktrees, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.prune_worktrees(&path, &input))
        .await
        .map_err(|error| task_error("清理失效工作树", error))?
}

#[tauri::command]
pub async fn repository_preview_remote_edit(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<RemoteEditPreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_remote_edit(&path, &name))
        .await
        .map_err(|error| task_error("预览远端编辑", error))?
}

#[tauri::command]
pub async fn repository_preview_remote_delete(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<RemoteDeletePreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_remote_delete(&path, &name))
        .await
        .map_err(|error| task_error("预览远端删除", error))?
}

#[tauri::command]
pub async fn repository_create_remote(
    path: String,
    input: RemoteCreateInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_remote(&path, &input))
        .await
        .map_err(|error| task_error("创建远端", error))?
}

#[tauri::command]
pub async fn repository_update_remote(
    path: String,
    input: RemoteUpdateInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.update_remote(&path, &input))
        .await
        .map_err(|error| task_error("更新远端", error))?
}

#[tauri::command]
pub async fn repository_delete_remote(
    path: String,
    input: RemoteDeleteInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.delete_remote(&path, &input))
        .await
        .map_err(|error| task_error("删除远端", error))?
}

#[tauri::command]
pub async fn repository_preview_local_merge(
    path: String,
    target_full_name: String,
    state: State<'_, AppState>,
) -> Result<LocalMergePreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.preview_local_merge(&path, &target_full_name)
    })
    .await
    .map_err(|error| task_error("预览本地分支合并", error))?
}

#[tauri::command]
pub async fn repository_preview_revert(
    path: String,
    target_oid: String,
    state: State<'_, AppState>,
) -> Result<RevertCommitPreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_revert(&path, &target_oid))
        .await
        .map_err(|error| task_error("预览撤销提交", error))?
}

#[tauri::command]
pub async fn repository_revert_commit(
    path: String,
    input: RevertCommitInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.revert_commit(&path, &input))
        .await
        .map_err(|error| task_error("撤销提交", error))?
}

#[tauri::command]
pub async fn repository_preview_cherry_pick(
    path: String,
    target_oid: String,
    state: State<'_, AppState>,
) -> Result<CherryPickCommitPreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_cherry_pick(&path, &target_oid))
        .await
        .map_err(|error| task_error("预览 Cherry-pick", error))?
}

#[tauri::command]
pub async fn repository_cherry_pick_commit(
    path: String,
    input: CherryPickCommitInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.cherry_pick_commit(&path, &input))
        .await
        .map_err(|error| task_error("Cherry-pick 提交", error))?
}

#[tauri::command]
pub async fn repository_preview_reset_commit(
    path: String,
    selected_oid: String,
    mode: ResetCommitMode,
    state: State<'_, AppState>,
) -> Result<ResetCommitPreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.preview_reset_commit(&path, &selected_oid, mode)
    })
    .await
    .map_err(|error| task_error("预览重置提交", error))?
}

#[tauri::command]
pub async fn repository_reset_commit(
    path: String,
    input: ResetCommitInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.reset_commit(&path, &input))
        .await
        .map_err(|error| task_error("重置提交", error))?
}

#[tauri::command]
pub async fn repository_tags(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryTags, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.tags(&path))
        .await
        .map_err(|error| task_error("标签列表", error))?
}

#[tauri::command]
pub async fn repository_stashes(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryStashes, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.stashes(&path))
        .await
        .map_err(|error| task_error("储藏列表", error))?
}

#[tauri::command]
pub async fn repository_submodules(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositorySubmodules, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.submodules(&path))
        .await
        .map_err(|error| task_error("子模块列表", error))?
}

#[tauri::command]
pub async fn repository_stage(
    path: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.stage(&path, &paths))
        .await
        .map_err(|error| task_error("暂存", error))?
}

#[tauri::command]
pub async fn repository_stage_all(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.stage_all(&path))
        .await
        .map_err(|error| task_error("暂存全部", error))?
}

#[tauri::command]
pub async fn repository_unstage(
    path: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.unstage(&path, &paths))
        .await
        .map_err(|error| task_error("取消暂存", error))?
}

#[tauri::command]
pub async fn repository_unstage_all(
    path: String,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.unstage_all(&path))
        .await
        .map_err(|error| task_error("取消暂存全部", error))?
}

#[tauri::command]
pub async fn repository_discard_files(
    path: String,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<RepositoryMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.discard_files(&path, &file_paths))
        .await
        .map_err(|error| task_error("批量放弃文件更改", error))?
}

#[tauri::command]
pub async fn repository_switch_branch(
    path: String,
    full_name: String,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.switch_branch(&path, &full_name))
        .await
        .map_err(|error| task_error("切换分支", error))?
}

#[tauri::command]
pub async fn repository_create_branch(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_branch(&path, &name))
        .await
        .map_err(|error| task_error("创建分支", error))?
}

#[tauri::command]
pub async fn repository_create_branch_at_commit(
    path: String,
    input: BranchCreateAtCommitInput,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_branch_at_commit(&path, &input))
        .await
        .map_err(|error| task_error("从提交创建分支", error))?
}

#[tauri::command]
pub async fn repository_delete_branch(
    path: String,
    full_name: String,
    allow_unmerged: bool,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.delete_branch(&path, &full_name, allow_unmerged)
    })
    .await
    .map_err(|error| task_error("删除分支", error))?
}

#[tauri::command]
pub async fn repository_merge_local_branch(
    path: String,
    target_full_name: String,
    strategy: LocalMergeStrategy,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.merge_local_branch(&path, &target_full_name, strategy)
    })
    .await
    .map_err(|error| task_error("合并本地分支", error))?
}

#[tauri::command]
pub async fn repository_create_tag(
    path: String,
    name: String,
    target_oid: String,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<RepositoryTagsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.create_tag(&path, &name, &target_oid, message.as_deref())
    })
    .await
    .map_err(|error| task_error("创建标签", error))?
}

#[tauri::command]
pub async fn repository_delete_tag(
    path: String,
    full_name: String,
    state: State<'_, AppState>,
) -> Result<RepositoryTagsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.delete_tag(&path, &full_name))
        .await
        .map_err(|error| task_error("删除标签", error))?
}

#[tauri::command]
pub async fn repository_create_stash(
    path: String,
    input: StashCreateInput,
    state: State<'_, AppState>,
) -> Result<RepositoryStashesMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_stash(&path, &input))
        .await
        .map_err(|error| task_error("创建储藏", error))?
}

#[tauri::command]
pub async fn repository_apply_stash(
    path: String,
    oid: String,
    restore_index: bool,
    state: State<'_, AppState>,
) -> Result<RepositoryStashesMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.apply_stash(&path, &oid, restore_index))
        .await
        .map_err(|error| task_error("应用储藏", error))?
}

#[tauri::command]
pub async fn repository_pop_stash(
    path: String,
    oid: String,
    restore_index: bool,
    state: State<'_, AppState>,
) -> Result<RepositoryStashesMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.pop_stash(&path, &oid, restore_index))
        .await
        .map_err(|error| task_error("弹出储藏", error))?
}

#[tauri::command]
pub async fn repository_drop_stash(
    path: String,
    oid: String,
    state: State<'_, AppState>,
) -> Result<RepositoryStashesMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.drop_stash(&path, &oid))
        .await
        .map_err(|error| task_error("删除储藏", error))?
}

#[tauri::command]
pub async fn repository_create_tracking_branch(
    path: String,
    remote_full_name: String,
    state: State<'_, AppState>,
) -> Result<RepositoryRefsMutationResult, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || {
        repository.create_tracking_branch(&path, &remote_full_name)
    })
    .await
    .map_err(|error| task_error("创建跟踪分支", error))?
}

#[tauri::command]
pub async fn repository_fetch_start(
    path: String,
    remote_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::Fetch,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: format!("正在等待获取远端 {remote_name}"),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started_remote_name = remote_name.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::Fetch,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: format!("正在连接远端 {started_remote_name}"),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::Fetch,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository.fetch(
            &PathBuf::from(&repository_path),
            &remote_name,
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::Fetch,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: format!("已获取远端 {remote_name}"),
                remote_tag_delete_preview: None,
            },
            Err(error) => {
                let state = match error.code {
                    "git_operation_cancelled" => GitOperationState::Cancelled,
                    "git_operation_timed_out" => GitOperationState::TimedOut,
                    _ => GitOperationState::Failed,
                };
                GitOperationEvent {
                    operation_id: task_operation_id.clone(),
                    repository_path,
                    kind: GitOperationKind::Fetch,
                    state,
                    phase: Some("completed".to_owned()),
                    percent: None,
                    message: error.message,
                    remote_tag_delete_preview: None,
                }
            }
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_pull_start(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::Pull,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: "正在等待安全 Pull".to_owned(),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::Pull,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: "正在获取当前分支的远端上游".to_owned(),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::Pull,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository.pull(
            &PathBuf::from(&repository_path),
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::Pull,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: "已通过仅快进方式更新当前分支".to_owned(),
                remote_tag_delete_preview: None,
            },
            Err(error) => {
                let state = match error.code {
                    "git_operation_cancelled" => GitOperationState::Cancelled,
                    "git_operation_timed_out" => GitOperationState::TimedOut,
                    _ => GitOperationState::Failed,
                };
                GitOperationEvent {
                    operation_id: task_operation_id.clone(),
                    repository_path,
                    kind: GitOperationKind::Pull,
                    state,
                    phase: Some("completed".to_owned()),
                    percent: None,
                    message: error.message,
                    remote_tag_delete_preview: None,
                }
            }
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_push_start(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::Push,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: "正在等待 Push".to_owned(),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::Push,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: "正在推送当前分支到远端上游".to_owned(),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::Push,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository.push(
            &PathBuf::from(&repository_path),
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::Push,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: "已推送当前分支到远端上游".to_owned(),
                remote_tag_delete_preview: None,
            },
            Err(error) => {
                let state = match error.code {
                    "git_operation_cancelled" => GitOperationState::Cancelled,
                    "git_operation_timed_out" => GitOperationState::TimedOut,
                    _ => GitOperationState::Failed,
                };
                GitOperationEvent {
                    operation_id: task_operation_id.clone(),
                    repository_path,
                    kind: GitOperationKind::Push,
                    state,
                    phase: Some("completed".to_owned()),
                    percent: None,
                    message: error.message,
                    remote_tag_delete_preview: None,
                }
            }
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_sync_start(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::Sync,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: "正在等待同步当前分支".to_owned(),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::Sync,
                    state: GitOperationState::Running,
                    phase: Some("pulling".to_owned()),
                    percent: None,
                    message: "正在拉取当前分支的远端上游".to_owned(),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::Sync,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository.sync(
            &PathBuf::from(&repository_path),
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::Sync,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: "已同步当前分支".to_owned(),
                remote_tag_delete_preview: None,
            },
            Err(error) => {
                let state = match error.code {
                    "git_operation_cancelled" => GitOperationState::Cancelled,
                    "git_operation_timed_out" => GitOperationState::TimedOut,
                    _ => GitOperationState::Failed,
                };
                GitOperationEvent {
                    operation_id: task_operation_id.clone(),
                    repository_path,
                    kind: GitOperationKind::Sync,
                    state,
                    phase: Some("completed".to_owned()),
                    percent: None,
                    message: error.message,
                    remote_tag_delete_preview: None,
                }
            }
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_push_tag_start(
    path: String,
    input: RemoteTagPushInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();
    let queued_tag = input.full_name.clone();
    let queued_remote = input.remote_name.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::TagPush,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: format!("正在等待发布 {queued_tag} 到远端 {queued_remote}"),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started_tag = input.full_name.clone();
        let started_remote = input.remote_name.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::TagPush,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: format!("正在发布 {started_tag} 到远端 {started_remote}"),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::TagPush,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let remote_name = input.remote_name.clone();
        let full_name = input.full_name.clone();
        let result = repository.push_remote_tag(
            &PathBuf::from(&repository_path),
            &input,
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagPush,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: format!("已发布 {full_name} 到远端 {remote_name}"),
                remote_tag_delete_preview: None,
            },
            Err(error) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagPush,
                state: operation_error_state(&error),
                phase: Some("completed".to_owned()),
                percent: None,
                message: error.message,
                remote_tag_delete_preview: None,
            },
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_preview_remote_tag_delete_start(
    path: String,
    input: RemoteTagDeletePreviewInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();
    let queued_tag = input.full_name.clone();
    let queued_remote = input.remote_name.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::TagDeletePreview,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: format!("正在等待读取远端 {queued_remote} 的 {queued_tag}"),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started_tag = input.full_name.clone();
        let started_remote = input.remote_name.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::TagDeletePreview,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: format!("正在读取远端 {started_remote} 的 {started_tag}"),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::TagDeletePreview,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository.preview_remote_tag_delete(
            &PathBuf::from(&repository_path),
            &input,
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(preview) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagDeletePreview,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: format!("已读取远端 {} 的标签 {}", preview.remote_name, preview.name),
                remote_tag_delete_preview: Some(preview),
            },
            Err(error) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagDeletePreview,
                state: operation_error_state(&error),
                phase: Some("completed".to_owned()),
                percent: None,
                message: error.message,
                remote_tag_delete_preview: None,
            },
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub async fn repository_delete_remote_tag_start(
    path: String,
    input: RemoteTagDeleteInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GitOperationStarted, CommandError> {
    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let repository_path = path.clone();
    let task_operation_id = operation_id.clone();
    let queued_tag = input.full_name.clone();
    let queued_remote = input.remote_name.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::TagDelete,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: format!("正在等待从远端 {queued_remote} 删除 {queued_tag}"),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started_tag = input.full_name.clone();
        let started_remote = input.remote_name.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::TagDelete,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: format!("正在从远端 {started_remote} 删除 {started_tag}"),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::TagDelete,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let remote_name = input.remote_name.clone();
        let full_name = input.full_name.clone();
        let result = repository.delete_remote_tag(
            &PathBuf::from(&repository_path),
            &input,
            cancellation,
            started,
            progress,
        );
        let event = match result {
            Ok(()) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagDelete,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: format!("已从远端 {remote_name} 删除 {full_name}"),
                remote_tag_delete_preview: None,
            },
            Err(error) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path,
                kind: GitOperationKind::TagDelete,
                state: operation_error_state(&error),
                phase: Some("completed".to_owned()),
                percent: None,
                message: error.message,
                remote_tag_delete_preview: None,
            },
        };
        emit_operation(&app, event);
    });

    Ok(GitOperationStarted { operation_id })
}

#[tauri::command]
pub fn repository_operation_cancel(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    state.git_operations.cancel(&operation_id)
}

fn operation_error_state(error: &CommandError) -> GitOperationState {
    match error.code {
        "git_operation_cancelled" => GitOperationState::Cancelled,
        "git_operation_timed_out" => GitOperationState::TimedOut,
        _ => GitOperationState::Failed,
    }
}

#[tauri::command]
pub async fn repository_create_commit(
    path: String,
    input: CommitInput,
    state: State<'_, AppState>,
) -> Result<CommitCreated, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.create_commit(&path, &input))
        .await
        .map_err(|error| task_error("创建提交", error))?
}

#[tauri::command]
pub async fn repository_preview_amend_commit(
    path: String,
    state: State<'_, AppState>,
) -> Result<AmendCommitPreview, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.preview_amend_commit(&path))
        .await
        .map_err(|error| task_error("预览修改提交", error))?
}

#[tauri::command]
pub async fn repository_amend_commit(
    path: String,
    input: AmendCommitInput,
    state: State<'_, AppState>,
) -> Result<AmendCommitCreated, CommandError> {
    let path = PathBuf::from(path);
    let repository = state.repository.clone();
    tauri::async_runtime::spawn_blocking(move || repository.amend_commit(&path, &input))
        .await
        .map_err(|error| task_error("修改提交", error))?
}
