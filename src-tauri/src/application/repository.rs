use crate::domain::{
    AmendCommitCreated, AmendCommitInput, AmendCommitPreview, BranchCreateAtCommitInput,
    CherryPickCommitInput, CherryPickCommitPreview, CommitCreated, CommitDetails, CommitInput,
    ConflictDetails, ConflictResolutionInput, HistoryPage, HistoryQuery, LocalMergePreview,
    LocalMergeStrategy, MergeRecoveryInput, MergeRecoveryPreview, RemoteCreateInput,
    RemoteDeleteInput, RemoteDeletePreview, RemoteEditPreview, RemoteTagDeleteInput,
    RemoteTagDeletePreview, RemoteTagDeletePreviewInput, RemoteTagPushInput, RemoteUpdateInput,
    RepositoryMutationResult, RepositoryRefs, RepositoryRefsMutationResult, RepositoryStashes,
    RepositoryStashesMutationResult, RepositoryStatus, RepositorySubmodules, RepositoryTags,
    RepositoryTagsMutationResult, RepositoryWorktrees, ResetCommitInput, ResetCommitMode,
    ResetCommitPreview, RevertCommitInput, RevertCommitPreview, StashCreateInput,
    WorktreeCreateInput, WorktreeDiff, WorktreeLockInput, WorktreePruneInput, WorktreeUnlockInput,
};
use crate::error::CommandError;
use crate::infrastructure::git;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, Weak};
use uuid::Uuid;

#[derive(Clone)]
pub struct RepositoryService {
    writes: Arc<RepositoryWriteQueue>,
    remote_token_namespace: Uuid,
    merge_recovery_token_namespace: Uuid,
    amend_commit_token_namespace: Uuid,
    worktree_token_namespace: Uuid,
    revert_token_namespace: Uuid,
    cherry_pick_token_namespace: Uuid,
    reset_commit_token_namespace: Uuid,
}

impl Default for RepositoryService {
    fn default() -> Self {
        Self {
            writes: Arc::new(RepositoryWriteQueue::default()),
            remote_token_namespace: Uuid::new_v4(),
            merge_recovery_token_namespace: Uuid::new_v4(),
            amend_commit_token_namespace: Uuid::new_v4(),
            worktree_token_namespace: Uuid::new_v4(),
            revert_token_namespace: Uuid::new_v4(),
            cherry_pick_token_namespace: Uuid::new_v4(),
            reset_commit_token_namespace: Uuid::new_v4(),
        }
    }
}

impl RepositoryService {
    pub fn status(&self, path: &Path) -> Result<RepositoryStatus, CommandError> {
        git::status(path)
    }

    pub fn history(&self, path: &Path, query: &HistoryQuery) -> Result<HistoryPage, CommandError> {
        git::commit_history(path, query)
    }

    pub fn commit_details(&self, path: &Path, oid: &str) -> Result<CommitDetails, CommandError> {
        git::commit_details(path, oid)
    }

    pub fn commit_image_diff(
        &self,
        path: &Path,
        oid: &str,
        file_path: &str,
        original_path: Option<&str>,
    ) -> Result<Option<crate::domain::ImageDiff>, CommandError> {
        git::commit_image_diff(path, oid, file_path, original_path)
    }

    pub fn worktree_diff(
        &self,
        path: &Path,
        file_path: &str,
        staged: bool,
    ) -> Result<WorktreeDiff, CommandError> {
        git::worktree_diff(path, file_path, staged)
    }

    pub fn conflict_details(
        &self,
        path: &Path,
        file_path: &str,
    ) -> Result<ConflictDetails, CommandError> {
        git::conflict_details(path, file_path)
    }

    pub fn resolve_conflict(
        &self,
        path: &Path,
        file_path: &str,
        input: &ConflictResolutionInput,
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::resolve_conflict(root, file_path, input)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn preview_merge_recovery(
        &self,
        path: &Path,
    ) -> Result<Option<MergeRecoveryPreview>, CommandError> {
        git::preview_merge_recovery(path, &self.merge_recovery_token_namespace)
    }

    pub fn continue_merge_recovery(
        &self,
        path: &Path,
        input: &MergeRecoveryInput,
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::continue_merge_recovery(root, input, &self.merge_recovery_token_namespace)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn abort_merge_recovery(
        &self,
        path: &Path,
        input: &MergeRecoveryInput,
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::abort_merge_recovery(root, input, &self.merge_recovery_token_namespace)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn refs(&self, path: &Path) -> Result<RepositoryRefs, CommandError> {
        git::repository_refs(path)
    }

    pub fn worktrees(&self, path: &Path) -> Result<RepositoryWorktrees, CommandError> {
        git::repository_worktrees(path, &self.worktree_token_namespace)
    }

    pub fn create_linked_worktree(
        &self,
        path: &Path,
        input: &WorktreeCreateInput,
    ) -> Result<RepositoryWorktrees, CommandError> {
        self.with_write(path, |root| {
            git::create_linked_worktree(root, input, &self.worktree_token_namespace)?;
            git::repository_worktrees(root, &self.worktree_token_namespace)
        })
    }

    pub fn lock_worktree(
        &self,
        path: &Path,
        input: &WorktreeLockInput,
    ) -> Result<RepositoryWorktrees, CommandError> {
        self.with_write(path, |root| {
            git::lock_worktree(root, input, &self.worktree_token_namespace)?;
            git::repository_worktrees(root, &self.worktree_token_namespace)
        })
    }

    pub fn unlock_worktree(
        &self,
        path: &Path,
        input: &WorktreeUnlockInput,
    ) -> Result<RepositoryWorktrees, CommandError> {
        self.with_write(path, |root| {
            git::unlock_worktree(root, input, &self.worktree_token_namespace)?;
            git::repository_worktrees(root, &self.worktree_token_namespace)
        })
    }

    pub fn prune_worktrees(
        &self,
        path: &Path,
        input: &WorktreePruneInput,
    ) -> Result<RepositoryWorktrees, CommandError> {
        self.with_write(path, |root| {
            git::prune_worktrees(root, input, &self.worktree_token_namespace)?;
            git::repository_worktrees(root, &self.worktree_token_namespace)
        })
    }

    pub fn preview_remote_edit(
        &self,
        path: &Path,
        name: &str,
    ) -> Result<RemoteEditPreview, CommandError> {
        git::preview_remote_edit(path, name, &self.remote_token_namespace)
    }

    pub fn preview_remote_delete(
        &self,
        path: &Path,
        name: &str,
    ) -> Result<RemoteDeletePreview, CommandError> {
        git::preview_remote_delete(path, name, &self.remote_token_namespace)
    }

    pub fn create_remote(
        &self,
        path: &Path,
        input: &RemoteCreateInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_remote(root, input)?;
            self.refs_mutation_result(root)
        })
    }

    pub fn update_remote(
        &self,
        path: &Path,
        input: &RemoteUpdateInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::update_remote(root, input, &self.remote_token_namespace)?;
            self.refs_mutation_result(root)
        })
    }

    pub fn delete_remote(
        &self,
        path: &Path,
        input: &RemoteDeleteInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::delete_remote(root, input, &self.remote_token_namespace)?;
            self.refs_mutation_result(root)
        })
    }

    pub fn preview_local_merge(
        &self,
        path: &Path,
        target_full_name: &str,
    ) -> Result<LocalMergePreview, CommandError> {
        git::preview_local_merge(path, target_full_name)
    }

    pub fn preview_revert(
        &self,
        path: &Path,
        target_oid: &str,
    ) -> Result<RevertCommitPreview, CommandError> {
        git::preview_revert(path, target_oid, &self.revert_token_namespace)
    }

    pub fn revert_commit(
        &self,
        path: &Path,
        input: &RevertCommitInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::revert_commit(root, input, &self.revert_token_namespace)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn preview_cherry_pick(
        &self,
        path: &Path,
        target_oid: &str,
    ) -> Result<CherryPickCommitPreview, CommandError> {
        git::preview_cherry_pick(path, target_oid, &self.cherry_pick_token_namespace)
    }

    pub fn cherry_pick_commit(
        &self,
        path: &Path,
        input: &CherryPickCommitInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::cherry_pick_commit(root, input, &self.cherry_pick_token_namespace)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn preview_reset_commit(
        &self,
        path: &Path,
        selected_oid: &str,
        mode: ResetCommitMode,
    ) -> Result<ResetCommitPreview, CommandError> {
        git::preview_reset_commit(path, selected_oid, mode, &self.reset_commit_token_namespace)
    }

    pub fn reset_commit(
        &self,
        path: &Path,
        input: &ResetCommitInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::reset_commit(root, input, &self.reset_commit_token_namespace)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn tags(&self, path: &Path) -> Result<RepositoryTags, CommandError> {
        git::repository_tags(path)
    }

    pub fn stashes(&self, path: &Path) -> Result<RepositoryStashes, CommandError> {
        git::repository_stashes(path)
    }

    pub fn submodules(&self, path: &Path) -> Result<RepositorySubmodules, CommandError> {
        git::repository_submodules(path)
    }

    pub fn stage(
        &self,
        path: &Path,
        paths: &[String],
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::stage(root, paths)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn stage_all(&self, path: &Path) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::stage_all(root)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn unstage(
        &self,
        path: &Path,
        paths: &[String],
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::unstage(root, paths)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn unstage_all(&self, path: &Path) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::unstage_all(root)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn discard_files(
        &self,
        path: &Path,
        file_paths: &[String],
    ) -> Result<RepositoryMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::discard_files(root, file_paths)?;
            Ok(RepositoryMutationResult {
                status: git::status(root)?,
            })
        })
    }

    pub fn switch_branch(
        &self,
        path: &Path,
        full_name: &str,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::switch_local_branch(root, full_name)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn create_branch(
        &self,
        path: &Path,
        name: &str,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_and_switch_branch(root, name)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn create_branch_at_commit(
        &self,
        path: &Path,
        input: &BranchCreateAtCommitInput,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_branch_at_commit(root, &input.name, &input.target_oid)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn delete_branch(
        &self,
        path: &Path,
        full_name: &str,
        allow_unmerged: bool,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::delete_local_branch(root, full_name, allow_unmerged)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn merge_local_branch(
        &self,
        path: &Path,
        target_full_name: &str,
        strategy: LocalMergeStrategy,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::merge_local_branch(root, target_full_name, strategy)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn create_tag(
        &self,
        path: &Path,
        name: &str,
        target_oid: &str,
        message: Option<&str>,
    ) -> Result<RepositoryTagsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_tag(root, name, target_oid, message)?;
            Ok(RepositoryTagsMutationResult {
                tags: git::repository_tags(root)?,
            })
        })
    }

    pub fn delete_tag(
        &self,
        path: &Path,
        full_name: &str,
    ) -> Result<RepositoryTagsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::delete_tag(root, full_name)?;
            Ok(RepositoryTagsMutationResult {
                tags: git::repository_tags(root)?,
            })
        })
    }

    pub fn create_stash(
        &self,
        path: &Path,
        input: &StashCreateInput,
    ) -> Result<RepositoryStashesMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_stash(root, input)?;
            self.stash_mutation_result(root)
        })
    }

    pub fn apply_stash(
        &self,
        path: &Path,
        oid: &str,
        restore_index: bool,
    ) -> Result<RepositoryStashesMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::apply_stash(root, oid, restore_index)?;
            self.stash_mutation_result(root)
        })
    }

    pub fn pop_stash(
        &self,
        path: &Path,
        oid: &str,
        restore_index: bool,
    ) -> Result<RepositoryStashesMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::pop_stash(root, oid, restore_index)?;
            self.stash_mutation_result(root)
        })
    }

    pub fn drop_stash(
        &self,
        path: &Path,
        oid: &str,
    ) -> Result<RepositoryStashesMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::drop_stash(root, oid)?;
            self.stash_mutation_result(root)
        })
    }

    pub fn create_tracking_branch(
        &self,
        path: &Path,
        remote_full_name: &str,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        self.with_write(path, |root| {
            git::create_tracking_branch(root, remote_full_name)?;
            Ok(RepositoryRefsMutationResult {
                refs: git::repository_refs(root)?,
                status: git::status(root)?,
            })
        })
    }

    pub fn clone_repository(
        &self,
        target: git::CloneTarget,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<PathBuf, CommandError> {
        let queue_key = target.target_directory.clone();
        self.writes.run(&queue_key, || {
            started();
            git::clone_repository(&target, cancellation, progress)
        })
    }

    pub fn fetch(
        &self,
        path: &Path,
        remote_name: &str,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::fetch_remote(root, remote_name, cancellation, progress)
        })
    }

    pub fn pull(
        &self,
        path: &Path,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::pull_fast_forward(root, cancellation, progress)
        })
    }

    pub fn push(
        &self,
        path: &Path,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::push_current_branch(root, cancellation, progress)
        })
    }

    pub fn sync(
        &self,
        path: &Path,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::pull_fast_forward(root, Arc::clone(&cancellation), Arc::clone(&progress))?;
            git::push_current_branch(root, cancellation, progress)
        })
    }

    pub fn push_remote_tag(
        &self,
        path: &Path,
        input: &RemoteTagPushInput,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::push_remote_tag(root, input, cancellation, progress)
        })
    }

    pub fn preview_remote_tag_delete(
        &self,
        path: &Path,
        input: &RemoteTagDeletePreviewInput,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<RemoteTagDeletePreview, CommandError> {
        self.with_write(path, |root| {
            started();
            git::preview_remote_tag_delete(
                root,
                input,
                &self.remote_token_namespace,
                cancellation,
                progress,
            )
        })
    }

    pub fn delete_remote_tag(
        &self,
        path: &Path,
        input: &RemoteTagDeleteInput,
        cancellation: Arc<AtomicBool>,
        started: Arc<dyn Fn() + Send + Sync>,
        progress: Arc<dyn Fn(git::FetchProgress) + Send + Sync>,
    ) -> Result<(), CommandError> {
        self.with_write(path, |root| {
            started();
            git::delete_remote_tag(
                root,
                input,
                &self.remote_token_namespace,
                cancellation,
                progress,
            )
        })
    }

    pub fn create_commit(
        &self,
        path: &Path,
        input: &CommitInput,
    ) -> Result<CommitCreated, CommandError> {
        self.with_write(path, |root| {
            let commit = git::create_commit(root, input)?;
            Ok(CommitCreated {
                commit,
                status: git::status(root)?,
            })
        })
    }

    pub fn preview_amend_commit(&self, path: &Path) -> Result<AmendCommitPreview, CommandError> {
        git::preview_amend_commit(path, &self.amend_commit_token_namespace)
    }

    pub fn amend_commit(
        &self,
        path: &Path,
        input: &AmendCommitInput,
    ) -> Result<AmendCommitCreated, CommandError> {
        self.with_write(path, |root| {
            let (previous_oid, commit) =
                git::amend_commit(root, input, &self.amend_commit_token_namespace)?;
            Ok(AmendCommitCreated {
                previous_oid,
                commit,
                status: git::status(root)?,
            })
        })
    }

    fn with_write<T>(
        &self,
        path: &Path,
        operation: impl FnOnce(&Path) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let root = git::repository_root(path)?;
        let write_key = git::repository_write_key(&root)?;
        self.writes.run(&write_key, || operation(&root))
    }

    fn stash_mutation_result(
        &self,
        root: &Path,
    ) -> Result<RepositoryStashesMutationResult, CommandError> {
        Ok(RepositoryStashesMutationResult {
            stashes: git::repository_stashes(root)?,
            status: git::status(root)?,
        })
    }

    fn refs_mutation_result(
        &self,
        root: &Path,
    ) -> Result<RepositoryRefsMutationResult, CommandError> {
        Ok(RepositoryRefsMutationResult {
            refs: git::repository_refs(root)?,
            status: git::status(root)?,
        })
    }
}

#[derive(Default)]
struct RepositoryWriteQueue {
    locks: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl RepositoryWriteQueue {
    fn run<T>(
        &self,
        root: &Path,
        operation: impl FnOnce() -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let repository_lock = self.lock_for(root)?;
        let _guard = repository_lock
            .lock()
            .map_err(|_| CommandError::new("repository_queue_failed", "仓库写操作队列不可用"))?;
        operation()
    }

    fn lock_for(&self, root: &Path) -> Result<Arc<Mutex<()>>, CommandError> {
        let mut locks = self
            .locks
            .lock()
            .map_err(|_| CommandError::new("repository_queue_failed", "仓库写操作队列不可用"))?;
        locks.retain(|_, value| value.strong_count() > 0);
        if let Some(existing) = locks.get(root).and_then(Weak::upgrade) {
            return Ok(existing);
        }

        let repository_lock = Arc::new(Mutex::new(()));
        locks.insert(root.to_path_buf(), Arc::downgrade(&repository_lock));
        Ok(repository_lock)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn serializes_writes_for_the_same_repository() {
        let queue = Arc::new(RepositoryWriteQueue::default());
        let active = Arc::new(AtomicUsize::new(0));
        let overlapped = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let queue = Arc::clone(&queue);
            let active = Arc::clone(&active);
            let overlapped = Arc::clone(&overlapped);
            workers.push(thread::spawn(move || {
                queue
                    .run(Path::new("/same-repository"), || {
                        if active.fetch_add(1, Ordering::SeqCst) != 0 {
                            overlapped.store(true, Ordering::SeqCst);
                        }
                        thread::sleep(Duration::from_millis(30));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
            }));
        }

        for worker in workers {
            worker.join().unwrap();
        }
        assert!(!overlapped.load(Ordering::SeqCst));
    }

    #[test]
    fn different_repositories_use_different_locks() {
        let queue = RepositoryWriteQueue::default();
        let first = queue.lock_for(Path::new("/first")).unwrap();
        let second = queue.lock_for(Path::new("/second")).unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
    }
}
