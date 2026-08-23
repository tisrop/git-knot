mod history_parser;
mod parser;
mod refs_parser;
mod stashes_parser;
mod submodules_parser;
mod tags_parser;
mod worktrees_parser;

use crate::domain::{
    AmendCommitInput, AmendCommitPreview, BranchKind, ChangeKind, CherryPickCommitInput,
    CherryPickCommitPreview, CommitDetails, CommitInput, CommitSummary, ConflictDetails,
    ConflictResolutionChoice, ConflictResolutionInput, ConflictSide, GitVersion, HistoryPage,
    HistoryQuery, ImageDiff, ImagePreview, LocalMergeMode, LocalMergePreview, LocalMergeStrategy,
    MergeRecoveryInput, MergeRecoveryPreview, PublishBranchInput, PushBranchTargetInput,
    RemoteCreateInput, RemoteDeleteInput, RemoteDeletePreview, RemoteEditPreview, RemoteInfo,
    RemoteTagDeleteInput, RemoteTagDeletePreview, RemoteTagDeletePreviewInput, RemoteTagPushInput,
    RemoteUpdateInput, RepositoryRefs, RepositoryStashes, RepositoryStatus, RepositorySubmodules,
    RepositoryTags, RepositoryWorktrees, ResetCommitInput, ResetCommitMode, ResetCommitPreview,
    RevertCommitInput, RevertCommitPreview, StashCreateInput, StashInfo, SubmoduleInfo,
    SubmoduleState, TagInfo, WorktreeCreateCandidate, WorktreeCreateInput, WorktreeDiff,
    WorktreeInfo, WorktreeLockInput, WorktreePruneInput, WorktreeUnlockInput,
};
use crate::error::CommandError;
use base64::Engine as _;
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use url::Url;
use uuid::Uuid;

const MAX_HISTORY_LIMIT: u32 = 200;
const MAX_HISTORY_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_HISTORY_TEXT_QUERY_CHARS: usize = 256;
const MAX_HISTORY_REF_BYTES: usize = 1024;
const MAX_HISTORY_PARENTS_PER_COMMIT: usize = 32;
const MAX_STATUS_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STATUS_CHANGES: usize = 100_000;
const MAX_COMMIT_DETAILS_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMMIT_FILES: usize = 100_000;
const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONFLICT_INDEX_BYTES: usize = 1024 * 1024;
const MAX_CONFLICT_PREVIEW_BYTES: usize = 1024 * 1024;
const MAX_MERGE_RECOVERY_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_AMEND_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const MAX_PATHS_PER_OPERATION: usize = 256;
const MAX_COMMIT_SUBJECT_CHARS: usize = 500;
const MAX_COMMIT_BODY_BYTES: usize = 64 * 1024;
const MAX_REFS_BYTES: usize = 1024 * 1024;
const MAX_REMOTE_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_BRANCH_NAME_BYTES: usize = 255;
const MAX_BRANCH_SELECTOR_BYTES: usize = 1024;
const MAX_BRANCHES: usize = 10_000;
const MAX_TAGS: usize = 10_000;
const MAX_TAG_NAME_BYTES: usize = 255;
const MAX_TAG_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_STASHES: usize = 10_000;
const MAX_WORKTREES: usize = 1_024;
const MAX_WORKTREE_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_WORKTREE_LOCK_REASON_CHARS: usize = 256;
const MAX_SUBMODULES: usize = 1_024;
const MAX_SUBMODULE_INDEX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SUBMODULE_STATUS_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SUBMODULE_CHECKOUT_STATUS_BYTES: usize = 64 * 1024;
const MAX_GITMODULES_BYTES: usize = 1024 * 1024;
const MAX_STASH_MESSAGE_CHARS: usize = 500;
const MAX_REMOTES: usize = 64;
const MAX_REMOTE_NAME_BYTES: usize = 255;
const MAX_REMOTE_URL_BYTES: usize = 4096;
const MAX_CLONE_URL_BYTES: usize = 4096;
const MAX_CLONE_DIRECTORY_NAME_BYTES: usize = 255;
const MAX_SCANNED_REPOSITORIES: usize = 1_000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PULL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PUSH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CLONE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOCAL_GIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const FETCH_CANCELLED_MESSAGE: &str = "已取消获取远端更新";
const FETCH_TIMEOUT_MESSAGE: &str = "获取远端更新超时，操作已停止";
const PULL_CANCELLED_MESSAGE: &str = "已取消 Pull";
const PULL_TIMEOUT_MESSAGE: &str = "Pull 超时，操作已停止";
const PUSH_CANCELLED_MESSAGE: &str = "已取消 Push";
const PUSH_TIMEOUT_MESSAGE: &str = "Push 超时，操作已停止";
const TAG_PUSH_CANCELLED_MESSAGE: &str = "已取消发布远端标签";
const TAG_PUSH_TIMEOUT_MESSAGE: &str = "发布远端标签超时，操作已停止";
const TAG_DELETE_PREVIEW_CANCELLED_MESSAGE: &str = "已取消读取远端标签";
const TAG_DELETE_PREVIEW_TIMEOUT_MESSAGE: &str = "读取远端标签超时，操作已停止";
const TAG_DELETE_CANCELLED_MESSAGE: &str = "已取消删除远端标签";
const TAG_DELETE_TIMEOUT_MESSAGE: &str = "删除远端标签超时，操作已停止";
const CLONE_CANCELLED_MESSAGE: &str = "已取消克隆仓库";

const SCAN_SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    ".cache",
    ".next",
    ".turbo",
    ".venv",
    "build",
    "dist",
    "node_modules",
    "out",
    "target",
];
const CLONE_TIMEOUT_MESSAGE: &str = "克隆仓库超时，操作已停止";
const LOCAL_GIT_TIMEOUT_MESSAGE: &str = "本地 Git 操作超时，操作已停止";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(500);
const HISTORY_FORMAT: &str = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%s";
const COMMIT_FORMAT: &str = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b";
const REFS_FORMAT: &str = "%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream)%00%(upstream:track)%00%(symref)";
const TAGS_FORMAT: &str = "%(refname)%00%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(subject)%00%(taggerdate:iso-strict)";
const STASHES_FORMAT: &str = "%H%x00%gd%x00%gs%x00%cI";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchProgress {
    pub phase: String,
    pub percent: Option<u8>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneTarget {
    pub remote_url: String,
    pub parent_directory: PathBuf,
    pub target_directory: PathBuf,
    pub repository_name: String,
}

#[derive(Clone, Debug)]
struct ConflictStage {
    mode: String,
    oid: String,
}

#[derive(Clone, Debug)]
struct ConflictSnapshot {
    path: String,
    current: Option<ConflictStage>,
    incoming: Option<ConflictStage>,
    token: String,
}

#[derive(Clone, Debug)]
struct MergeRecoverySnapshot {
    current_branch: Option<String>,
    head_oid: String,
    merge_head_oid: String,
    unresolved_conflict_count: u64,
    has_unstaged_changes: bool,
    token: String,
}

#[derive(Clone, Debug)]
struct AmendCommitSnapshot {
    current_branch: String,
    current_branch_ref: String,
    head_oid: String,
    current_subject: String,
    current_body: String,
    author_name: String,
    author_email: String,
    authored_at: String,
    parent_oids: Vec<String>,
    staged_change_count: u64,
    blocking_refs: Vec<String>,
    index_tree_oid: String,
    token: String,
}

#[derive(Clone, Debug)]
struct RemoteSnapshot {
    name: String,
    fetch_urls: Vec<String>,
    effective_push_urls: Vec<String>,
    explicit_push_urls: Vec<String>,
    affected_branches: Vec<String>,
    token: String,
}

#[derive(Clone, Copy, Debug)]
struct OperationDeadline {
    started_at: Instant,
    timeout: Duration,
}

impl OperationDeadline {
    fn new(timeout: Duration) -> Self {
        Self {
            started_at: Instant::now(),
            timeout,
        }
    }

    fn remaining_at(self, now: Instant) -> Option<Duration> {
        self.timeout
            .checked_sub(now.saturating_duration_since(self.started_at))
            .filter(|remaining| !remaining.is_zero())
    }
}

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

pub fn version() -> Result<GitVersion, CommandError> {
    let output = execute(None, &["--version"])?;
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let version = raw
        .strip_prefix("git version ")
        .unwrap_or(&raw)
        .trim()
        .to_owned();
    Ok(GitVersion { raw, version })
}

pub fn repository_root(path: &Path) -> Result<PathBuf, CommandError> {
    let selected = path.canonicalize().map_err(|error| {
        CommandError::new(
            "invalid_repository_path",
            format!("无法访问所选目录：{error}"),
        )
    })?;
    let output = execute(Some(&selected), &["rev-parse", "--show-toplevel"])?;
    let root = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    PathBuf::from(root).canonicalize().map_err(|error| {
        CommandError::new(
            "invalid_repository_root",
            format!("无法解析 Git 仓库根目录：{error}"),
        )
    })
}

pub fn scan_repositories(root: &Path, max_depth: usize) -> Result<Vec<PathBuf>, CommandError> {
    let root = root.canonicalize().map_err(|error| {
        CommandError::new("invalid_scan_root", format!("无法访问所选父目录：{error}"))
    })?;
    if !root.is_dir() {
        return Err(CommandError::new(
            "invalid_scan_root",
            "所选扫描路径不是文件夹",
        ));
    }

    let mut repositories = Vec::new();
    scan_repository_directory(&root, 0, max_depth, &mut repositories, true)?;
    repositories.sort();
    repositories.dedup();
    Ok(repositories)
}

fn scan_repository_directory(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    repositories: &mut Vec<PathBuf>,
    required: bool,
) -> Result<(), CommandError> {
    if depth > max_depth || repositories.len() >= MAX_SCANNED_REPOSITORIES {
        return Ok(());
    }

    if directory.join(".git").exists() {
        repositories.push(directory.to_path_buf());
        return Ok(());
    }

    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if required => {
            return Err(CommandError::new(
                "scan_directory_failed",
                format!("无法读取所选父目录：{error}"),
            ));
        }
        Err(_) => return Ok(()),
    };

    let mut children = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() || file_type.is_symlink() {
                return None;
            }
            let name = entry.file_name();
            if SCAN_SKIPPED_DIRECTORIES
                .iter()
                .any(|skipped| name == OsStr::new(skipped))
            {
                return None;
            }
            Some(entry.path())
        })
        .collect::<Vec<_>>();
    children.sort();

    for child in children {
        scan_repository_directory(&child, depth + 1, max_depth, repositories, false)?;
        if repositories.len() >= MAX_SCANNED_REPOSITORIES {
            break;
        }
    }
    Ok(())
}

pub fn repository_write_key(path: &Path) -> Result<PathBuf, CommandError> {
    let root = repository_root(path)?;
    let output = execute(Some(&root), &["rev-parse", "--git-common-dir"])?;
    let raw = String::from_utf8(output.stdout).map_err(|_| {
        CommandError::new(
            "invalid_repository_common_dir",
            "Git 公共目录不是有效 UTF-8",
        )
    })?;
    let common_dir = PathBuf::from(raw.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        root.join(common_dir)
    };
    common_dir.canonicalize().map_err(|error| {
        CommandError::new(
            "invalid_repository_common_dir",
            format!("无法解析 Git 公共目录：{error}"),
        )
    })
}

pub fn prepare_clone(
    remote_url: &str,
    parent_directory: &Path,
) -> Result<CloneTarget, CommandError> {
    let remote_url = validate_clone_url(remote_url)?;
    let repository_name = clone_repository_name(&remote_url)?;
    let parent_directory = parent_directory.canonicalize().map_err(|error| {
        CommandError::new(
            "invalid_clone_parent",
            format!("无法访问克隆目标目录：{error}"),
        )
    })?;
    if !parent_directory.is_dir() {
        return Err(CommandError::new(
            "invalid_clone_parent",
            "克隆目标必须是已存在的目录",
        ));
    }
    let target_directory = parent_directory.join(&repository_name);
    if target_directory.exists() {
        return Err(CommandError::new(
            "clone_destination_exists",
            format!("目标目录 {repository_name} 已存在，请选择其他位置"),
        ));
    }

    Ok(CloneTarget {
        remote_url,
        parent_directory,
        target_directory,
        repository_name,
    })
}

pub fn clone_repository(
    target: &CloneTarget,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<PathBuf, CommandError> {
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            CLONE_CANCELLED_MESSAGE,
        ));
    }
    let current_parent = target.parent_directory.canonicalize().map_err(|error| {
        CommandError::new(
            "invalid_clone_parent",
            format!("无法访问克隆目标目录：{error}"),
        )
    })?;
    if current_parent != target.parent_directory || !current_parent.is_dir() {
        return Err(CommandError::new(
            "clone_parent_changed",
            "克隆目标目录在操作开始前已发生变化，请重新选择",
        ));
    }
    if target.target_directory.exists() {
        return Err(CommandError::new(
            "clone_destination_exists",
            format!("目标目录 {} 已存在，请选择其他位置", target.repository_name),
        ));
    }

    let staging_directory = create_clone_staging_directory(&target.parent_directory)?;
    let result = (|| {
        let mut command = git_command(Some(&target.parent_directory), GitLocking::Required);
        command
            .arg("clone")
            .arg("--progress")
            .arg("--")
            .arg(&target.remote_url)
            .arg(&staging_directory)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        run_network_process(
            command,
            cancellation,
            progress,
            OperationDeadline::new(CLONE_TIMEOUT),
            CLONE_CANCELLED_MESSAGE,
            CLONE_TIMEOUT_MESSAGE,
            clone_failure,
        )?;

        let cloned_root = repository_root(&staging_directory)?;
        let canonical_staging = staging_directory
            .canonicalize()
            .map_err(CommandError::from)?;
        if cloned_root != canonical_staging {
            return Err(CommandError::new(
                "clone_repository_root_mismatch",
                "克隆结果不是独立 Git 仓库，已停止导入",
            ));
        }
        if target.target_directory.exists() {
            return Err(CommandError::new(
                "clone_destination_exists",
                format!("目标目录 {} 已存在，请选择其他位置", target.repository_name),
            ));
        }
        fs::rename(&staging_directory, &target.target_directory).map_err(|error| {
            CommandError::new(
                "clone_finalize_failed",
                format!("仓库已下载，但无法写入最终目录：{error}"),
            )
        })?;
        target
            .target_directory
            .canonicalize()
            .map_err(CommandError::from)
    })();

    if result.is_err() {
        cleanup_clone_staging_directory(&target.parent_directory, &staging_directory);
    }
    result
}

fn validate_clone_url(remote_url: &str) -> Result<String, CommandError> {
    let remote_url = remote_url.trim();
    if remote_url.is_empty()
        || remote_url.len() > MAX_CLONE_URL_BYTES
        || remote_url.starts_with('-')
        || remote_url.chars().any(char::is_control)
    {
        return Err(CommandError::new("invalid_clone_url", "远端仓库地址无效"));
    }

    if let Ok(url) = Url::parse(remote_url) {
        if !matches!(url.scheme(), "https" | "ssh" | "git+ssh")
            || url.host_str().is_none()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.password().is_some()
        {
            return Err(CommandError::new(
                "unsupported_clone_url",
                "只支持不含查询参数或密码的 HTTPS、SSH 仓库地址",
            ));
        }
        if url.scheme() == "https" && !url.username().is_empty() {
            return Err(CommandError::new(
                "clone_url_credentials_forbidden",
                "HTTPS 仓库地址不能包含用户名或凭据",
            ));
        }
        reject_gitee_host(url.host_str().unwrap_or_default())?;
        return Ok(remote_url.to_owned());
    }

    validate_scp_like_clone_url(remote_url)?;
    Ok(remote_url.to_owned())
}

fn validate_scp_like_clone_url(remote_url: &str) -> Result<(), CommandError> {
    let Some((identity, path)) = remote_url.split_once(':') else {
        return Err(CommandError::new(
            "unsupported_clone_url",
            "只支持 HTTPS、SSH 或 user@host:path 形式的仓库地址",
        ));
    };
    let Some((user, host)) = identity.split_once('@') else {
        return Err(CommandError::new(
            "unsupported_clone_url",
            "SSH 简写地址必须使用 user@host:path 形式",
        ));
    };
    let valid_identity = !user.is_empty()
        && !host.is_empty()
        && !identity.contains('/')
        && !identity.contains('\\')
        && user
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        && host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-".contains(character));
    if !valid_identity
        || path.trim_matches('/').is_empty()
        || path.contains('?')
        || path.contains('#')
        || path.contains('\\')
    {
        return Err(CommandError::new("invalid_clone_url", "SSH 仓库地址无效"));
    }
    reject_gitee_host(host)
}

fn reject_gitee_host(host: &str) -> Result<(), CommandError> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "gitee.com" || host.ends_with(".gitee.com") {
        return Err(CommandError::new(
            "gitee_not_supported",
            "当前项目不支持 Gitee 仓库",
        ));
    }
    Ok(())
}

fn clone_repository_name(remote_url: &str) -> Result<String, CommandError> {
    let path = if let Ok(url) = Url::parse(remote_url) {
        url.path().to_owned()
    } else {
        remote_url
            .split_once(':')
            .map(|(_, path)| path.to_owned())
            .unwrap_or_default()
    };
    let raw_name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    let name = raw_name.strip_suffix(".git").unwrap_or(raw_name);
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && !name.ends_with(['.', ' '])
        && !is_windows_reserved_name(name)
        && name.len() <= MAX_CLONE_DIRECTORY_NAME_BYTES
        && !name.contains('%')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.chars().any(char::is_control);
    if !valid {
        return Err(CommandError::new(
            "invalid_clone_repository_name",
            "无法从远端地址推导安全的仓库目录名",
        ));
    }
    Ok(name.to_owned())
}

fn is_windows_reserved_name(name: &str) -> bool {
    let device_name = name
        .split_once('.')
        .map_or(name, |(prefix, _)| prefix)
        .to_ascii_uppercase();
    matches!(device_name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_name.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || device_name.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
}

fn create_clone_staging_directory(parent: &Path) -> Result<PathBuf, CommandError> {
    for _ in 0..8 {
        let path = parent.join(format!(".git-knot-clone-{}", Uuid::new_v4()));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(CommandError::from(error)),
        }
    }
    Err(CommandError::new(
        "clone_staging_unavailable",
        "无法创建安全的克隆临时目录",
    ))
}

fn cleanup_clone_staging_directory(parent: &Path, staging: &Path) {
    let owned_name = staging
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with(".git-knot-clone-"));
    if owned_name && staging.parent() == Some(parent) {
        let _ = fs::remove_dir_all(staging);
    }
}

pub fn status(path: &Path) -> Result<RepositoryStatus, CommandError> {
    let root = repository_root(path)?;
    let output = execute_limited(
        Some(&root),
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v2"),
            OsStr::new("--branch"),
            OsStr::new("-z"),
            OsStr::new("--untracked-files=all"),
        ],
        MAX_STATUS_OUTPUT_BYTES,
    )?;
    parse_bounded_status(&root, output)
}

fn parse_bounded_status(
    root: &Path,
    output: LimitedOutput,
) -> Result<RepositoryStatus, CommandError> {
    if output.truncated {
        return Err(CommandError::new(
            "status_output_too_large",
            "仓库状态超过允许的读取上限",
        ));
    }
    let status = parser::parse_status(root, &output.stdout)?;
    if status.changes.len() > MAX_STATUS_CHANGES {
        return Err(CommandError::new(
            "too_many_status_changes",
            format!("单个仓库最多读取 {MAX_STATUS_CHANGES} 条文件变更"),
        ));
    }
    Ok(status)
}

pub fn repository_refs(path: &Path) -> Result<RepositoryRefs, CommandError> {
    let root = repository_root(path)?;
    let branches = read_branches(&root, true)?;
    let remotes = read_remotes(&root)?;
    Ok(RepositoryRefs { branches, remotes })
}

fn read_branches(
    repository: &Path,
    include_remote_branches: bool,
) -> Result<Vec<crate::domain::BranchInfo>, CommandError> {
    let format = format!("--format={REFS_FORMAT}");
    let mut arguments = vec![
        OsStr::new("for-each-ref"),
        format.as_ref(),
        OsStr::new("refs/heads"),
    ];
    if include_remote_branches {
        arguments.push(OsStr::new("refs/remotes"));
    }
    let branch_output = execute_limited(Some(repository), &arguments, MAX_REFS_BYTES)?;
    if branch_output.truncated {
        return Err(CommandError::new(
            "branch_list_too_large",
            "分支列表超过允许的读取上限",
        ));
    }
    let branches = refs_parser::parse_branches(&branch_output.stdout)?;
    if branches.len() > MAX_BRANCHES {
        return Err(CommandError::new(
            "too_many_branches",
            format!("单个仓库最多读取 {MAX_BRANCHES} 个分支"),
        ));
    }
    Ok(branches)
}

pub fn repository_worktrees(
    path: &Path,
    token_namespace: &Uuid,
) -> Result<RepositoryWorktrees, CommandError> {
    let root = repository_root(path)?;
    load_repository_worktrees(&root, token_namespace)
}

pub fn lock_worktree(
    path: &Path,
    input: &WorktreeLockInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_worktree_token(&input.expected_token)?;
    let worktree = require_current_worktree(
        &root,
        &input.worktree_path,
        &input.expected_token,
        token_namespace,
    )?;
    ensure_linked_worktree_mutable(&worktree)?;
    if worktree.locked {
        return Err(CommandError::new(
            "worktree_already_locked",
            "该关联 worktree 已锁定，请刷新后重试",
        ));
    }
    let reason = validate_worktree_lock_reason(input.reason.as_deref())?;

    let mut arguments = vec![OsString::from("worktree"), OsString::from("lock")];
    if let Some(reason) = reason {
        arguments.push(OsString::from(format!("--reason={reason}")));
    }
    arguments.push(OsString::from("--"));
    arguments.push(OsString::from(&worktree.path));
    execute_write_os(&root, &arguments)
        .map_err(|_| CommandError::new("worktree_lock_failed", "锁定关联 worktree 失败"))
}

pub fn unlock_worktree(
    path: &Path,
    input: &WorktreeUnlockInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_worktree_token(&input.expected_token)?;
    let worktree = require_current_worktree(
        &root,
        &input.worktree_path,
        &input.expected_token,
        token_namespace,
    )?;
    ensure_linked_worktree_mutable(&worktree)?;
    if !worktree.locked {
        return Err(CommandError::new(
            "worktree_not_locked",
            "该关联 worktree 未锁定，请刷新后重试",
        ));
    }

    execute_write_os(
        &root,
        &[
            OsString::from("worktree"),
            OsString::from("unlock"),
            OsString::from("--"),
            OsString::from(&worktree.path),
        ],
    )
    .map_err(|_| CommandError::new("worktree_unlock_failed", "解锁关联 worktree 失败"))
}

pub fn prune_worktrees(
    path: &Path,
    input: &WorktreePruneInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_worktree_token(&input.expected_token)?;
    let snapshot = load_repository_worktrees(&root, token_namespace)?;
    if !snapshot.worktrees.iter().any(|worktree| worktree.prunable) {
        return Err(CommandError::new(
            "no_prunable_worktrees",
            "当前没有可清理的失效 worktree 记录",
        ));
    }
    if snapshot.prune_token != input.expected_token {
        return Err(CommandError::new(
            "worktree_snapshot_changed",
            "关联 worktree 清单已被外部修改，请刷新后重试",
        ));
    }

    // This fixed command removes only stale administrative records. It does
    // not delete a live worktree's files and accepts no user-controlled path.
    execute_write(&root, &["worktree", "prune", "--expire=now", "--verbose"])
        .map_err(|_| CommandError::new("worktree_prune_failed", "清理失效 worktree 记录失败"))
}

pub fn create_linked_worktree(
    path: &Path,
    input: &WorktreeCreateInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_worktree_token(&input.expected_token)?;
    validate_local_branch_full_name(&input.branch_full_name)?;

    let snapshot = load_repository_worktrees(&root, token_namespace)?;
    let candidate = snapshot
        .create_candidates
        .into_iter()
        .find(|candidate| candidate.branch_full_name == input.branch_full_name)
        .ok_or_else(|| {
            CommandError::new(
                "worktree_create_unavailable",
                "该本地分支已被检出、目标目录已占用或分支已发生变化，请刷新后重试",
            )
        })?;
    if candidate.token != input.expected_token {
        return Err(CommandError::new(
            "worktree_create_snapshot_changed",
            "本地分支或创建目标已发生变化，请刷新后重试",
        ));
    }

    let target = PathBuf::from(&candidate.target_path);
    let storage_root = target.parent().ok_or_else(|| {
        CommandError::new(
            "invalid_worktree_target",
            "无法推导安全的关联 worktree 目录",
        )
    })?;
    ensure_worktree_storage_root(storage_root)?;
    if path_entry_exists(&target)? {
        return Err(CommandError::new(
            "worktree_target_exists",
            "关联 worktree 目标目录已被占用，请刷新后重试",
        ));
    }
    fs::create_dir(&target).map_err(|error| {
        CommandError::new(
            "worktree_target_create_failed",
            format!("无法创建关联 worktree 目标目录：{error}"),
        )
    })?;

    let result = execute_write_os(
        &root,
        &[
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("--quiet"),
            OsString::from("--"),
            OsString::from(&target),
            OsString::from(&candidate.branch),
        ],
    );
    if result.is_err() {
        match load_worktree_infos(&root, token_namespace) {
            Ok(worktrees)
                if !worktrees
                    .iter()
                    .any(|worktree| worktree.path == candidate.target_path) =>
            {
                let _ = fs::remove_dir_all(&target);
                return Err(CommandError::new(
                    "worktree_create_failed",
                    "Git 拒绝创建关联 worktree；应用已清理未注册的目标目录",
                ));
            }
            _ => {
                return Err(CommandError::new(
                    "worktree_create_partial",
                    "Git 创建结果无法安全确认，目标目录或 worktree 记录可能已存在，请刷新后检查",
                ));
            }
        }
    }

    let created = load_worktree_infos(&root, token_namespace)?
        .into_iter()
        .find(|worktree| worktree.path == candidate.target_path)
        .ok_or_else(|| {
            CommandError::new(
                "worktree_create_partial",
                "Git 命令已完成，但未能在权威清单中确认新 worktree，请刷新后检查",
            )
        })?;
    if created.branch_full_name.as_deref() != Some(candidate.branch_full_name.as_str()) {
        return Err(CommandError::new(
            "worktree_create_partial",
            "新 worktree 已出现，但检出的分支与预期不一致，请使用系统 Git 检查",
        ));
    }
    Ok(())
}

fn load_repository_worktrees(
    repository: &Path,
    token_namespace: &Uuid,
) -> Result<RepositoryWorktrees, CommandError> {
    let worktrees = load_worktree_infos(repository, token_namespace)?;
    let prune_token = worktree_prune_token(&worktrees, token_namespace);
    let create_candidates = if worktrees.len() >= MAX_WORKTREES {
        Vec::new()
    } else {
        worktree_create_candidates(repository, &worktrees, token_namespace)?
    };
    Ok(RepositoryWorktrees {
        worktrees,
        create_candidates,
        prune_token,
    })
}

fn worktree_prune_token(worktrees: &[WorktreeInfo], token_namespace: &Uuid) -> String {
    let mut material = Vec::new();
    append_token_bytes(&mut material, b"prune-worktrees-v1");
    for worktree in worktrees {
        append_token_bytes(&mut material, worktree.token.as_bytes());
    }
    Uuid::new_v5(token_namespace, &material).to_string()
}

fn load_worktree_infos(
    repository: &Path,
    token_namespace: &Uuid,
) -> Result<Vec<WorktreeInfo>, CommandError> {
    let output = execute_limited(
        Some(repository),
        &[
            OsStr::new("worktree"),
            OsStr::new("list"),
            OsStr::new("--porcelain"),
            OsStr::new("-z"),
        ],
        MAX_WORKTREE_OUTPUT_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "worktree_list_too_large",
            "关联 worktree 列表超过允许的读取上限",
        ));
    }
    let parsed = worktrees_parser::parse_worktrees(&output.stdout)?;
    if parsed.len() > MAX_WORKTREES {
        return Err(CommandError::new(
            "too_many_worktrees",
            format!("单个仓库最多读取 {MAX_WORKTREES} 个关联 worktree"),
        ));
    }
    Ok(parsed
        .into_iter()
        .map(|worktree| worktree_info(worktree, token_namespace))
        .collect())
}

fn worktree_create_candidates(
    repository: &Path,
    worktrees: &[WorktreeInfo],
    token_namespace: &Uuid,
) -> Result<Vec<WorktreeCreateCandidate>, CommandError> {
    let main = worktrees
        .iter()
        .find(|worktree| worktree.is_main)
        .ok_or_else(|| CommandError::new("invalid_git_output", "Git worktree 清单缺少主工作树"))?;
    if main.bare {
        return Ok(Vec::new());
    }
    let main_path = Path::new(&main.path);
    let storage_root = derived_worktree_storage_root(main_path)?;
    let checked_out = worktrees
        .iter()
        .filter_map(|worktree| worktree.branch_full_name.as_deref())
        .collect::<HashSet<_>>();
    let mut candidates = Vec::new();
    for branch in read_branches(repository, false)? {
        if !matches!(branch.kind, BranchKind::Local)
            || checked_out.contains(branch.full_name.as_str())
        {
            continue;
        }
        let target = derived_worktree_target(&storage_root, &branch.name, &branch.full_name);
        if path_entry_exists(&target)? {
            continue;
        }
        let target_path = target.to_string_lossy().into_owned();
        let mut token_material = Vec::new();
        append_token_bytes(&mut token_material, b"create-linked-worktree-v1");
        append_token_bytes(&mut token_material, main.path.as_bytes());
        append_token_bytes(&mut token_material, branch.full_name.as_bytes());
        append_token_bytes(&mut token_material, branch.oid.as_bytes());
        append_token_bytes(&mut token_material, target_path.as_bytes());
        candidates.push(WorktreeCreateCandidate {
            branch: branch.name,
            branch_full_name: branch.full_name,
            head_oid: branch.oid,
            target_path,
            token: Uuid::new_v5(token_namespace, &token_material).to_string(),
        });
    }
    Ok(candidates)
}

fn derived_worktree_storage_root(main_path: &Path) -> Result<PathBuf, CommandError> {
    let parent = main_path
        .parent()
        .ok_or_else(|| CommandError::new("invalid_worktree_target", "主工作树缺少可用的父目录"))?;
    let repository_name = main_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| {
            CommandError::new("invalid_worktree_target", "主工作树目录名不是有效 UTF-8")
        })?;
    let repository_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        main_path.as_os_str().as_encoded_bytes(),
    );
    let repository_suffix = repository_id.simple().to_string();
    Ok(parent.join(".git-knot-worktrees").join(format!(
        "wt-{}-{}",
        worktree_path_slug(repository_name),
        &repository_suffix[..8]
    )))
}

fn derived_worktree_target(storage_root: &Path, branch: &str, branch_full_name: &str) -> PathBuf {
    let branch_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, branch_full_name.as_bytes());
    let branch_suffix = branch_id.simple().to_string();
    storage_root.join(format!(
        "wt-{}-{}",
        worktree_path_slug(branch),
        &branch_suffix[..8]
    ))
}

fn worktree_path_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for character in value.chars() {
        let normalized = if character.is_ascii_alphanumeric() || matches!(character, '.' | '_') {
            character.to_ascii_lowercase()
        } else {
            '-'
        };
        if normalized == '-' {
            if previous_dash || slug.is_empty() {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        slug.push(normalized);
        if slug.len() >= 48 {
            break;
        }
    }
    while slug.ends_with(['-', '.']) {
        slug.pop();
    }
    if slug.is_empty() {
        "branch".to_owned()
    } else {
        slug
    }
}

fn path_entry_exists(path: &Path) -> Result<bool, CommandError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(CommandError::new(
            "worktree_target_inspection_failed",
            format!("无法检查关联 worktree 目标目录：{error}"),
        )),
    }
}

fn ensure_worktree_storage_root(storage_root: &Path) -> Result<(), CommandError> {
    let repository_container = storage_root.parent().ok_or_else(|| {
        CommandError::new("invalid_worktree_target", "无法推导关联 worktree 容器目录")
    })?;
    ensure_plain_directory(repository_container)?;
    ensure_plain_directory(storage_root)
}

fn ensure_plain_directory(path: &Path) -> Result<(), CommandError> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(CommandError::from)?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(CommandError::new(
                    "unsafe_worktree_storage",
                    "关联 worktree 受控目录不是普通目录，已停止创建",
                ))
            }
        }
        Err(error) => Err(CommandError::new(
            "worktree_storage_create_failed",
            format!("无法创建关联 worktree 受控目录：{error}"),
        )),
    }
}

fn validate_local_branch_full_name(full_name: &str) -> Result<(), CommandError> {
    if full_name.len() <= "refs/heads/".len()
        || full_name.len() > MAX_BRANCH_SELECTOR_BYTES
        || !full_name.starts_with("refs/heads/")
        || full_name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(CommandError::new(
            "invalid_branch_selector",
            "要创建 worktree 的本地分支标识无效",
        ));
    }
    Ok(())
}

fn worktree_info(
    worktree: worktrees_parser::ParsedWorktree,
    token_namespace: &Uuid,
) -> WorktreeInfo {
    let locked = worktree.lock_reason.is_some();
    let prunable = worktree.prunable_reason.is_some();
    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, worktree.path.as_bytes());
    append_token_bytes(&mut token_material, worktree.head_oid.as_bytes());
    append_token_bytes(
        &mut token_material,
        worktree
            .branch_full_name
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    append_token_bytes(&mut token_material, &[u8::from(worktree.detached)]);
    append_token_bytes(&mut token_material, &[u8::from(worktree.bare)]);
    append_token_bytes(&mut token_material, &[u8::from(locked)]);
    append_token_bytes(
        &mut token_material,
        worktree
            .lock_reason
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    append_token_bytes(&mut token_material, &[u8::from(prunable)]);
    append_token_bytes(
        &mut token_material,
        worktree
            .prunable_reason
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    append_token_bytes(&mut token_material, &[u8::from(worktree.is_main)]);
    let branch = worktree
        .branch_full_name
        .as_deref()
        .and_then(|full_name| full_name.strip_prefix("refs/heads/"))
        .map(str::to_owned);

    WorktreeInfo {
        path: worktree.path,
        head_oid: worktree.head_oid,
        branch,
        branch_full_name: worktree.branch_full_name,
        detached: worktree.detached,
        bare: worktree.bare,
        locked,
        lock_reason: worktree.lock_reason.filter(|reason| !reason.is_empty()),
        prunable,
        prunable_reason: worktree.prunable_reason.filter(|reason| !reason.is_empty()),
        is_main: worktree.is_main,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    }
}

fn require_current_worktree(
    repository: &Path,
    requested_path: &str,
    expected_token: &str,
    token_namespace: &Uuid,
) -> Result<WorktreeInfo, CommandError> {
    validate_worktree_path(requested_path)?;
    let worktree = load_worktree_infos(repository, token_namespace)?
        .into_iter()
        .find(|worktree| worktree.path == requested_path)
        .ok_or_else(|| {
            CommandError::new(
                "worktree_not_found",
                "该关联 worktree 已不存在，请刷新后重试",
            )
        })?;
    if worktree.token != expected_token {
        return Err(CommandError::new(
            "worktree_snapshot_changed",
            "关联 worktree 状态已被外部修改，请刷新后重试",
        ));
    }
    Ok(worktree)
}

fn ensure_linked_worktree_mutable(worktree: &WorktreeInfo) -> Result<(), CommandError> {
    if worktree.is_main {
        return Err(CommandError::new(
            "main_worktree_immutable",
            "主 worktree 不能在此锁定或解锁",
        ));
    }
    if worktree.bare {
        return Err(CommandError::new(
            "bare_worktree_unsupported",
            "当前不支持管理 bare worktree",
        ));
    }
    if worktree.prunable {
        return Err(CommandError::new(
            "prunable_worktree_unsupported",
            "该 worktree 记录已失效，请先使用 Git 修复或清理",
        ));
    }
    Ok(())
}

fn validate_worktree_path(path: &str) -> Result<(), CommandError> {
    let candidate = Path::new(path);
    if path.is_empty()
        || path.len() > 16 * 1024
        || path.bytes().any(|byte| byte.is_ascii_control())
        || !candidate.is_absolute()
    {
        return Err(CommandError::new(
            "invalid_worktree_path",
            "关联 worktree 路径格式无效",
        ));
    }
    Ok(())
}

fn validate_worktree_token(token: &str) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new("invalid_worktree_token", "worktree 确认令牌无效"))
}

fn validate_worktree_lock_reason(reason: Option<&str>) -> Result<Option<&str>, CommandError> {
    let reason = reason.map(str::trim).filter(|reason| !reason.is_empty());
    if reason.is_some_and(|reason| {
        reason.chars().count() > MAX_WORKTREE_LOCK_REASON_CHARS
            || reason.chars().any(char::is_control)
    }) {
        return Err(CommandError::new(
            "invalid_worktree_lock_reason",
            format!("锁定原因不能包含控制字符且不能超过 {MAX_WORKTREE_LOCK_REASON_CHARS} 个字符"),
        ));
    }
    Ok(reason)
}

pub fn preview_remote_edit(
    path: &Path,
    name: &str,
    token_namespace: &Uuid,
) -> Result<RemoteEditPreview, CommandError> {
    let root = repository_root(path)?;
    let name = validate_remote_name(&root, name)?;
    let snapshot = load_remote_snapshot(&root, &name, token_namespace)?;
    ensure_remote_is_editable(&snapshot)?;
    Ok(RemoteEditPreview {
        remote: snapshot.remote_info(),
        token: snapshot.token,
    })
}

pub fn preview_remote_delete(
    path: &Path,
    name: &str,
    token_namespace: &Uuid,
) -> Result<RemoteDeletePreview, CommandError> {
    let root = repository_root(path)?;
    let name = validate_remote_name(&root, name)?;
    let snapshot = load_remote_snapshot(&root, &name, token_namespace)?;
    Ok(RemoteDeletePreview {
        remote: snapshot.remote_info(),
        affected_branches: snapshot.affected_branches,
        token: snapshot.token,
    })
}

pub fn create_remote(path: &Path, input: &RemoteCreateInput) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let name = validate_remote_name(&root, &input.name)?;
    let fetch_url = validate_remote_url(&input.fetch_url)?;
    let push_url = input
        .push_url
        .as_deref()
        .map(validate_remote_url)
        .transpose()?;
    let remote_names = read_remote_names(&root)?;
    if remote_names.iter().any(|existing| existing == &name) {
        return Err(CommandError::new(
            "remote_already_exists",
            format!("远端 {name} 已存在"),
        ));
    }
    if remote_names.len() >= MAX_REMOTES {
        return Err(CommandError::new(
            "too_many_remotes",
            format!("单个仓库最多配置 {MAX_REMOTES} 个远端"),
        ));
    }

    execute_write_os(
        &root,
        &[
            OsString::from("remote"),
            OsString::from("add"),
            OsString::from(&name),
            OsString::from(&fetch_url),
        ],
    )
    .map_err(|_| CommandError::new("remote_create_failed", "创建远端失败"))?;

    if let Some(push_url) = push_url {
        if set_remote_push_url(&root, &name, &push_url).is_err() {
            let _ = remove_remote(&root, &name);
            return Err(CommandError::new(
                "remote_create_failed",
                "创建远端失败，已撤销本次修改",
            ));
        }
    }
    Ok(())
}

pub fn update_remote(
    path: &Path,
    input: &RemoteUpdateInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let name = validate_remote_name(&root, &input.name)?;
    validate_remote_token(&input.expected_token)?;
    if input.new_push_url.is_some() && input.reset_push_url {
        return Err(CommandError::new(
            "invalid_remote_update",
            "不能同时设置并重置 Push 地址",
        ));
    }
    if input.new_fetch_url.is_none() && input.new_push_url.is_none() && !input.reset_push_url {
        return Err(CommandError::new(
            "invalid_remote_update",
            "至少需要修改一个远端地址",
        ));
    }
    let new_fetch_url = input
        .new_fetch_url
        .as_deref()
        .map(validate_remote_url)
        .transpose()?;
    let new_push_url = input
        .new_push_url
        .as_deref()
        .map(validate_remote_url)
        .transpose()?;

    let snapshot = load_remote_snapshot(&root, &name, token_namespace)?;
    ensure_remote_is_editable(&snapshot)?;
    if snapshot.token != input.expected_token {
        return Err(CommandError::new(
            "remote_snapshot_changed",
            "远端配置已被外部修改，请重新打开后再操作",
        ));
    }

    let old_fetch_url = snapshot.fetch_urls[0].clone();
    let old_push_url = snapshot.explicit_push_urls.first().cloned();
    let result: Result<(), CommandError> = (|| {
        if let Some(fetch_url) = new_fetch_url.as_deref() {
            set_remote_fetch_url(&root, &name, fetch_url)?;
        }
        if let Some(push_url) = new_push_url.as_deref() {
            set_remote_push_url(&root, &name, push_url)?;
        } else if input.reset_push_url {
            clear_remote_push_urls(&root, &name)?;
        }
        Ok(())
    })();

    if result.is_err() {
        let rollback_fetch = set_remote_fetch_url(&root, &name, &old_fetch_url);
        let rollback_push = restore_remote_push_url(&root, &name, old_push_url.as_deref());
        return Err(if rollback_fetch.is_ok() && rollback_push.is_ok() {
            CommandError::new("remote_update_failed", "更新远端失败，已恢复原配置")
        } else {
            CommandError::new(
                "remote_update_rollback_failed",
                "更新远端失败，且无法完整恢复原配置；请使用 Git 检查该远端",
            )
        });
    }
    Ok(())
}

pub fn delete_remote(
    path: &Path,
    input: &RemoteDeleteInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let name = validate_remote_name(&root, &input.name)?;
    validate_remote_token(&input.expected_token)?;
    let snapshot = load_remote_snapshot(&root, &name, token_namespace)?;
    if snapshot.token != input.expected_token {
        return Err(CommandError::new(
            "remote_snapshot_changed",
            "远端配置或受影响分支已变化，请重新确认后再删除",
        ));
    }
    remove_remote(&root, &name)
        .map_err(|_| CommandError::new("remote_delete_failed", "删除远端失败"))
}

pub fn repository_tags(path: &Path) -> Result<RepositoryTags, CommandError> {
    let root = repository_root(path)?;
    let format = format!("--format={TAGS_FORMAT}");
    let output = execute_limited(
        Some(&root),
        &[
            OsStr::new("for-each-ref"),
            format.as_ref(),
            OsStr::new("refs/tags"),
        ],
        MAX_REFS_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "tag_list_too_large",
            "标签列表超过允许的读取上限",
        ));
    }
    let tags = tags_parser::parse_tags(&output.stdout)?;
    if tags.len() > MAX_TAGS {
        return Err(CommandError::new(
            "too_many_tags",
            format!("单个仓库最多读取 {MAX_TAGS} 个标签"),
        ));
    }
    Ok(RepositoryTags { tags })
}

/// Read only the top-level gitlinks recorded by the current index.  This is
/// deliberately not implemented with `git submodule update`, `init`, or
/// recursive traversal: the first submodule slice is an inventory surface,
/// not a mutation or network entry point.
pub fn repository_submodules(path: &Path) -> Result<RepositorySubmodules, CommandError> {
    let root = repository_root(path)?;
    let gitmodules_path = root.join(".gitmodules");
    let gitmodules_present = match fs::symlink_metadata(&gitmodules_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CommandError::new(
                "unsafe_gitmodules",
                ".gitmodules 是符号链接，已拒绝读取",
            ));
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(CommandError::new(
                "unsafe_gitmodules",
                ".gitmodules 不是普通文件，已拒绝读取",
            ));
        }
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(CommandError::new(
                "gitmodules_unreadable",
                format!("无法读取 .gitmodules：{error}"),
            ));
        }
    };

    let index = execute_limited(
        Some(&root),
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
        MAX_SUBMODULE_INDEX_OUTPUT_BYTES,
    )?;
    if index.truncated {
        return Err(CommandError::new(
            "submodule_list_too_large",
            "Git submodule 索引列表超过允许的读取上限",
        ));
    }
    let gitlinks = submodules_parser::parse_gitlinks(&index.stdout)?;

    let status = execute_limited(
        Some(&root),
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v2"),
            OsStr::new("-z"),
            OsStr::new("--untracked-files=no"),
            // Root status must not traverse an unsafe checkout path. Direct
            // checkout dirtiness is read separately after symlink checks.
            OsStr::new("--ignore-submodules=all"),
        ],
        MAX_SUBMODULE_STATUS_OUTPUT_BYTES,
    )?;
    if status.truncated {
        return Err(CommandError::new(
            "submodule_list_too_large",
            "Git submodule 状态超过允许的读取上限",
        ));
    }
    let statuses = submodules_parser::parse_status(&status.stdout)?;

    let configs = if gitmodules_present {
        let output = execute_limited_allow_codes(
            Some(&root),
            &[
                OsStr::new("config"),
                OsStr::new("--file"),
                OsStr::new(".gitmodules"),
                OsStr::new("--no-includes"),
                OsStr::new("--null"),
                OsStr::new("--get-regexp"),
                OsStr::new(r"^submodule\..*\.(path|url|branch)$"),
            ],
            MAX_GITMODULES_BYTES,
            &[0, 1],
        )?;
        if output.truncated {
            return Err(CommandError::new(
                "gitmodules_too_large",
                ".gitmodules 配置超过允许的读取上限",
            ));
        }
        submodules_parser::parse_gitmodules(&output.stdout)?
    } else {
        Vec::new()
    };

    let mut configs_by_path = BTreeMap::new();
    for config in configs {
        let Some(config_path) = config.path.as_deref() else {
            continue;
        };
        submodules_parser::validate_path(config_path).map_err(|_| {
            CommandError::new(
                "invalid_gitmodules",
                format!("子模块 {} 的 path 不是安全的仓库相对路径", config.name),
            )
        })?;
        if configs_by_path
            .insert(config_path.to_owned(), config)
            .is_some()
        {
            return Err(CommandError::new(
                "invalid_gitmodules",
                "多个 .gitmodules 条目指向同一个路径",
            ));
        }
    }

    let mut by_path = BTreeMap::new();
    for gitlink in gitlinks {
        let entry = by_path
            .entry(gitlink.path.clone())
            .or_insert_with(|| (Vec::new(), None::<String>));
        if gitlink.stage == 0 {
            if entry.1.replace(gitlink.oid).is_some() {
                return Err(CommandError::new(
                    "invalid_git_output",
                    "Git submodule index 包含重复的 stage 0 记录",
                ));
            }
        } else {
            entry.0.push(gitlink.oid);
        }
    }
    if by_path.len() > MAX_SUBMODULES {
        return Err(CommandError::new(
            "too_many_submodules",
            format!("单个仓库最多读取 {MAX_SUBMODULES} 个子模块"),
        ));
    }

    let mut submodules = Vec::with_capacity(by_path.len());
    for (module_path, (conflict_oids, expected_oid)) in by_path {
        let config = configs_by_path.remove(&module_path);
        let mut state = if !conflict_oids.is_empty() {
            SubmoduleState::Conflicted
        } else if expected_oid.is_none() {
            SubmoduleState::Unsafe
        } else {
            SubmoduleState::Clean
        };
        let mut state_detail = None;
        let configured = config.is_some();
        if !configured && state == SubmoduleState::Clean {
            state = SubmoduleState::Unsafe;
            state_detail = Some("缺少 .gitmodules 配置条目".to_owned());
        }
        if state != SubmoduleState::Conflicted {
            match inspect_submodule_checkout(&root, &module_path, expected_oid.as_deref())? {
                SubmoduleCheckout::Clean => {}
                SubmoduleCheckout::Modified if state == SubmoduleState::Clean => {
                    state = SubmoduleState::Modified;
                }
                SubmoduleCheckout::Uninitialized if state == SubmoduleState::Clean => {
                    state = SubmoduleState::Uninitialized;
                }
                SubmoduleCheckout::Modified | SubmoduleCheckout::Uninitialized => {}
                SubmoduleCheckout::Unsafe(detail) => {
                    state = SubmoduleState::Unsafe;
                    state_detail = Some(detail);
                }
            }
        }
        if let Some(status) = statuses.get(&module_path) {
            if status.conflicted {
                state = SubmoduleState::Conflicted;
            } else if status.modified && state == SubmoduleState::Clean {
                state = SubmoduleState::Modified;
            }
        }
        let (name, url, branch) = config
            .map(|item| (Some(item.name), item.url, item.branch))
            .unwrap_or((None, None, None));
        submodules.push(SubmoduleInfo {
            path: module_path,
            name,
            url: url.map(|value| sanitize_remote_url(&value)),
            branch,
            expected_oid,
            conflict_oids,
            state,
            configured,
            state_detail,
        });
    }

    // A gitlink without a .gitmodules entry is still useful to show, but its
    // missing configuration is explicit rather than silently invented.
    for (module_path, config) in configs_by_path {
        submodules.push(SubmoduleInfo {
            path: module_path,
            name: Some(config.name),
            url: config.url.map(|value| sanitize_remote_url(&value)),
            branch: config.branch,
            expected_oid: None,
            conflict_oids: Vec::new(),
            state: SubmoduleState::Unsafe,
            configured: true,
            state_detail: Some(".gitmodules 条目未在当前 index 中找到 gitlink".to_owned()),
        });
    }
    submodules.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(RepositorySubmodules {
        submodules,
        gitmodules_present,
    })
}

enum SubmoduleCheckout {
    Clean,
    Modified,
    Uninitialized,
    Unsafe(String),
}

fn inspect_submodule_checkout(
    root: &Path,
    module_path: &str,
    expected_oid: Option<&str>,
) -> Result<SubmoduleCheckout, CommandError> {
    let module_path = Path::new(module_path);
    let mut current = root.to_path_buf();
    for component in module_path.components() {
        let Component::Normal(part) = component else {
            return Ok(SubmoduleCheckout::Unsafe(
                "子模块路径包含非普通路径组件".to_owned(),
            ));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Ok(SubmoduleCheckout::Unsafe(
                    "子模块路径包含符号链接，已拒绝进入".to_owned(),
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Ok(SubmoduleCheckout::Unsafe(
                    "子模块路径不是目录，已拒绝进入".to_owned(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SubmoduleCheckout::Uninitialized);
            }
            Err(error) => {
                return Ok(SubmoduleCheckout::Unsafe(format!(
                    "无法读取子模块目录：{error}"
                )));
            }
        }
    }
    let Some(expected_oid) = expected_oid else {
        return Ok(SubmoduleCheckout::Unsafe(
            "缺少 stage 0 gitlink OID".to_owned(),
        ));
    };
    let output = execute_os_allow_failure(
        Some(&current),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("HEAD"),
        ],
    )?;
    if !output.status.success() {
        return Ok(SubmoduleCheckout::Unsafe(
            "子模块目录不是可读取 HEAD 的 Git 仓库".to_owned(),
        ));
    }
    let actual_oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    if !submodules_parser::is_oid(&actual_oid) {
        return Ok(SubmoduleCheckout::Unsafe(
            "子模块 HEAD OID 格式无效".to_owned(),
        ));
    }
    if actual_oid != expected_oid.to_ascii_lowercase() {
        return Ok(SubmoduleCheckout::Modified);
    }
    let status = execute_limited(
        Some(&current),
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v2"),
            OsStr::new("-z"),
            OsStr::new("--untracked-files=no"),
            // This slice is direct-only and never descends into nested
            // submodules while inspecting the checkout.
            OsStr::new("--ignore-submodules=all"),
        ],
        MAX_SUBMODULE_CHECKOUT_STATUS_BYTES,
    )?;
    if status.truncated || !status.stdout.is_empty() {
        return Ok(SubmoduleCheckout::Modified);
    }
    Ok(SubmoduleCheckout::Clean)
}

pub fn repository_stashes(path: &Path) -> Result<RepositoryStashes, CommandError> {
    let root = repository_root(path)?;
    let format = format!("--format={STASHES_FORMAT}");
    let output = execute_limited(
        Some(&root),
        &[OsStr::new("stash"), OsStr::new("list"), format.as_ref()],
        MAX_REFS_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "stash_list_too_large",
            "储藏列表超过允许的读取上限",
        ));
    }
    let stashes = stashes_parser::parse_stashes(&output.stdout)?;
    if stashes.len() > MAX_STASHES {
        return Err(CommandError::new(
            "too_many_stashes",
            format!("单个仓库最多读取 {MAX_STASHES} 条储藏"),
        ));
    }
    Ok(RepositoryStashes { stashes })
}

pub fn create_stash(path: &Path, input: &StashCreateInput) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    if !head_exists(&root)? {
        return Err(CommandError::new(
            "stash_initial_commit_required",
            "仓库至少需要一个提交后才能创建储藏",
        ));
    }

    let current_status = status(&root)?;
    if has_unmerged_changes(&current_status) {
        return Err(CommandError::new(
            "stash_repository_conflict",
            "仓库存在未解决的冲突，解决冲突后才能创建储藏",
        ));
    }
    let has_stashable_changes = current_status.changes.iter().any(|change| {
        !matches!(change.kind, crate::domain::ChangeKind::Untracked) || input.include_untracked
    });
    if !has_stashable_changes {
        return Err(CommandError::new(
            "nothing_to_stash",
            if current_status.changes.is_empty() {
                "没有可储藏的本地更改"
            } else {
                "只有未跟踪文件；启用“包含未跟踪文件”后才能储藏"
            },
        ));
    }

    let message = validate_stash_message(input.message.as_deref())?;
    let before_count = repository_stashes(&root)?.stashes.len();
    let mut arguments = vec![OsString::from("stash"), OsString::from("push")];
    if input.include_untracked {
        arguments.push(OsString::from("--include-untracked"));
    }
    if input.keep_index {
        arguments.push(OsString::from("--keep-index"));
    }
    if let Some(message) = message {
        arguments.push(OsString::from(format!("--message={message}")));
    }
    execute_stash_write_os(&root, &arguments).map_err(|_| {
        CommandError::new("stash_create_failed", "创建储藏失败，请刷新仓库状态后重试")
    })?;

    if repository_stashes(&root)?.stashes.len() <= before_count {
        return Err(CommandError::new(
            "nothing_to_stash",
            "没有可储藏的本地更改",
        ));
    }
    Ok(())
}

pub fn apply_stash(path: &Path, oid: &str, restore_index: bool) -> Result<(), CommandError> {
    mutate_stash_worktree(path, oid, restore_index, false)
}

pub fn pop_stash(path: &Path, oid: &str, restore_index: bool) -> Result<(), CommandError> {
    mutate_stash_worktree(path, oid, restore_index, true)
}

pub fn drop_stash(path: &Path, oid: &str) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let stash = resolve_stash_by_oid(&root, oid)?;
    verify_stash_selector(&root, &stash)?;
    execute_stash_write_os(
        &root,
        &[
            OsString::from("stash"),
            OsString::from("drop"),
            OsString::from("--quiet"),
            OsString::from(&stash.selector),
        ],
    )
    .map_err(|_| CommandError::new("stash_drop_failed", "删除储藏失败，请刷新储藏列表后重试"))
}

fn mutate_stash_worktree(
    path: &Path,
    oid: &str,
    restore_index: bool,
    pop: bool,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let current_status = status(&root)?;
    if has_unmerged_changes(&current_status) {
        return Err(CommandError::new(
            "stash_repository_conflict",
            "仓库存在未解决的冲突，解决冲突后才能恢复储藏",
        ));
    }

    let stash = resolve_stash_by_oid(&root, oid)?;
    verify_stash_selector(&root, &stash)?;
    let mut arguments = vec![
        OsString::from("stash"),
        OsString::from(if pop { "pop" } else { "apply" }),
    ];
    if restore_index {
        arguments.push(OsString::from("--index"));
    }
    arguments.push(OsString::from(&stash.selector));

    if execute_stash_write_os(&root, &arguments).is_err() {
        let after_status = status(&root)?;
        if has_unmerged_changes(&after_status) {
            return Err(CommandError::new(
                if pop {
                    "stash_pop_conflict"
                } else {
                    "stash_apply_conflict"
                },
                if pop {
                    "弹出储藏时产生冲突；该储藏仍然保留，请解决冲突后再处理"
                } else {
                    "应用储藏时产生冲突；该储藏仍然保留，请解决冲突后再处理"
                },
            ));
        }
        return Err(CommandError::new(
            if pop {
                "stash_pop_failed"
            } else {
                "stash_apply_failed"
            },
            if pop {
                "弹出储藏失败，请刷新仓库状态后重试"
            } else {
                "应用储藏失败，请刷新仓库状态后重试"
            },
        ));
    }
    Ok(())
}

fn resolve_stash_by_oid(repository: &Path, oid: &str) -> Result<StashInfo, CommandError> {
    validate_stash_oid(oid)?;
    let matches = repository_stashes(repository)?
        .stashes
        .into_iter()
        .filter(|stash| stash.oid.eq_ignore_ascii_case(oid))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Err(CommandError::new(
            "stash_not_found",
            "该储藏已不存在，请刷新后重试",
        )),
        [stash] => Ok(stash.clone()),
        _ => Err(CommandError::new(
            "stash_oid_ambiguous",
            "多个储藏具有相同对象标识，无法安全确定目标",
        )),
    }
}

fn verify_stash_selector(repository: &Path, stash: &StashInfo) -> Result<(), CommandError> {
    let revision = format!("{}^{{commit}}", stash.selector);
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new(&revision),
        ],
    )?;
    if output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case(&stash.oid)
    {
        return Ok(());
    }
    Err(CommandError::new(
        "stash_changed",
        "储藏列表已被其他 Git 进程修改，请刷新后重试",
    ))
}

fn validate_stash_message(message: Option<&str>) -> Result<Option<&str>, CommandError> {
    let Some(message) = message else {
        return Ok(None);
    };
    let message = message.trim();
    if message.is_empty()
        || message.chars().count() > MAX_STASH_MESSAGE_CHARS
        || message.chars().any(char::is_control)
    {
        return Err(CommandError::new(
            "invalid_stash_message",
            format!(
                "储藏说明不能为空、不能包含换行或控制字符，且不能超过 {MAX_STASH_MESSAGE_CHARS} 个字符"
            ),
        ));
    }
    Ok(Some(message))
}

fn validate_stash_oid(oid: &str) -> Result<(), CommandError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(CommandError::new(
        "invalid_stash_oid",
        "储藏对象标识格式无效",
    ))
}

fn has_unmerged_changes(status: &RepositoryStatus) -> bool {
    status
        .changes
        .iter()
        .any(|change| matches!(change.kind, crate::domain::ChangeKind::Unmerged))
}

pub fn create_tag(
    path: &Path,
    name: &str,
    target_oid: &str,
    message: Option<&str>,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let name = name.trim();
    validate_tag_name(&root, name)?;
    validate_oid(target_oid)?;
    let target_type = execute(Some(&root), &["cat-file", "-t", target_oid]).map_err(|error| {
        if error.code == "git_command_failed" {
            CommandError::new(
                "tag_target_not_found",
                "标签目标提交已不存在，请刷新提交历史后重试",
            )
        } else {
            error
        }
    })?;
    if String::from_utf8_lossy(&target_type.stdout).trim() != "commit" {
        return Err(CommandError::new(
            "tag_target_not_commit",
            "标签目标必须是仓库中的提交对象",
        ));
    }

    if repository_tags(&root)?
        .tags
        .iter()
        .any(|tag| tag.full_name == format!("refs/tags/{name}"))
    {
        return Err(CommandError::new(
            "tag_already_exists",
            format!("本地标签 {name} 已存在"),
        ));
    }

    let annotation = message.map(str::trim).filter(|value| !value.is_empty());
    if message.is_some() && annotation.is_none() {
        return Err(CommandError::new(
            "invalid_tag_message",
            "附注标签的说明不能为空",
        ));
    }
    if annotation.is_some_and(|value| value.len() > MAX_TAG_MESSAGE_BYTES) {
        return Err(CommandError::new(
            "invalid_tag_message",
            format!("标签说明不能超过 {} KiB", MAX_TAG_MESSAGE_BYTES / 1024),
        ));
    }

    if let Some(annotation) = annotation {
        execute_write_with_input(
            &root,
            &[
                "-c",
                "tag.gpgSign=false",
                "tag",
                "--annotate",
                "--file=-",
                "--",
                name,
                target_oid,
            ],
            annotation.as_bytes(),
        )
    } else {
        execute_write(
            &root,
            &["-c", "tag.gpgSign=false", "tag", "--", name, target_oid],
        )
    }
}

pub fn delete_tag(path: &Path, full_name: &str) -> Result<(), CommandError> {
    if full_name.is_empty() || full_name.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "invalid_tag_selector",
            "要删除的标签标识无效",
        ));
    }
    if !full_name.starts_with("refs/tags/") {
        return Err(CommandError::new(
            "local_tag_required",
            "只能删除已读取的本地标签",
        ));
    }

    let root = repository_root(path)?;
    let tags = repository_tags(&root)?;
    let tag: &TagInfo = tags
        .tags
        .iter()
        .find(|tag| tag.full_name == full_name)
        .ok_or_else(|| CommandError::new("tag_not_found", "该标签已不存在，请刷新后重试"))?;
    let arguments = [
        OsString::from("update-ref"),
        OsString::from("-d"),
        OsString::from(&tag.full_name),
        OsString::from(&tag.oid),
    ];
    execute_write_os(&root, &arguments)
}

fn validate_tag_name(repository: &Path, name: &str) -> Result<(), CommandError> {
    if name.is_empty()
        || name.len() > MAX_TAG_NAME_BYTES
        || name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(CommandError::new(
            "invalid_tag_name",
            "标签名不合法，请检查长度、空格或 Git 不允许的字符",
        ));
    }

    let full_name = format!("refs/tags/{name}");
    let output = execute_os_allow_failure(
        Some(repository),
        &[OsStr::new("check-ref-format"), OsStr::new(&full_name)],
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_tag_name",
            "标签名不合法，请检查长度、空格或 Git 不允许的字符",
        ))
    }
}

pub fn switch_local_branch(path: &Path, full_name: &str) -> Result<(), CommandError> {
    if full_name.is_empty() || full_name.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "invalid_branch_selector",
            "要切换的分支标识无效",
        ));
    }

    let root = repository_root(path)?;
    let refs = repository_refs(&root)?;
    let branch = refs
        .branches
        .iter()
        .find(|branch| branch.full_name == full_name)
        .ok_or_else(|| CommandError::new("branch_not_found", "该分支已不存在，请刷新后重试"))?;
    if !matches!(branch.kind, BranchKind::Local) {
        return Err(CommandError::new(
            "remote_branch_switch_unsupported",
            "暂不支持直接切换远端分支，请先创建本地跟踪分支",
        ));
    }
    if branch.current {
        return Ok(());
    }

    let arguments = [
        OsString::from("switch"),
        OsString::from("--"),
        OsString::from(&branch.name),
    ];
    execute_write_os(&root, &arguments)
}

pub fn preview_local_merge(
    path: &Path,
    target_full_name: &str,
) -> Result<LocalMergePreview, CommandError> {
    let root = repository_root(path)?;
    local_merge_preview(&root, target_full_name)
}

pub fn preview_revert(
    path: &Path,
    target_oid: &str,
    token_namespace: &Uuid,
) -> Result<RevertCommitPreview, CommandError> {
    let root = repository_root(path)?;
    validate_oid(target_oid)?;
    ensure_revert_operation_idle(&root)?;
    let repository_status = status(&root)?;
    if !repository_status.changes.is_empty() {
        return Err(CommandError::new(
            "revert_dirty_worktree",
            "撤销提交前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
        ));
    }
    let current_branch_ref = attached_head_ref(&root).map_err(|_| {
        CommandError::new(
            "revert_local_branch_required",
            "只能在 attached 本地分支上撤销提交",
        )
    })?;
    let current_branch = current_branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(&current_branch_ref)
        .to_owned();
    let current_oid = exact_commit_oid(&root, "HEAD")?;
    let target_oid = exact_commit_oid(&root, target_oid)?;
    if !is_ancestor(&root, &target_oid, &current_oid)? {
        return Err(CommandError::new(
            "revert_target_not_in_history",
            "只能撤销当前分支历史中的提交",
        ));
    }
    let (target, _) = commit_summary_and_body(&root, &target_oid)?;
    if target.parent_oids.len() != 1 {
        return Err(CommandError::new(
            "revert_merge_commit_unsupported",
            "当前只支持撤销单父提交，暂不支持撤销 merge commit",
        ));
    }
    let target_parent_oid = target.parent_oids[0].clone();
    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, b"revert-commit-v1");
    append_token_bytes(&mut token_material, current_branch_ref.as_bytes());
    append_token_bytes(&mut token_material, current_oid.as_bytes());
    append_token_bytes(&mut token_material, target_oid.as_bytes());
    append_token_bytes(&mut token_material, target_parent_oid.as_bytes());
    append_token_bytes(&mut token_material, target.subject.as_bytes());
    Ok(RevertCommitPreview {
        current_branch,
        current_oid,
        target_oid,
        target_parent_oid,
        target_subject: target.subject,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    })
}

pub fn revert_commit(
    path: &Path,
    input: &RevertCommitInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_oid(&input.target_oid)?;
    validate_revert_token(&input.expected_token)?;
    let preview = preview_revert(&root, &input.target_oid, token_namespace)?;
    if preview.token != input.expected_token {
        return Err(CommandError::new(
            "revert_snapshot_changed",
            "当前分支、提交历史或工作区已发生变化，请刷新后重试",
        ));
    }

    let result = execute_write_os(
        &root,
        &[
            OsString::from("-c"),
            OsString::from("core.editor=true"),
            OsString::from("-c"),
            OsString::from("commit.gpgSign=false"),
            OsString::from("revert"),
            OsString::from("--no-edit"),
            OsString::from("--no-gpg-sign"),
            OsString::from(&preview.target_oid),
        ],
    );
    if result.is_ok() {
        return Ok(());
    }

    if revert_operation_in_progress(&root)? {
        if abort_revert(&root).is_err() {
            return Err(CommandError::new(
                "revert_recovery_failed",
                "撤销提交产生冲突，且自动中止失败；请立即刷新仓库状态并在终端中恢复",
            ));
        }
        return Err(CommandError::new(
            "revert_conflict",
            "撤销提交产生冲突，应用已自动中止；请刷新工作区后手动处理",
        ));
    }
    Err(CommandError::new(
        "revert_failed",
        "Git 拒绝撤销该提交，请刷新仓库状态后重试",
    ))
}

pub fn preview_cherry_pick(
    path: &Path,
    target_oid: &str,
    token_namespace: &Uuid,
) -> Result<CherryPickCommitPreview, CommandError> {
    let root = repository_root(path)?;
    validate_oid(target_oid)?;
    ensure_history_mutation_idle(&root, "Cherry-pick")?;
    let repository_status = status(&root)?;
    if !repository_status.changes.is_empty() {
        return Err(CommandError::new(
            "cherry_pick_dirty_worktree",
            "Cherry-pick 前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
        ));
    }
    let current_branch_ref = attached_head_ref(&root).map_err(|_| {
        CommandError::new(
            "cherry_pick_local_branch_required",
            "只能在 attached 本地分支上 Cherry-pick 提交",
        )
    })?;
    let current_branch = current_branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(&current_branch_ref)
        .to_owned();
    let current_oid = exact_commit_oid(&root, "HEAD")?;
    let target_oid = exact_commit_oid(&root, target_oid)?;
    let (target, _) = commit_summary_and_body(&root, &target_oid)?;
    if target.parent_oids.len() != 1 {
        return Err(CommandError::new(
            "cherry_pick_merge_commit_unsupported",
            "当前只支持 Cherry-pick 单父提交，暂不支持 merge commit",
        ));
    }

    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, b"cherry-pick-commit-v1");
    append_token_bytes(&mut token_material, current_branch_ref.as_bytes());
    append_token_bytes(&mut token_material, current_oid.as_bytes());
    append_token_bytes(&mut token_material, target_oid.as_bytes());
    append_token_bytes(&mut token_material, target.subject.as_bytes());
    Ok(CherryPickCommitPreview {
        current_branch,
        current_oid,
        target_oid,
        target_subject: target.subject,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    })
}

pub fn cherry_pick_commit(
    path: &Path,
    input: &CherryPickCommitInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_oid(&input.target_oid)?;
    validate_commit_action_token(
        &input.expected_token,
        "invalid_cherry_pick_token",
        "Cherry-pick",
    )?;
    let preview = preview_cherry_pick(&root, &input.target_oid, token_namespace)?;
    if preview.token != input.expected_token {
        return Err(CommandError::new(
            "cherry_pick_snapshot_changed",
            "当前分支、提交历史或工作区已发生变化，请重新预览后再 Cherry-pick",
        ));
    }

    let result = execute_write_os(
        &root,
        &[
            OsString::from("-c"),
            OsString::from("core.editor=true"),
            OsString::from("-c"),
            OsString::from("commit.gpgSign=false"),
            OsString::from("cherry-pick"),
            OsString::from("--no-gpg-sign"),
            OsString::from(&preview.target_oid),
        ],
    );
    if result.is_ok() {
        return Ok(());
    }

    if fs::symlink_metadata(git_state_path(&root, "CHERRY_PICK_HEAD")?).is_ok() {
        if execute_write(&root, &["cherry-pick", "--abort"]).is_err() {
            return Err(CommandError::new(
                "cherry_pick_recovery_failed",
                "Cherry-pick 产生冲突，且自动中止失败；请立即刷新仓库状态并在终端中恢复",
            ));
        }
        return Err(CommandError::new(
            "cherry_pick_conflict",
            "Cherry-pick 产生冲突，应用已自动中止；请刷新工作区后手动处理",
        ));
    }
    Err(CommandError::new(
        "cherry_pick_failed",
        "Git 拒绝 Cherry-pick 该提交，请刷新仓库状态后重试",
    ))
}

pub fn preview_reset_commit(
    path: &Path,
    selected_oid: &str,
    mode: ResetCommitMode,
    token_namespace: &Uuid,
) -> Result<ResetCommitPreview, CommandError> {
    let root = repository_root(path)?;
    validate_oid(selected_oid)?;
    ensure_history_mutation_idle(&root, "重置提交")?;
    let repository_status = status(&root)?;
    if !repository_status.changes.is_empty() {
        return Err(CommandError::new(
            "reset_dirty_worktree",
            "重置提交前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
        ));
    }
    let current_branch_ref = attached_head_ref(&root).map_err(|_| {
        CommandError::new(
            "reset_local_branch_required",
            "只能重置 attached 本地分支，请先切换到本地分支",
        )
    })?;
    let current_branch = current_branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(&current_branch_ref)
        .to_owned();
    let current_oid = exact_commit_oid(&root, "HEAD")?;
    let selected_oid = exact_commit_oid(&root, selected_oid)?;
    let (selected, _) = commit_summary_and_body(&root, &selected_oid)?;
    let selected_is_head = selected_oid == current_oid;
    let target_oid = if selected_is_head {
        selected.parent_oids.first().cloned().ok_or_else(|| {
            CommandError::new(
                "reset_root_commit_unsupported",
                "根提交没有父提交，不能通过此操作撤销",
            )
        })?
    } else {
        selected_oid.clone()
    };

    let mut published_refs =
        read_refs_matching(&root, &format!("--contains={current_oid}"), "refs/remotes")?;
    published_refs.extend(read_refs_matching(
        &root,
        &format!("--contains={current_oid}"),
        "refs/tags",
    )?);
    if !published_refs.is_empty() {
        return Err(CommandError::new(
            "reset_published_history",
            "当前 HEAD 已被远端分支或标签引用，禁止重置已发布历史；请改用 Revert",
        ));
    }

    let index_snapshot = amend_command_snapshot(
        &root,
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
    )?;
    let staged_diff = amend_command_snapshot(
        &root,
        &[
            OsStr::new("diff"),
            OsStr::new("--cached"),
            OsStr::new("--binary"),
            OsStr::new("--full-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
            OsStr::new("--"),
        ],
    )?;
    let worktree_diff = amend_command_snapshot(
        &root,
        &[
            OsStr::new("diff"),
            OsStr::new("--binary"),
            OsStr::new("--full-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
            OsStr::new("--"),
        ],
    )?;

    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, b"reset-commit-v1");
    append_token_bytes(&mut token_material, current_branch_ref.as_bytes());
    append_token_bytes(&mut token_material, current_oid.as_bytes());
    append_token_bytes(&mut token_material, selected_oid.as_bytes());
    append_token_bytes(&mut token_material, target_oid.as_bytes());
    append_token_bytes(&mut token_material, reset_mode_argument(mode).as_bytes());
    append_token_bytes(&mut token_material, &index_snapshot);
    append_token_bytes(&mut token_material, &staged_diff);
    append_token_bytes(&mut token_material, &worktree_diff);

    Ok(ResetCommitPreview {
        current_branch,
        current_oid,
        selected_oid,
        selected_subject: selected.subject,
        target_oid,
        selected_is_head,
        mode,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    })
}

pub fn reset_commit(
    path: &Path,
    input: &ResetCommitInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    validate_oid(&input.selected_oid)?;
    validate_commit_action_token(&input.expected_token, "invalid_reset_token", "重置提交")?;
    let preview = preview_reset_commit(&root, &input.selected_oid, input.mode, token_namespace)?;
    if preview.token != input.expected_token {
        return Err(CommandError::new(
            "reset_snapshot_changed",
            "当前分支、提交历史、暂存区或工作区已发生变化，请重新预览后再重置",
        ));
    }
    execute_write_os(
        &root,
        &[
            OsString::from("reset"),
            OsString::from(reset_mode_argument(input.mode)),
            OsString::from(&preview.target_oid),
        ],
    )
    .map_err(|_| CommandError::new("reset_failed", "Git 拒绝重置当前分支，请刷新仓库状态后重试"))
}

fn reset_mode_argument(mode: ResetCommitMode) -> &'static str {
    match mode {
        ResetCommitMode::Soft => "--soft",
        ResetCommitMode::Mixed => "--mixed",
        ResetCommitMode::Hard => "--hard",
    }
}

fn is_ancestor(
    repository: &Path,
    ancestor_oid: &str,
    descendant_oid: &str,
) -> Result<bool, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("merge-base"),
            OsStr::new("--is-ancestor"),
            OsStr::new(ancestor_oid),
            OsStr::new(descendant_oid),
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => ensure_success(output).map(|_| false),
    }
}

pub fn preview_merge_recovery(
    path: &Path,
    token_namespace: &Uuid,
) -> Result<Option<MergeRecoveryPreview>, CommandError> {
    let root = repository_root(path)?;
    merge_recovery_snapshot(&root, token_namespace).map(|snapshot| {
        snapshot.map(|snapshot| MergeRecoveryPreview {
            current_branch: snapshot.current_branch,
            head_oid: snapshot.head_oid,
            merge_head_oid: snapshot.merge_head_oid,
            unresolved_conflict_count: snapshot.unresolved_conflict_count,
            has_unstaged_changes: snapshot.has_unstaged_changes,
            can_continue: snapshot.unresolved_conflict_count == 0 && !snapshot.has_unstaged_changes,
            token: snapshot.token,
        })
    })
}

pub fn continue_merge_recovery(
    path: &Path,
    input: &MergeRecoveryInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    validate_merge_recovery_token(&input.expected_token)?;
    let root = repository_root(path)?;
    let snapshot = require_current_merge_recovery(&root, &input.expected_token, token_namespace)?;
    if snapshot.unresolved_conflict_count > 0 {
        return Err(CommandError::new(
            "merge_conflicts_unresolved",
            "仍有冲突文件未解决，请解决全部冲突后再继续合并",
        ));
    }
    if snapshot.has_unstaged_changes {
        return Err(CommandError::new(
            "merge_worktree_not_clean",
            "工作区仍有未暂存或未跟踪更改，请先处理后再继续合并",
        ));
    }

    let arguments = vec![
        OsString::from("-c"),
        OsString::from("core.editor=true"),
        OsString::from("-c"),
        OsString::from("commit.gpgSign=false"),
        OsString::from("merge"),
        OsString::from("--continue"),
    ];
    let (exit_status, _stderr) = execute_merge_allow_failure(&root, &arguments)?;
    if exit_status.success() {
        return Ok(());
    }
    if merge_in_progress(&root)? && has_unmerged_changes(&status(&root)?) {
        return Err(CommandError::new(
            "merge_conflicts_unresolved",
            "继续合并时仍检测到未解决冲突，请刷新工作区后重试",
        ));
    }
    Err(CommandError::new(
        "merge_continue_failed",
        "继续合并失败；仓库仍可能处于合并状态，请刷新并检查 Git hooks 或提交者信息",
    ))
}

pub fn abort_merge_recovery(
    path: &Path,
    input: &MergeRecoveryInput,
    token_namespace: &Uuid,
) -> Result<(), CommandError> {
    validate_merge_recovery_token(&input.expected_token)?;
    let root = repository_root(path)?;
    require_current_merge_recovery(&root, &input.expected_token, token_namespace)?;
    abort_merge(&root).map_err(|_| {
        CommandError::new(
            "merge_abort_failed",
            "无法安全终止当前合并，请刷新仓库状态并使用系统 Git 检查恢复方式",
        )
    })
}

pub fn merge_local_branch(
    path: &Path,
    target_full_name: &str,
    strategy: LocalMergeStrategy,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let preview = local_merge_preview(&root, target_full_name)?;
    if matches!(preview.mode, LocalMergeMode::UpToDate) {
        return Ok(());
    }
    if matches!(strategy, LocalMergeStrategy::FastForwardOnly)
        && matches!(preview.mode, LocalMergeMode::MergeCommit)
    {
        return Err(CommandError::new(
            "local_merge_not_fast_forward",
            "所选分支与当前分支已经分叉，无法执行仅快进合并",
        ));
    }

    let mut arguments = vec![
        OsString::from("-c"),
        OsString::from("core.editor=true"),
        OsString::from("-c"),
        OsString::from("commit.gpgSign=false"),
        OsString::from("merge"),
        OsString::from(match strategy {
            LocalMergeStrategy::FastForwardOnly => "--ff-only",
            LocalMergeStrategy::CreateMergeCommit => "--no-ff",
        }),
        OsString::from("--no-edit"),
        OsString::from("--no-gpg-sign"),
    ];
    if matches!(strategy, LocalMergeStrategy::CreateMergeCommit) {
        arguments.push(OsString::from("--message"));
        arguments.push(OsString::from(format!(
            "Merge branch '{}'",
            preview.target_branch
        )));
    }
    // Use the OID re-read under the repository write lock instead of trusting either
    // the earlier UI preview or a ref that another Git process could move mid-command.
    arguments.push(OsString::from(&preview.target_oid));

    let (exit_status, _stderr) = execute_merge_allow_failure(&root, &arguments)?;
    if exit_status.success() {
        return Ok(());
    }

    let had_conflicts = status(&root).is_ok_and(|repository_status| {
        repository_status
            .changes
            .iter()
            .any(|change| matches!(change.kind, crate::domain::ChangeKind::Unmerged))
    });
    if merge_in_progress(&root)? {
        if abort_merge(&root).is_err() {
            return Err(CommandError::new(
                "local_merge_recovery_failed",
                "合并未完成，且自动执行 git merge --abort 失败；请立即刷新仓库状态并在终端中恢复",
            ));
        }
        if had_conflicts {
            return Err(CommandError::new(
                "local_merge_conflict",
                "合并产生冲突，应用已执行 git merge --abort；请刷新工作区确认，Git hooks 创建的额外未跟踪文件可能仍会保留",
            ));
        }
        return Err(CommandError::new(
            "local_merge_failed",
            "合并未完成，应用已执行 git merge --abort；请检查 Git 用户信息或本地 hooks 后重试",
        ));
    }

    Err(CommandError::new(
        "local_merge_failed",
        "Git 拒绝了本地分支合并，请刷新仓库状态并检查本地 hooks 后重试",
    ))
}

fn local_merge_preview(
    repository: &Path,
    target_full_name: &str,
) -> Result<LocalMergePreview, CommandError> {
    if target_full_name.is_empty() || target_full_name.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "invalid_branch_selector",
            "要合并的分支标识无效",
        ));
    }
    if !target_full_name.starts_with("refs/heads/") {
        return Err(CommandError::new(
            "local_branch_required",
            "只能合并已读取的本地分支",
        ));
    }
    if merge_in_progress(repository)? {
        return Err(CommandError::new(
            "local_merge_in_progress",
            "仓库已有尚未完成的合并，请先在 Git 中完成或中止该操作",
        ));
    }

    let repository_status = status(repository)?;
    if repository_status
        .changes
        .iter()
        .any(|change| matches!(change.kind, crate::domain::ChangeKind::Unmerged))
    {
        return Err(CommandError::new(
            "repository_has_conflicts",
            "仓库存在未解决的冲突，解决冲突后才能合并分支",
        ));
    }
    if !repository_status.changes.is_empty() {
        return Err(CommandError::new(
            "local_merge_dirty_worktree",
            "合并前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
        ));
    }

    let refs = repository_refs(repository)?;
    let current = refs
        .branches
        .iter()
        .find(|branch| matches!(branch.kind, BranchKind::Local) && branch.current)
        .ok_or_else(|| {
            CommandError::new(
                "local_merge_current_branch_required",
                "当前 HEAD 未附着到本地分支，不能执行本地分支合并",
            )
        })?;
    let target = refs
        .branches
        .iter()
        .find(|branch| branch.full_name == target_full_name)
        .ok_or_else(|| CommandError::new("branch_not_found", "该分支已不存在，请刷新后重试"))?;
    if !matches!(target.kind, BranchKind::Local) {
        return Err(CommandError::new(
            "local_branch_required",
            "只能合并已读取的本地分支",
        ));
    }
    if target.current || target.full_name == current.full_name {
        return Err(CommandError::new(
            "local_merge_same_branch",
            "不能把当前分支合并到自身",
        ));
    }

    ensure_common_ancestor(repository, &current.oid, &target.oid)?;
    let (ahead, behind) = local_merge_counts(repository, &current.oid, &target.oid)?;
    let mode = if behind == 0 {
        LocalMergeMode::UpToDate
    } else if ahead == 0 {
        LocalMergeMode::FastForward
    } else {
        LocalMergeMode::MergeCommit
    };
    Ok(LocalMergePreview {
        current_branch: current.name.clone(),
        current_full_name: current.full_name.clone(),
        current_oid: current.oid.clone(),
        target_branch: target.name.clone(),
        target_full_name: target.full_name.clone(),
        target_oid: target.oid.clone(),
        mode,
        ahead,
        behind,
    })
}

fn ensure_common_ancestor(
    repository: &Path,
    current_oid: &str,
    target_oid: &str,
) -> Result<(), CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("merge-base"),
            OsStr::new(current_oid),
            OsStr::new(target_oid),
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(()),
        Some(1) => Err(CommandError::new(
            "local_merge_unrelated_history",
            "两个本地分支没有共同祖先，不支持合并无关历史",
        )),
        _ => ensure_success(output).map(|_| ()),
    }
}

fn local_merge_counts(
    repository: &Path,
    current_oid: &str,
    target_oid: &str,
) -> Result<(u64, u64), CommandError> {
    let range = format!("{current_oid}...{target_oid}");
    let output = execute_os(
        Some(repository),
        &[
            OsStr::new("rev-list"),
            OsStr::new("--left-right"),
            OsStr::new("--count"),
            OsStr::new(&range),
        ],
    )?;
    let counts = String::from_utf8_lossy(&output.stdout);
    let mut fields = counts.split_whitespace();
    let ahead = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| CommandError::new("invalid_git_output", "无法解析本地分支合并关系"))?;
    let behind = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| CommandError::new("invalid_git_output", "无法解析本地分支合并关系"))?;
    if fields.next().is_some() {
        return Err(CommandError::new(
            "invalid_git_output",
            "无法解析本地分支合并关系",
        ));
    }
    Ok((ahead, behind))
}

fn require_current_merge_recovery(
    repository: &Path,
    expected_token: &str,
    token_namespace: &Uuid,
) -> Result<MergeRecoverySnapshot, CommandError> {
    let snapshot = merge_recovery_snapshot(repository, token_namespace)?.ok_or_else(|| {
        CommandError::new(
            "merge_not_in_progress",
            "当前仓库没有正在进行的合并，请刷新后重试",
        )
    })?;
    if snapshot.token != expected_token {
        return Err(CommandError::new(
            "merge_recovery_changed",
            "合并状态、暂存内容或工作区已发生变化，请刷新后重新确认",
        ));
    }
    Ok(snapshot)
}

fn merge_recovery_snapshot(
    repository: &Path,
    token_namespace: &Uuid,
) -> Result<Option<MergeRecoverySnapshot>, CommandError> {
    if !merge_in_progress(repository)? {
        return Ok(None);
    }

    let repository_status = status(repository)?;
    let head_oid = exact_commit_oid(repository, "HEAD")?;
    let merge_head_oid = exact_commit_oid(repository, "MERGE_HEAD")?;
    let unresolved_conflict_count = repository_status
        .changes
        .iter()
        .filter(|change| matches!(change.kind, ChangeKind::Unmerged))
        .count() as u64;
    let has_unstaged_changes = repository_status.changes.iter().any(|change| {
        matches!(change.kind, ChangeKind::Untracked) || change.worktree_status.is_some()
    });

    let index_snapshot = merge_recovery_command_snapshot(
        repository,
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
    )?;
    let staged_diff = merge_recovery_command_snapshot(
        repository,
        &[
            OsStr::new("diff"),
            OsStr::new("--cached"),
            OsStr::new("--binary"),
            OsStr::new("--full-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
        ],
    )?;
    let worktree_diff = merge_recovery_command_snapshot(
        repository,
        &[
            OsStr::new("diff"),
            OsStr::new("--binary"),
            OsStr::new("--full-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
        ],
    )?;
    let merge_message = read_git_state_file(repository, "MERGE_MSG")?;

    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, head_oid.as_bytes());
    append_token_bytes(&mut token_material, merge_head_oid.as_bytes());
    append_token_bytes(
        &mut token_material,
        repository_status
            .branch
            .head
            .as_deref()
            .unwrap_or("")
            .as_bytes(),
    );
    for change in &repository_status.changes {
        append_token_bytes(&mut token_material, change.path.as_bytes());
        append_token_bytes(
            &mut token_material,
            change.original_path.as_deref().unwrap_or("").as_bytes(),
        );
        append_token_bytes(
            &mut token_material,
            change.index_status.as_deref().unwrap_or("").as_bytes(),
        );
        append_token_bytes(
            &mut token_material,
            change.worktree_status.as_deref().unwrap_or("").as_bytes(),
        );
        append_token_bytes(
            &mut token_material,
            match change.kind {
                ChangeKind::Ordinary => b"ordinary".as_slice(),
                ChangeKind::Renamed => b"renamed".as_slice(),
                ChangeKind::Unmerged => b"unmerged".as_slice(),
                ChangeKind::Untracked => b"untracked".as_slice(),
            },
        );
    }
    append_token_bytes(&mut token_material, &index_snapshot);
    append_token_bytes(&mut token_material, &staged_diff);
    append_token_bytes(&mut token_material, &worktree_diff);
    append_token_bytes(&mut token_material, &merge_message);

    Ok(Some(MergeRecoverySnapshot {
        current_branch: repository_status.branch.head,
        head_oid,
        merge_head_oid,
        unresolved_conflict_count,
        has_unstaged_changes,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    }))
}

fn exact_commit_oid(repository: &Path, revision: &str) -> Result<String, CommandError> {
    let revision = format!("{revision}^{{commit}}");
    let output = execute(
        Some(repository),
        &["rev-parse", "--verify", revision.as_str()],
    )?;
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    validate_oid(&oid)?;
    Ok(oid)
}

fn merge_recovery_command_snapshot(
    repository: &Path,
    arguments: &[&OsStr],
) -> Result<Vec<u8>, CommandError> {
    let output = execute_limited(
        Some(repository),
        arguments,
        MAX_MERGE_RECOVERY_SNAPSHOT_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "merge_recovery_snapshot_too_large",
            "合并恢复快照超过安全读取上限，请使用系统 Git 检查并恢复该仓库",
        ));
    }
    Ok(output.stdout)
}

fn read_git_state_file(repository: &Path, name: &str) -> Result<Vec<u8>, CommandError> {
    let path = git_state_path(repository, name)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        CommandError::new(
            "merge_recovery_state_unavailable",
            format!("无法读取 Git 合并状态：{error}"),
        )
    })?;
    if metadata.len() > MAX_MERGE_RECOVERY_SNAPSHOT_BYTES as u64 {
        return Err(CommandError::new(
            "merge_recovery_snapshot_too_large",
            "合并消息超过安全读取上限，请使用系统 Git 检查并恢复该仓库",
        ));
    }
    fs::read(path).map_err(CommandError::from)
}

fn git_state_path(repository: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let output = execute(Some(repository), &["rev-parse", "--git-path", name])?;
    let raw_path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let path = PathBuf::from(raw_path);
    Ok(if path.is_absolute() {
        path
    } else {
        repository.join(path)
    })
}

fn append_token_bytes(target: &mut Vec<u8>, value: &[u8]) {
    target.extend_from_slice(value.len().to_string().as_bytes());
    target.push(0);
    target.extend_from_slice(value);
    target.push(0);
}

fn validate_merge_recovery_token(token: &str) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new("invalid_merge_recovery_token", "合并恢复确认令牌无效"))
}

fn validate_amend_commit_token(token: &str) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new("invalid_amend_token", "修改提交确认令牌无效"))
}

fn validate_revert_token(token: &str) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new("invalid_revert_token", "撤销提交确认令牌无效"))
}

fn validate_commit_action_token(
    token: &str,
    code: &'static str,
    operation: &'static str,
) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new(code, format!("{operation}确认令牌无效")))
}

fn ensure_history_mutation_idle(repository: &Path, operation: &str) -> Result<(), CommandError> {
    const STATE_MARKERS: &[&str] = &[
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
    ];
    for marker in STATE_MARKERS {
        if fs::symlink_metadata(git_state_path(repository, marker)?).is_ok() {
            return Err(CommandError::new(
                "history_mutation_in_progress",
                format!("仓库存在尚未完成的 Git 操作，不能执行{operation}"),
            ));
        }
    }
    Ok(())
}

fn revert_operation_in_progress(repository: &Path) -> Result<bool, CommandError> {
    Ok(fs::symlink_metadata(git_state_path(repository, "REVERT_HEAD")?).is_ok())
}

fn ensure_revert_operation_idle(repository: &Path) -> Result<(), CommandError> {
    const STATE_MARKERS: &[&str] = &[
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
    ];
    for marker in STATE_MARKERS {
        if fs::symlink_metadata(git_state_path(repository, marker)?).is_ok() {
            return Err(CommandError::new(
                "revert_operation_in_progress",
                "仓库存在尚未完成的 merge、rebase、cherry-pick 或 revert，不能撤销提交",
            ));
        }
    }
    Ok(())
}

fn abort_revert(repository: &Path) -> Result<(), CommandError> {
    execute_write(repository, &["revert", "--abort"])
}

fn merge_in_progress(repository: &Path) -> Result<bool, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("MERGE_HEAD"),
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => ensure_success(output).map(|_| true),
    }
}

fn abort_merge(repository: &Path) -> Result<(), CommandError> {
    execute_write(repository, &["-c", "core.editor=true", "merge", "--abort"])
}

fn execute_merge_allow_failure(
    repository: &Path,
    arguments: &[OsString],
) -> Result<(ExitStatus, Vec<u8>), CommandError> {
    let mut command = git_command(Some(repository), GitLocking::Required);
    command
        .args(arguments)
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}"))
    })?;
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 错误输出",
            ));
        }
    };
    let stderr_reader = thread::spawn(move || read_capped(stderr, MAX_STDERR_BYTES));
    let status = match wait_for_local_process(&mut child, OperationDeadline::new(LOCAL_GIT_TIMEOUT))
    {
        Ok(status) => status,
        Err(error) => {
            let _ = join_reader(stderr_reader);
            return Err(error);
        }
    };
    let (stderr, _) = join_reader(stderr_reader)?;
    Ok((status, stderr))
}

pub fn delete_local_branch(
    path: &Path,
    full_name: &str,
    allow_unmerged: bool,
) -> Result<(), CommandError> {
    if full_name.is_empty() || full_name.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "invalid_branch_selector",
            "要删除的分支标识无效",
        ));
    }
    if !full_name.starts_with("refs/heads/") {
        return Err(CommandError::new(
            "local_branch_required",
            "只能删除已读取的本地分支",
        ));
    }

    let root = repository_root(path)?;
    let refs = repository_refs(&root)?;
    let branch = refs
        .branches
        .iter()
        .find(|branch| branch.full_name == full_name)
        .ok_or_else(|| CommandError::new("branch_not_found", "该分支已不存在，请刷新后重试"))?;
    if !matches!(branch.kind, BranchKind::Local) {
        return Err(CommandError::new(
            "local_branch_required",
            "只能删除已读取的本地分支",
        ));
    }
    if branch.current {
        return Err(CommandError::new(
            "current_branch_delete_unsupported",
            "不能删除当前检出的分支，请先切换到其他本地分支",
        ));
    }

    let merged_output = execute_os_allow_failure(
        Some(&root),
        &[
            OsStr::new("merge-base"),
            OsStr::new("--is-ancestor"),
            OsStr::new(&branch.full_name),
            OsStr::new("HEAD"),
        ],
    )?;
    let merged = match merged_output.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => return ensure_success(merged_output).map(|_| ()),
    };
    if !merged && !allow_unmerged {
        return Err(CommandError::new(
            "local_branch_not_merged",
            "该本地分支尚未合并，需要再次确认后才能删除",
        ));
    }

    delete_local_branch_ref(&root, &branch.full_name, &branch.oid)
}

fn delete_local_branch_ref(
    repository: &Path,
    full_name: &str,
    expected_oid: &str,
) -> Result<(), CommandError> {
    execute_write_os(
        repository,
        &[
            OsString::from("update-ref"),
            OsString::from("-d"),
            OsString::from(full_name),
            OsString::from(expected_oid),
        ],
    )
}

pub fn create_and_switch_branch(path: &Path, name: &str) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    if !head_exists(&root)? {
        return Err(CommandError::new(
            "branch_requires_commit",
            "首次提交后才能从当前提交创建新分支",
        ));
    }
    let name = name.trim();
    validate_branch_name(&root, name)?;
    let arguments = [
        OsString::from("switch"),
        OsString::from("-c"),
        OsString::from(name),
    ];
    execute_write_os(&root, &arguments)
}

pub fn create_branch_at_commit(
    path: &Path,
    name: &str,
    target_oid: &str,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let name = name.trim();
    validate_branch_name(&root, name)?;
    validate_oid(target_oid)?;

    let target_type = execute_os_allow_failure(
        Some(&root),
        &[
            OsStr::new("cat-file"),
            OsStr::new("-t"),
            OsStr::new(target_oid),
        ],
    )?;
    if !target_type.status.success() {
        return Err(CommandError::new(
            "branch_target_not_found",
            "分支目标提交已不存在，请刷新提交历史后重试",
        ));
    }
    if String::from_utf8_lossy(&target_type.stdout).trim() != "commit" {
        return Err(CommandError::new(
            "branch_target_not_commit",
            "分支目标必须是已读取的提交对象",
        ));
    }

    let full_name = format!("refs/heads/{name}");
    let refs = repository_refs(&root)?;
    if refs
        .branches
        .iter()
        .any(|branch| branch.full_name == full_name)
    {
        return Err(CommandError::new(
            "local_branch_already_exists",
            format!("本地分支 {name} 已存在"),
        ));
    }
    if local_branch_ref_path_conflicts(&refs, &full_name) {
        return Err(CommandError::new(
            "local_branch_name_conflict",
            "分支名与现有引用的路径冲突，请使用其他分支名",
        ));
    }

    // Supplying an empty expected old OID makes this an atomic create-only
    // update. An external Git process cannot silently move an existing ref
    // between the authoritative read above and this write.
    let reason = format!("branch: Created from {}", &target_oid[..12]);
    let arguments = [
        OsString::from("update-ref"),
        OsString::from("--create-reflog"),
        OsString::from("-m"),
        OsString::from(reason),
        OsString::from(&full_name),
        OsString::from(target_oid),
        OsString::new(),
    ];
    let argument_refs = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    match execute_capped(
        Some(&root),
        &argument_refs,
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        None,
    ) {
        Ok(_) => Ok(()),
        Err(error) => {
            if let Ok(refs) = repository_refs(&root) {
                if refs
                    .branches
                    .iter()
                    .any(|branch| branch.full_name == full_name)
                {
                    return Err(CommandError::new(
                        "local_branch_already_exists",
                        format!("本地分支 {name} 已存在"),
                    ));
                }
                if local_branch_ref_path_conflicts(&refs, &full_name) {
                    return Err(CommandError::new(
                        "local_branch_name_conflict",
                        "分支名与现有引用的路径冲突，请使用其他分支名",
                    ));
                }
            }
            Err(error)
        }
    }
}

fn local_branch_ref_path_conflicts(refs: &RepositoryRefs, candidate: &str) -> bool {
    refs.branches
        .iter()
        .filter(|branch| matches!(branch.kind, BranchKind::Local))
        .any(|branch| ref_path_conflicts(&branch.full_name, candidate))
}

fn ref_path_conflicts(existing: &str, candidate: &str) -> bool {
    existing != candidate
        && (existing
            .strip_prefix(candidate)
            .is_some_and(|suffix| suffix.starts_with('/'))
            || candidate
                .strip_prefix(existing)
                .is_some_and(|suffix| suffix.starts_with('/')))
}

pub fn create_tracking_branch(path: &Path, remote_full_name: &str) -> Result<(), CommandError> {
    let remote_full_name = remote_full_name.trim();
    if remote_full_name.is_empty() || remote_full_name.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "invalid_remote_branch_selector",
            "要跟踪的远端分支标识无效",
        ));
    }
    if !remote_full_name.starts_with("refs/remotes/") {
        return Err(CommandError::new(
            "remote_branch_required",
            "只能从已读取的远端分支创建本地跟踪分支",
        ));
    }

    let root = repository_root(path)?;
    let refs = repository_refs(&root)?;
    let remote = refs
        .branches
        .iter()
        .find(|branch| branch.full_name == remote_full_name)
        .ok_or_else(|| {
            CommandError::new(
                "remote_branch_not_found",
                "该远端分支已不存在，请刷新后重试",
            )
        })?;
    if !matches!(remote.kind, BranchKind::Remote) {
        return Err(CommandError::new(
            "remote_branch_required",
            "只能从已读取的远端分支创建本地跟踪分支",
        ));
    }

    let local_name = remote
        .name
        .split_once('/')
        .map(|(_, branch)| branch)
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| {
            CommandError::new("invalid_remote_branch", "远端分支缺少可用的本地分支名")
        })?;
    validate_branch_name(&root, local_name)?;
    if refs
        .branches
        .iter()
        .any(|branch| matches!(branch.kind, BranchKind::Local) && branch.name == local_name)
    {
        return Err(CommandError::new(
            "local_branch_already_exists",
            format!("本地分支 {local_name} 已存在"),
        ));
    }

    let arguments = [
        OsString::from("switch"),
        OsString::from("--track"),
        OsString::from("-c"),
        OsString::from(local_name),
        OsString::from(remote_full_name),
    ];
    execute_write_os(&root, &arguments)
}

pub fn fetch_remote(
    path: &Path,
    remote_name: &str,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(FETCH_TIMEOUT);
    fetch_remote_before_deadline(
        path,
        remote_name,
        cancellation,
        progress,
        deadline,
        FETCH_CANCELLED_MESSAGE,
        FETCH_TIMEOUT_MESSAGE,
    )
}

fn fetch_remote_before_deadline(
    path: &Path,
    remote_name: &str,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
    deadline: OperationDeadline,
    cancellation_message: &'static str,
    timeout_message: &'static str,
) -> Result<(), CommandError> {
    let root = repository_root(path)?;
    let remote_name = remote_name.trim();
    if remote_name.is_empty()
        || remote_name.len() > MAX_REMOTE_NAME_BYTES
        || remote_name.starts_with('-')
    {
        return Err(CommandError::new(
            "invalid_remote_name",
            "要获取的远端名称无效",
        ));
    }
    let remotes = read_remotes(&root)?;
    if !remotes.iter().any(|remote| remote.name == remote_name) {
        return Err(CommandError::new(
            "remote_not_found",
            "该远端已不存在，请刷新后重试",
        ));
    }
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            cancellation_message,
        ));
    }

    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["fetch", "--progress", remote_name])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        cancellation_message,
        timeout_message,
        fetch_failure,
    )
}

/// Fetches the current branch's configured remote and advances it only when a
/// fast-forward is possible. This deliberately avoids merge/rebase behavior:
/// the first pull slice must never create a conflict state that the UI cannot
/// recover from yet.
pub fn pull_fast_forward(
    path: &Path,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    pull_fast_forward_with_timeout(path, cancellation, progress, PULL_TIMEOUT)
}

fn pull_fast_forward_with_timeout(
    path: &Path,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
    timeout: Duration,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(timeout);
    let root = repository_root(path)?;
    let refs = repository_refs(&root)?;
    let current = refs
        .branches
        .iter()
        .find(|branch| branch.current && matches!(branch.kind, BranchKind::Local))
        .ok_or_else(|| {
            CommandError::new(
                "pull_detached_head",
                "当前处于 detached HEAD，无法执行 Pull",
            )
        })?;
    let current_full_name = current.full_name.clone();
    let upstream = current
        .upstream
        .clone()
        .ok_or_else(|| CommandError::new("pull_no_upstream", "当前分支尚未配置远端上游"))?;
    let Some((remote_name, _)) = upstream.split_once('/') else {
        return Err(CommandError::new(
            "pull_upstream_unsupported",
            "当前上游不是远端跟踪分支，暂不支持 Pull",
        ));
    };
    if !refs.remotes.iter().any(|remote| remote.name == remote_name) {
        return Err(CommandError::new(
            "pull_upstream_missing",
            "当前分支的远端已不存在，请刷新分支与远端后重试",
        ));
    }
    let upstream_full_name = format!("refs/remotes/{upstream}");
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            PULL_CANCELLED_MESSAGE,
        ));
    }

    fetch_remote_before_deadline(
        &root,
        remote_name,
        Arc::clone(&cancellation),
        Arc::clone(&progress),
        deadline,
        PULL_CANCELLED_MESSAGE,
        PULL_TIMEOUT_MESSAGE,
    )?;

    let refreshed_refs = repository_refs(&root)?;
    let refreshed_current = refreshed_refs
        .branches
        .iter()
        .find(|branch| branch.current && matches!(branch.kind, BranchKind::Local))
        .ok_or_else(|| {
            CommandError::new(
                "pull_branch_changed",
                "Pull 期间当前分支发生变化，请刷新后重试",
            )
        })?;
    if refreshed_current.full_name != current_full_name
        || refreshed_current.upstream.as_deref() != Some(upstream.as_str())
    {
        return Err(CommandError::new(
            "pull_branch_changed",
            "Pull 期间当前分支或上游发生变化，请刷新后重试",
        ));
    }
    if refreshed_current.upstream_missing
        || !refreshed_refs.branches.iter().any(|branch| {
            branch.full_name == upstream_full_name && matches!(branch.kind, BranchKind::Remote)
        })
    {
        return Err(CommandError::new(
            "pull_upstream_missing",
            "远端 Fetch 完成后仍未找到当前分支的上游引用",
        ));
    }

    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            PULL_CANCELLED_MESSAGE,
        ));
    }

    progress(FetchProgress {
        phase: "fast_forward".to_owned(),
        percent: None,
        message: "正在仅快进当前分支".to_owned(),
    });

    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["merge", "--ff-only", "--no-edit"])
        .arg(&upstream_full_name)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_pull_merge_process(command, cancellation, progress, deadline)
}

/// Pushes the current local branch to its configured upstream without accepting
/// a remote, refspec, force flag, or other Git arguments from the UI.
pub fn push_current_branch(
    path: &Path,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    let refs = repository_refs(&root)?;
    let current = refs
        .branches
        .iter()
        .find(|branch| branch.current && matches!(branch.kind, BranchKind::Local))
        .ok_or_else(|| {
            CommandError::new(
                "push_detached_head",
                "当前处于 detached HEAD，无法执行 Push",
            )
        })?;
    let upstream = current
        .upstream
        .clone()
        .ok_or_else(|| CommandError::new("push_no_upstream", "当前分支尚未配置远端上游"))?;
    if current.upstream_missing {
        return Err(CommandError::new(
            "push_upstream_missing",
            "当前分支的远端上游已不存在，请先刷新并确认目标分支",
        ));
    }
    let Some((remote_name, remote_branch)) = upstream.split_once('/') else {
        return Err(CommandError::new(
            "push_upstream_unsupported",
            "当前上游不是远端跟踪分支，暂不支持 Push",
        ));
    };
    if remote_branch.is_empty() || remote_branch.len() > MAX_BRANCH_SELECTOR_BYTES {
        return Err(CommandError::new(
            "push_upstream_unsupported",
            "当前上游分支标识无效，暂不支持 Push",
        ));
    }
    if !refs.remotes.iter().any(|remote| remote.name == remote_name) {
        return Err(CommandError::new(
            "push_upstream_missing",
            "当前分支的远端已不存在，请刷新分支与远端后重试",
        ));
    }
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            PUSH_CANCELLED_MESSAGE,
        ));
    }

    progress(FetchProgress {
        phase: "pushing".to_owned(),
        percent: None,
        message: "正在推送当前分支到远端上游".to_owned(),
    });

    let refspec = format!("HEAD:refs/heads/{remote_branch}");
    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["push", "--progress", remote_name])
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        PUSH_CANCELLED_MESSAGE,
        PUSH_TIMEOUT_MESSAGE,
        push_failure,
    )
}

/// Publishes the current local branch as a new remote branch and configures it
/// as upstream. The empty force-with-lease expectation makes the remote write
/// create-only, including when another writer creates the target concurrently.
pub fn publish_current_branch(
    path: &Path,
    input: &PublishBranchInput,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    validate_oid(&input.expected_local_oid)?;
    let remote_name = validate_remote_name(&root, &input.remote_name)?;
    validate_branch_name(&root, &input.remote_branch_name)?;
    let refs = repository_refs(&root)?;
    let current = refs
        .branches
        .iter()
        .find(|branch| branch.current && matches!(branch.kind, BranchKind::Local))
        .ok_or_else(|| {
            CommandError::new(
                "push_detached_head",
                "当前处于 detached HEAD，无法发布远端分支",
            )
        })?;
    if current.upstream.is_some() {
        return Err(CommandError::new(
            "publish_upstream_exists",
            "当前分支已经配置远端上游，请使用普通 Push",
        ));
    }
    if current.full_name != input.local_full_name
        || current.oid != input.expected_local_oid.to_ascii_lowercase()
    {
        return Err(CommandError::new(
            "publish_local_branch_changed",
            "当前分支在确认后发生变化，请刷新后重试",
        ));
    }
    if !refs.remotes.iter().any(|remote| remote.name == remote_name) {
        return Err(CommandError::new(
            "remote_not_found",
            "目标远端已不存在，请刷新后重试",
        ));
    }
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            PUSH_CANCELLED_MESSAGE,
        ));
    }

    let (_, remote_url) = single_remote_push_url(&root, &remote_name)?;
    let remote_full_name = format!("refs/heads/{}", input.remote_branch_name);
    let mut inspect_command = git_command(Some(&root), GitLocking::Required);
    inspect_command
        .args(["ls-remote", "--refs", "--heads", "--"])
        .arg(&remote_url)
        .arg(&remote_full_name)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut inspect_command);
    let existing = run_network_output_process(
        inspect_command,
        Arc::clone(&cancellation),
        deadline,
        PUSH_CANCELLED_MESSAGE,
        PUSH_TIMEOUT_MESSAGE,
        fetch_failure,
    )?;
    if !existing.is_empty() {
        return Err(CommandError::new(
            "publish_remote_branch_exists",
            "远端分支已经存在，请更换名称或先创建本地跟踪分支",
        ));
    }

    progress(FetchProgress {
        phase: "publishing".to_owned(),
        percent: None,
        message: format!(
            "正在发布 {} 到 {remote_name}/{}",
            current.name, input.remote_branch_name
        ),
    });

    let lease = format!("--force-with-lease={remote_full_name}:");
    let refspec = format!("{}:{remote_full_name}", current.full_name);
    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["push", "--progress", "--set-upstream"])
        .arg(lease)
        .arg("--")
        .arg(&remote_name)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        PUSH_CANCELLED_MESSAGE,
        PUSH_TIMEOUT_MESSAGE,
        publish_branch_failure,
    )
}

/// Pushes the current local branch to one explicitly selected remote branch and
/// configures that target as upstream. Existing targets require an exact remote
/// OID snapshot and a verified fast-forward; new targets use an empty lease.
pub fn push_current_branch_to_target(
    path: &Path,
    input: &PushBranchTargetInput,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    validate_oid(&input.expected_local_oid)?;
    let expected_remote_oid = if let Some(oid) = input.expected_remote_oid.as_deref() {
        validate_oid(oid)?;
        Some(oid.to_ascii_lowercase())
    } else {
        None
    };
    let remote_name = validate_remote_name(&root, &input.remote_name)?;
    validate_branch_name(&root, &input.remote_branch_name)?;

    let refs = repository_refs(&root)?;
    let current = refs
        .branches
        .iter()
        .find(|branch| branch.current && matches!(branch.kind, BranchKind::Local))
        .ok_or_else(|| {
            CommandError::new(
                "push_detached_head",
                "当前处于 detached HEAD，无法推送当前分支",
            )
        })?;
    if current.full_name != input.local_full_name
        || current.oid != input.expected_local_oid.to_ascii_lowercase()
    {
        return Err(CommandError::new(
            "push_target_local_branch_changed",
            "当前分支在确认后发生变化，请重新选择推送目标",
        ));
    }
    if !refs.remotes.iter().any(|remote| remote.name == remote_name) {
        return Err(CommandError::new(
            "remote_not_found",
            "目标远端已不存在，请刷新后重试",
        ));
    }

    let remote_tracking_full_name =
        format!("refs/remotes/{remote_name}/{}", input.remote_branch_name);
    if let Some(expected_oid) = expected_remote_oid.as_deref() {
        let selected = refs
            .branches
            .iter()
            .find(|branch| {
                matches!(branch.kind, BranchKind::Remote)
                    && branch.full_name == remote_tracking_full_name
            })
            .ok_or_else(|| {
                CommandError::new(
                    "push_target_changed",
                    "所选远端分支已不在本地引用中，请 Fetch 后重新选择",
                )
            })?;
        if selected.oid != expected_oid {
            return Err(CommandError::new(
                "push_target_changed",
                "所选远端分支在确认后发生变化，请 Fetch 后重新选择",
            ));
        }
    }
    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            PUSH_CANCELLED_MESSAGE,
        ));
    }

    let (_, remote_url) = single_remote_push_url(&root, &remote_name)?;
    let remote_full_name = format!("refs/heads/{}", input.remote_branch_name);
    let mut inspect_command = git_command(Some(&root), GitLocking::Required);
    inspect_command
        .args(["ls-remote", "--refs", "--heads", "--"])
        .arg(&remote_url)
        .arg(&remote_full_name)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut inspect_command);
    let inspected = run_network_output_process(
        inspect_command,
        Arc::clone(&cancellation),
        deadline,
        PUSH_CANCELLED_MESSAGE,
        PUSH_TIMEOUT_MESSAGE,
        fetch_failure,
    )?;
    let actual_remote_oid = parse_optional_exact_remote_ref(&inspected, &remote_full_name)?;

    let lease = match (expected_remote_oid.as_deref(), actual_remote_oid.as_deref()) {
        (None, None) => format!("--force-with-lease={remote_full_name}:"),
        (None, Some(_)) => {
            return Err(CommandError::new(
                "push_target_exists",
                "目标远端分支已经存在，请改为选择现有分支或更换名称",
            ));
        }
        (Some(expected), Some(actual)) if expected == actual => {
            if !is_ancestor(&root, expected, &current.oid)? {
                return Err(CommandError::new(
                    "push_non_fast_forward",
                    "当前分支不包含所选远端分支的提交，安全 Push 不会覆盖远端历史",
                ));
            }
            format!("--force-with-lease={remote_full_name}:{expected}")
        }
        (Some(_), _) => {
            return Err(CommandError::new(
                "push_target_changed",
                "所选远端分支在确认后发生变化，请 Fetch 后重新选择",
            ));
        }
    };

    progress(FetchProgress {
        phase: "pushing".to_owned(),
        percent: None,
        message: format!(
            "正在推送 {} 到 {remote_name}/{}",
            current.name, input.remote_branch_name
        ),
    });

    let refspec = format!("{}:{remote_full_name}", current.full_name);
    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["push", "--progress", "--set-upstream"])
        .arg(lease)
        .arg("--")
        .arg(&remote_name)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        PUSH_CANCELLED_MESSAGE,
        PUSH_TIMEOUT_MESSAGE,
        push_target_failure,
    )
}

/// Publishes one previously-read local tag to one configured remote.
///
/// The UI cannot provide a URL, refspec, force mode, or extra Git flags. An
/// empty force-with-lease expectation makes this create-only for a different
/// remote value, while an already-identical remote tag remains an idempotent
/// success.
pub fn push_remote_tag(
    path: &Path,
    input: &RemoteTagPushInput,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    let tag = load_expected_local_tag(&root, &input.full_name, &input.expected_local_oid)?;
    let remote_name = validate_remote_name(&root, &input.remote_name)?;
    let remote_url = single_remote_push_url(&root, &remote_name)?.1;

    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            TAG_PUSH_CANCELLED_MESSAGE,
        ));
    }
    progress(FetchProgress {
        phase: "pushing_tag".to_owned(),
        percent: None,
        message: format!("正在发布标签 {} 到远端 {remote_name}", tag.name),
    });

    let lease = format!("--force-with-lease={}:", tag.full_name);
    let refspec = format!("{}:{}", tag.full_name, tag.full_name);
    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["-c", "push.followTags=false", "push", "--progress"])
        .arg(lease)
        .arg("--")
        .arg(remote_url)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        TAG_PUSH_CANCELLED_MESSAGE,
        TAG_PUSH_TIMEOUT_MESSAGE,
        remote_tag_push_failure,
    )
}

/// Reads one exact tag ref from a remote as a cancellable network operation.
/// The returned token binds the local selector, remote OID, and current push
/// destination so a later delete cannot silently target changed state.
pub fn preview_remote_tag_delete(
    path: &Path,
    input: &RemoteTagDeletePreviewInput,
    token_namespace: &Uuid,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<RemoteTagDeletePreview, CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    let tag = load_expected_local_tag(&root, &input.full_name, &input.expected_local_oid)?;
    let remote_name = validate_remote_name(&root, &input.remote_name)?;
    let (remote_snapshot, remote_url) = single_remote_push_url(&root, &remote_name)?;

    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            TAG_DELETE_PREVIEW_CANCELLED_MESSAGE,
        ));
    }
    progress(FetchProgress {
        phase: "reading_remote_tag".to_owned(),
        percent: None,
        message: format!("正在读取远端 {remote_name} 的标签 {}", tag.name),
    });

    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["ls-remote", "--refs", "--tags", "--"])
        .arg(&remote_url)
        .arg(&tag.full_name)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let output = run_network_output_process(
        command,
        cancellation,
        deadline,
        TAG_DELETE_PREVIEW_CANCELLED_MESSAGE,
        TAG_DELETE_PREVIEW_TIMEOUT_MESSAGE,
        fetch_failure,
    )?;
    let remote_oid = parse_exact_remote_tag(&output, &tag.full_name)?;
    let token = remote_tag_delete_token(
        token_namespace,
        &remote_snapshot,
        &tag.full_name,
        &tag.oid,
        &remote_oid,
    );
    Ok(RemoteTagDeletePreview {
        remote_name,
        name: tag.name.clone(),
        full_name: tag.full_name.clone(),
        local_oid: tag.oid.clone(),
        remote_oid,
        token,
    })
}

/// Deletes one exact remote tag only if the remote still contains the OID
/// observed during preview. The expected-OID lease is the final cross-process
/// compare-and-swap guard at the remote server.
pub fn delete_remote_tag(
    path: &Path,
    input: &RemoteTagDeleteInput,
    token_namespace: &Uuid,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> Result<(), CommandError> {
    let deadline = OperationDeadline::new(PUSH_TIMEOUT);
    let root = repository_root(path)?;
    let tag = load_expected_local_tag(&root, &input.full_name, &input.expected_local_oid)?;
    validate_remote_tag_oid(&input.expected_remote_oid)?;
    validate_remote_token(&input.expected_token)?;
    let remote_name = validate_remote_name(&root, &input.remote_name)?;
    let (remote_snapshot, remote_url) = single_remote_push_url(&root, &remote_name)?;
    let current_token = remote_tag_delete_token(
        token_namespace,
        &remote_snapshot,
        &tag.full_name,
        &tag.oid,
        &input.expected_remote_oid,
    );
    if current_token != input.expected_token {
        return Err(CommandError::new(
            "remote_tag_snapshot_changed",
            "本地标签或远端配置已变化，请重新读取远端标签后再删除",
        ));
    }

    if cancellation.load(Ordering::SeqCst) {
        return Err(CommandError::new(
            "git_operation_cancelled",
            TAG_DELETE_CANCELLED_MESSAGE,
        ));
    }
    progress(FetchProgress {
        phase: "deleting_remote_tag".to_owned(),
        percent: None,
        message: format!("正在从远端 {remote_name} 删除标签 {}", tag.name),
    });

    let lease = format!(
        "--force-with-lease={}:{}",
        tag.full_name, input.expected_remote_oid
    );
    let refspec = format!(":{}", tag.full_name);
    let mut command = git_command(Some(&root), GitLocking::Required);
    command
        .args(["-c", "push.followTags=false", "push", "--progress"])
        .arg(lease)
        .arg("--")
        .arg(remote_url)
        .arg(refspec)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        TAG_DELETE_CANCELLED_MESSAGE,
        TAG_DELETE_TIMEOUT_MESSAGE,
        remote_tag_delete_failure,
    )
}

pub fn commit_history(path: &Path, query: &HistoryQuery) -> Result<HistoryPage, CommandError> {
    if query.limit == 0 || query.limit > MAX_HISTORY_LIMIT {
        return Err(CommandError::new(
            "invalid_history_limit",
            format!("提交历史每次只能读取 1 到 {MAX_HISTORY_LIMIT} 条"),
        ));
    }

    if query.offset.checked_add(query.limit).is_none() {
        return Err(CommandError::new(
            "invalid_history_offset",
            "提交历史分页位置超出范围",
        ));
    }

    let search = validate_history_text_query(&query.search, "提交信息")?;
    let author = validate_history_text_query(&query.author, "作者")?;
    let after = query
        .after
        .as_deref()
        .map(|value| validate_history_date(value, "开始日期"))
        .transpose()?;
    let before = query
        .before
        .as_deref()
        .map(|value| validate_history_date(value, "结束日期"))
        .transpose()?;
    if let (Some(after), Some(before)) = (&after, &before) {
        if after > before {
            return Err(CommandError::new(
                "invalid_history_date_range",
                "开始日期不能晚于结束日期",
            ));
        }
    }
    let file_path = query
        .file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(file_path) = file_path {
        validate_pathspec(file_path)?;
    }

    let root = repository_root(path)?;
    let revision_oids = history_revision_oids(&root, query.ref_full_name.as_deref())?;
    if revision_oids.is_empty() {
        return Ok(HistoryPage {
            commits: Vec::new(),
            has_more: false,
            next_offset: query.offset,
        });
    }

    let requested_count = query.limit + 1;
    let mut arguments = vec![
        OsString::from("log"),
        OsString::from("-z"),
        OsString::from("--date=iso-strict"),
        OsString::from("--no-show-signature"),
        OsString::from("--topo-order"),
        OsString::from(format!("--max-count={requested_count}")),
        OsString::from(format!("--skip={}", query.offset)),
        OsString::from(format!("--format={HISTORY_FORMAT}")),
    ];
    if !search.is_empty() || !author.is_empty() {
        arguments.push(OsString::from("--regexp-ignore-case"));
        arguments.push(OsString::from("--fixed-strings"));
    }
    if !search.is_empty() {
        arguments.push(OsString::from(format!("--grep={search}")));
    }
    if !author.is_empty() {
        arguments.push(OsString::from(format!("--author={author}")));
    }
    if let Some(after) = &after {
        arguments.push(OsString::from(format!("--since={after}T00:00:00")));
    }
    if let Some(before) = &before {
        arguments.push(OsString::from(format!("--until={before}T23:59:59")));
    }
    arguments.extend(revision_oids.into_iter().map(OsString::from));
    arguments.push(OsString::from("--"));
    if let Some(file_path) = file_path {
        arguments.push(OsString::from(file_path));
    }

    let argument_refs = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    let output = execute_limited(Some(&root), &argument_refs, MAX_HISTORY_OUTPUT_BYTES)?;
    if output.truncated {
        return Err(CommandError::new(
            "history_output_too_large",
            "提交历史输出超过 4 MiB，请缩小筛选范围",
        ));
    }
    let mut commits = history_parser::parse_history(&output.stdout)?;
    if commits
        .iter()
        .any(|commit| commit.parent_oids.len() > MAX_HISTORY_PARENTS_PER_COMMIT)
    {
        return Err(CommandError::new(
            "history_parent_count_too_large",
            format!("单个提交最多支持显示 {MAX_HISTORY_PARENTS_PER_COMMIT} 个父提交"),
        ));
    }
    let has_more = commits.len() > query.limit as usize;
    if has_more {
        commits.truncate(query.limit as usize);
    }
    let next_offset = query
        .offset
        .checked_add(commits.len() as u32)
        .ok_or_else(|| CommandError::new("invalid_history_offset", "提交历史分页位置超出范围"))?;

    Ok(HistoryPage {
        commits,
        has_more,
        next_offset,
    })
}

fn history_revision_oids(
    repository: &Path,
    selected_ref: Option<&str>,
) -> Result<Vec<String>, CommandError> {
    if let Some(full_name) = selected_ref {
        return Ok(vec![resolve_history_ref(repository, full_name)?]);
    }
    if !head_exists(repository)? {
        return Ok(Vec::new());
    }

    let head_oid = exact_commit_oid(repository, "HEAD")?;
    let mut revisions = vec![head_oid.clone()];
    let upstream = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("@{upstream}^{commit}"),
        ],
    )?;
    if upstream.status.success() {
        let upstream_oid = String::from_utf8_lossy(&upstream.stdout)
            .trim()
            .to_ascii_lowercase();
        validate_oid(&upstream_oid)?;
        if upstream_oid != head_oid {
            revisions.push(upstream_oid);
        }
    }
    Ok(revisions)
}

fn resolve_history_ref(repository: &Path, full_name: &str) -> Result<String, CommandError> {
    let valid_namespace = ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .any(|prefix| full_name.starts_with(prefix));
    if !valid_namespace
        || full_name.is_empty()
        || full_name.len() > MAX_HISTORY_REF_BYTES
        || full_name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(CommandError::new(
            "invalid_history_ref",
            "历史范围只能选择本地分支、远端跟踪分支或标签的完整引用",
        ));
    }

    let format_check = execute_os_allow_failure(
        Some(repository),
        &[OsStr::new("check-ref-format"), OsStr::new(full_name)],
    )?;
    if !format_check.status.success() {
        return Err(CommandError::new(
            "invalid_history_ref",
            "历史范围引用不符合 Git 引用格式",
        ));
    }

    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("show-ref"),
            OsStr::new("--verify"),
            OsStr::new("--hash"),
            OsStr::new(full_name),
        ],
    )?;
    if !output.status.success() {
        return Err(CommandError::new(
            "history_ref_not_found",
            "所选历史引用已不存在，请刷新后重试",
        ));
    }

    let oid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    validate_oid(&oid)?;
    exact_commit_oid(repository, &oid)
        .map_err(|_| CommandError::new("history_ref_not_commit", "所选历史引用没有指向提交对象"))
}

fn validate_history_text_query<'a>(value: &'a str, label: &str) -> Result<&'a str, CommandError> {
    let value = value.trim();
    if value.chars().count() <= MAX_HISTORY_TEXT_QUERY_CHARS && !value.chars().any(char::is_control)
    {
        return Ok(value);
    }
    Err(CommandError::new(
        "invalid_history_query",
        format!("{label}筛选不能包含控制字符且不能超过 {MAX_HISTORY_TEXT_QUERY_CHARS} 个字符"),
    ))
}

fn validate_history_date<'a>(value: &'a str, label: &str) -> Result<&'a str, CommandError> {
    let value = value.trim();
    let bytes = value.as_bytes();
    let valid_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if !valid_shape {
        return Err(CommandError::new(
            "invalid_history_date",
            format!("{label}必须使用 YYYY-MM-DD 格式"),
        ));
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };
    if year > 0 && day > 0 && day <= days_in_month {
        return Ok(value);
    }
    Err(CommandError::new(
        "invalid_history_date",
        format!("{label}不是有效日期"),
    ))
}

pub fn commit_details(path: &Path, oid: &str) -> Result<CommitDetails, CommandError> {
    validate_oid(oid)?;
    let root = repository_root(path)?;
    let (commit, body) = commit_summary_and_body(&root, oid)?;

    let first_parent = commit.parent_oids.first().map(String::as_str);
    let file_output = if let Some(parent) = first_parent {
        execute_limited(
            Some(&root),
            &[
                OsStr::new("diff"),
                OsStr::new("--name-status"),
                OsStr::new("-z"),
                OsStr::new("-M"),
                OsStr::new(parent),
                OsStr::new(oid),
                OsStr::new("--"),
            ],
            MAX_COMMIT_DETAILS_OUTPUT_BYTES,
        )?
    } else {
        execute_limited(
            Some(&root),
            &[
                OsStr::new("diff-tree"),
                OsStr::new("--root"),
                OsStr::new("--no-commit-id"),
                OsStr::new("--name-status"),
                OsStr::new("-r"),
                OsStr::new("-z"),
                OsStr::new("-M"),
                OsStr::new(oid),
                OsStr::new("--"),
            ],
            MAX_COMMIT_DETAILS_OUTPUT_BYTES,
        )?
    };
    let files = parse_bounded_commit_files(file_output)?;

    let patch_output = if let Some(parent) = first_parent {
        execute_limited(
            Some(&root),
            &[
                OsStr::new("diff"),
                OsStr::new("--no-ext-diff"),
                OsStr::new("--no-color"),
                OsStr::new("--find-renames"),
                OsStr::new("--unified=3"),
                OsStr::new(parent),
                OsStr::new(oid),
                OsStr::new("--"),
            ],
            MAX_PATCH_BYTES,
        )?
    } else {
        execute_limited(
            Some(&root),
            &[
                OsStr::new("show"),
                OsStr::new("--format="),
                OsStr::new("--no-ext-diff"),
                OsStr::new("--no-color"),
                OsStr::new("--find-renames"),
                OsStr::new("--unified=3"),
                OsStr::new(oid),
                OsStr::new("--"),
            ],
            MAX_PATCH_BYTES,
        )?
    };

    Ok(CommitDetails {
        commit,
        body,
        files,
        patch: String::from_utf8_lossy(&patch_output.stdout).into_owned(),
        patch_truncated: patch_output.truncated,
    })
}

pub fn commit_image_diff(
    path: &Path,
    oid: &str,
    file_path: &str,
    original_path: Option<&str>,
) -> Result<Option<ImageDiff>, CommandError> {
    validate_oid(oid)?;
    validate_pathspec(file_path)?;
    if let Some(original_path) = original_path {
        validate_pathspec(original_path)?;
    }
    let root = repository_root(path)?;
    let (commit, _) = commit_summary_and_body(&root, oid)?;
    let old = commit
        .parent_oids
        .first()
        .map(|parent| read_git_blob_image(&root, parent, original_path.unwrap_or(file_path)))
        .transpose()?
        .flatten();
    let new = read_git_blob_image(&root, oid, file_path)?;
    Ok((old.is_some() || new.is_some()).then_some(ImageDiff {
        old,
        new,
        unsupported_reason: None,
    }))
}

pub fn worktree_diff(
    path: &Path,
    file_path: &str,
    staged: bool,
) -> Result<WorktreeDiff, CommandError> {
    validate_pathspec(file_path)?;
    let root = repository_root(path)?;
    let mut arguments = vec![
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
        OsString::from("--find-renames"),
        OsString::from("--unified=3"),
    ];
    if staged {
        arguments.push(OsString::from("--cached"));
    }

    arguments.push(OsString::from("--"));
    arguments.push(OsString::from(file_path));
    let argument_refs = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    let mut output = execute_limited(Some(&root), &argument_refs, MAX_PATCH_BYTES)?;

    if !staged && output.stdout.is_empty() && is_untracked(&root, file_path)? {
        let untracked_arguments = [
            OsStr::new("diff"),
            OsStr::new("--no-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
            OsStr::new("--unified=3"),
            OsStr::new("--"),
            OsStr::new(NULL_DEVICE),
            OsStr::new(file_path),
        ];
        output = execute_limited_allow_codes(
            Some(&root),
            &untracked_arguments,
            MAX_PATCH_BYTES,
            &[0, 1],
        )?;
    }

    Ok(WorktreeDiff {
        path: file_path.to_owned(),
        staged,
        patch: String::from_utf8_lossy(&output.stdout).into_owned(),
        patch_truncated: output.truncated,
        image: worktree_image_diff(&root, file_path, staged)?,
    })
}

fn worktree_image_diff(
    repository: &Path,
    file_path: &str,
    staged: bool,
) -> Result<Option<ImageDiff>, CommandError> {
    let old = if staged {
        match exact_commit_oid(repository, "HEAD") {
            Ok(head) => read_git_blob_image(repository, &head, file_path)?,
            Err(_) => None,
        }
    } else {
        read_git_blob_image(repository, ":", file_path)?
    };
    let new = if staged {
        read_git_blob_image(repository, ":", file_path)?
    } else {
        read_worktree_image(repository, file_path)?
    };
    Ok((old.is_some() || new.is_some()).then_some(ImageDiff {
        old,
        new,
        unsupported_reason: None,
    }))
}

fn read_git_blob_image(
    repository: &Path,
    revision: &str,
    file_path: &str,
) -> Result<Option<ImagePreview>, CommandError> {
    let object = if revision == ":" {
        format!(":{file_path}")
    } else {
        format!("{revision}:{file_path}")
    };
    let output = match execute_capped(
        Some(repository),
        &[
            OsStr::new("cat-file"),
            OsStr::new("blob"),
            OsStr::new(&object),
        ],
        MAX_IMAGE_BYTES,
        &[0],
        GitLocking::Optional,
        None,
    ) {
        Ok(output) => output,
        Err(_) => return Ok(None),
    };
    if output.truncated {
        if detect_image_mime(&output.stdout).is_none() {
            return Ok(None);
        }
        return Err(CommandError::new(
            "image_too_large",
            format!(
                "图片超过 {} MiB，无法在界面中预览",
                MAX_IMAGE_BYTES / 1024 / 1024
            ),
        ));
    }
    image_preview_from_bytes(&output.stdout)
}

fn read_worktree_image(
    repository: &Path,
    file_path: &str,
) -> Result<Option<ImagePreview>, CommandError> {
    let path = repository.join(file_path);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CommandError::from(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take((MAX_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_IMAGE_BYTES && detect_image_mime(&bytes).is_some() {
        return Err(CommandError::new(
            "image_too_large",
            format!(
                "图片超过 {} MiB，无法在界面中预览",
                MAX_IMAGE_BYTES / 1024 / 1024
            ),
        ));
    }
    image_preview_from_bytes(&bytes)
}

fn image_preview_from_bytes(bytes: &[u8]) -> Result<Option<ImagePreview>, CommandError> {
    let Some(mime_type) = detect_image_mime(bytes) else {
        return Ok(None);
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::new(
            "image_too_large",
            format!(
                "图片超过 {} MiB，无法在界面中预览",
                MAX_IMAGE_BYTES / 1024 / 1024
            ),
        ));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(ImagePreview {
        data_url: format!("data:{mime_type};base64,{encoded}"),
        mime_type: mime_type.to_owned(),
        byte_length: bytes.len() as u64,
    }))
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if std::str::from_utf8(bytes)
        .ok()
        .map(str::trim_start)
        .is_some_and(|text| text.starts_with("<svg") || text.starts_with("<?xml"))
    {
        Some("image/svg+xml")
    } else {
        None
    }
}

pub fn conflict_details(path: &Path, file_path: &str) -> Result<ConflictDetails, CommandError> {
    let root = repository_root(path)?;
    let snapshot = load_conflict_snapshot(&root, file_path)?;
    let current = read_conflict_side(&root, snapshot.current.as_ref())?;
    let incoming = read_conflict_side(&root, snapshot.incoming.as_ref())?;
    let is_binary = current.is_binary || incoming.is_binary;
    let content_truncated = current.content_truncated || incoming.content_truncated;
    let unsupported_reason = conflict_unsupported_reason(&snapshot).map(str::to_owned);

    Ok(ConflictDetails {
        path: snapshot.path,
        current: current.side,
        incoming: incoming.side,
        is_binary,
        content_truncated,
        resolvable: unsupported_reason.is_none(),
        unsupported_reason,
        token: snapshot.token,
    })
}

pub fn resolve_conflict(
    path: &Path,
    file_path: &str,
    input: &ConflictResolutionInput,
) -> Result<(), CommandError> {
    validate_pathspec(file_path)?;
    Uuid::parse_str(&input.expected_token).map_err(|_| {
        CommandError::new(
            "invalid_conflict_token",
            "冲突快照标识格式无效，请重新打开冲突文件",
        )
    })?;

    let root = repository_root(path)?;
    let snapshot = load_conflict_snapshot(&root, file_path)?;
    if snapshot.token != input.expected_token {
        return Err(CommandError::new(
            "conflict_snapshot_changed",
            "冲突文件已被外部修改，请重新打开后再解决",
        ));
    }
    if let Some(reason) = conflict_unsupported_reason(&snapshot) {
        return Err(CommandError::new("conflict_type_unsupported", reason));
    }

    let (stage_number, selected) = match input.choice {
        ConflictResolutionChoice::Current => (2, snapshot.current.as_ref()),
        ConflictResolutionChoice::Incoming => (3, snapshot.incoming.as_ref()),
    };

    if selected.is_some() {
        execute_write_os(
            &root,
            &[
                OsString::from("checkout-index"),
                OsString::from(format!("--stage={stage_number}")),
                OsString::from("--force"),
                OsString::from("--"),
                OsString::from(file_path),
            ],
        )
        .map_err(|_| {
            CommandError::new(
                "conflict_checkout_failed",
                "写入所选冲突版本失败，请重新打开冲突文件后重试",
            )
        })?;
        execute_write_os(
            &root,
            &[
                OsString::from("add"),
                OsString::from("--"),
                OsString::from(file_path),
            ],
        )
        .map_err(|_| {
            CommandError::new(
                "conflict_stage_failed",
                "标记冲突已解决失败，请刷新工作区后重试",
            )
        })?;
    } else {
        execute_write_os(
            &root,
            &[
                OsString::from("rm"),
                OsString::from("-f"),
                OsString::from("--ignore-unmatch"),
                OsString::from("--"),
                OsString::from(file_path),
            ],
        )
        .map_err(|_| {
            CommandError::new(
                "conflict_delete_failed",
                "采用删除版本失败，请重新打开冲突文件后重试",
            )
        })?;
    }
    Ok(())
}

#[derive(Debug)]
struct ConflictSidePreview {
    side: ConflictSide,
    is_binary: bool,
    content_truncated: bool,
}

fn load_conflict_snapshot(
    repository: &Path,
    file_path: &str,
) -> Result<ConflictSnapshot, CommandError> {
    validate_pathspec(file_path)?;
    let root = repository_root(repository)?;
    let current_status = status(&root)?;
    if !current_status
        .changes
        .iter()
        .any(|change| change.path == file_path && matches!(change.kind, ChangeKind::Unmerged))
    {
        return Err(CommandError::new(
            "conflict_not_found",
            "该文件已不再处于冲突状态，请刷新后重试",
        ));
    }

    let output = execute_limited(
        Some(&root),
        &[
            OsStr::new("ls-files"),
            OsStr::new("--unmerged"),
            OsStr::new("-z"),
            OsStr::new("--"),
            OsStr::new(file_path),
        ],
        MAX_CONFLICT_INDEX_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "conflict_index_too_large",
            "冲突索引记录超过允许的读取上限",
        ));
    }

    let (current, incoming) = parse_conflict_stages(&output.stdout, file_path)?;
    if current.is_none() && incoming.is_none() {
        return Err(CommandError::new(
            "conflict_not_found",
            "该文件已不再处于冲突状态，请刷新后重试",
        ));
    }

    let mut token_material = Vec::with_capacity(output.stdout.len() + 128);
    token_material.extend_from_slice(file_path.as_bytes());
    token_material.push(0);
    token_material.extend_from_slice(&output.stdout);
    token_material.push(0);
    token_material.extend_from_slice(&conflict_worktree_fingerprint(&root, file_path)?);
    let token = Uuid::new_v5(&Uuid::NAMESPACE_OID, &token_material).to_string();

    Ok(ConflictSnapshot {
        path: file_path.to_owned(),
        current,
        incoming,
        token,
    })
}

fn conflict_unsupported_reason(snapshot: &ConflictSnapshot) -> Option<&'static str> {
    snapshot
        .current
        .iter()
        .chain(snapshot.incoming.iter())
        .any(|stage| stage.mode == "160000")
        .then_some("暂不支持直接解决子模块冲突")
}

fn parse_conflict_stages(
    output: &[u8],
    expected_path: &str,
) -> Result<(Option<ConflictStage>, Option<ConflictStage>), CommandError> {
    let mut current = None;
    let mut incoming = None;

    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| CommandError::new("invalid_git_output", "Git 冲突索引记录格式无效"))?;
        let metadata = std::str::from_utf8(&record[..separator]).map_err(|_| {
            CommandError::new("invalid_git_output", "Git 冲突索引元数据不是有效文本")
        })?;
        if &record[separator + 1..] != expected_path.as_bytes() {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git 返回了非目标文件的冲突索引记录",
            ));
        }
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || fields[0].len() != 6
            || !fields[0].bytes().all(|byte| matches!(byte, b'0'..=b'7'))
            || !matches!(fields[1].len(), 40 | 64)
            || !fields[1].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git 冲突索引记录字段无效",
            ));
        }
        let stage = ConflictStage {
            mode: fields[0].to_owned(),
            oid: fields[1].to_owned(),
        };
        match fields[2] {
            "1" => {}
            "2" if current.is_none() => current = Some(stage),
            "3" if incoming.is_none() => incoming = Some(stage),
            "2" | "3" => {
                return Err(CommandError::new(
                    "invalid_git_output",
                    "Git 冲突索引包含重复版本记录",
                ));
            }
            _ => {
                return Err(CommandError::new(
                    "invalid_git_output",
                    "Git 冲突索引包含未知阶段",
                ));
            }
        }
    }

    Ok((current, incoming))
}

fn read_conflict_side(
    repository: &Path,
    stage: Option<&ConflictStage>,
) -> Result<ConflictSidePreview, CommandError> {
    let Some(stage) = stage else {
        return Ok(ConflictSidePreview {
            side: ConflictSide {
                exists: false,
                content: None,
            },
            is_binary: false,
            content_truncated: false,
        });
    };

    if stage.mode == "160000" {
        return Ok(ConflictSidePreview {
            side: ConflictSide {
                exists: true,
                content: None,
            },
            is_binary: false,
            content_truncated: false,
        });
    }

    let output = execute_limited(
        Some(repository),
        &[
            OsStr::new("cat-file"),
            OsStr::new("blob"),
            OsStr::new(&stage.oid),
        ],
        MAX_CONFLICT_PREVIEW_BYTES,
    )?;
    if output.truncated {
        return Ok(ConflictSidePreview {
            side: ConflictSide {
                exists: true,
                content: None,
            },
            is_binary: false,
            content_truncated: true,
        });
    }
    let is_binary = output.stdout.contains(&0);
    let content = if is_binary {
        None
    } else {
        std::str::from_utf8(&output.stdout).ok().map(str::to_owned)
    };
    let is_binary = is_binary || content.is_none();

    Ok(ConflictSidePreview {
        side: ConflictSide {
            exists: true,
            content,
        },
        is_binary,
        content_truncated: false,
    })
}

fn conflict_worktree_fingerprint(
    repository: &Path,
    file_path: &str,
) -> Result<Vec<u8>, CommandError> {
    let worktree_path = repository.join(file_path);
    let metadata = match fs::symlink_metadata(&worktree_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(b"missing".to_vec())
        }
        Err(error) => return Err(CommandError::from(error)),
    };

    if metadata.file_type().is_symlink() {
        let target = fs::read_link(&worktree_path)?;
        let mut fingerprint = b"symlink\0".to_vec();
        fingerprint.extend_from_slice(target.as_os_str().as_encoded_bytes());
        return Ok(fingerprint);
    }
    if metadata.is_dir() {
        return Ok(b"directory".to_vec());
    }
    if !metadata.is_file() {
        return Ok(b"special".to_vec());
    }

    let output = execute_limited(
        Some(repository),
        &[
            OsStr::new("hash-object"),
            OsStr::new("--no-filters"),
            OsStr::new("--"),
            OsStr::new(file_path),
        ],
        256,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git 工作区指纹输出超过预期长度",
        ));
    }
    let mut fingerprint = b"file\0".to_vec();
    fingerprint.extend_from_slice(output.stdout.trim_ascii());
    Ok(fingerprint)
}

pub fn stage(path: &Path, paths: &[String]) -> Result<(), CommandError> {
    let paths = validate_pathspecs(paths)?;
    reject_conflicted_paths(path, paths.iter().map(OsString::as_os_str))?;
    let mut arguments = vec![
        OsString::from("add"),
        OsString::from("-A"),
        OsString::from("--"),
    ];
    arguments.extend(paths);
    execute_write_os(path, &arguments)?;
    Ok(())
}

pub fn stage_all(path: &Path) -> Result<(), CommandError> {
    reject_any_conflict(path)?;
    execute_write(path, &["add", "-A"])?;
    Ok(())
}

pub fn unstage(path: &Path, paths: &[String]) -> Result<(), CommandError> {
    let paths = validate_pathspecs(paths)?;
    reject_conflicted_paths(path, paths.iter().map(OsString::as_os_str))?;
    let mut arguments = if head_exists(path)? {
        vec![
            OsString::from("restore"),
            OsString::from("--staged"),
            OsString::from("--"),
        ]
    } else {
        vec![
            OsString::from("rm"),
            OsString::from("--cached"),
            OsString::from("-r"),
            OsString::from("-f"),
            OsString::from("--"),
        ]
    };
    arguments.extend(paths);
    execute_write_os(path, &arguments)?;
    Ok(())
}

pub fn unstage_all(path: &Path) -> Result<(), CommandError> {
    reject_any_conflict(path)?;
    if head_exists(path)? {
        execute_write(path, &["restore", "--staged", "--", "."])?;
    } else {
        execute_write(path, &["rm", "--cached", "-r", "-f", "--", "."])?;
    }
    Ok(())
}

pub fn discard_files(path: &Path, file_paths: &[String]) -> Result<(), CommandError> {
    validate_pathspecs(file_paths)?;

    let mut requested_paths = HashSet::with_capacity(file_paths.len());
    for file_path in file_paths {
        if !requested_paths.insert(file_path.as_str()) {
            return Err(CommandError::new(
                "duplicate_repository_path",
                "批量放弃列表包含重复文件路径",
            ));
        }
    }

    let root = repository_root(path)?;
    let repository_status = status(&root)?;
    let mut restore_paths = Vec::new();
    let mut clean_paths = Vec::new();
    let mut restore_seen = HashSet::new();
    let mut clean_seen = HashSet::new();

    // Validate the complete request before changing the worktree. This prevents
    // an invalid later entry from causing an avoidable partial batch.
    for file_path in file_paths {
        let change = repository_status
            .changes
            .iter()
            .find(|change| change.path == *file_path)
            .ok_or_else(|| {
                CommandError::new(
                    "file_change_not_found",
                    format!("{file_path} 已不在未提交更改中，请刷新后重试"),
                )
            })?;

        if matches!(change.kind, ChangeKind::Unmerged) {
            return Err(CommandError::new(
                "conflict_discard_unsupported",
                format!("{file_path} 是冲突文件，不能直接放弃，请先解决冲突"),
            ));
        }

        if matches!(change.kind, ChangeKind::Untracked) {
            if clean_seen.insert(file_path.as_str()) {
                clean_paths.push(file_path.as_str());
            }
            continue;
        }

        if change.worktree_status.is_none() {
            return Err(CommandError::new(
                "unstaged_change_required",
                format!("{file_path} 没有可放弃的未暂存更改"),
            ));
        }

        if matches!(change.kind, ChangeKind::Renamed) && change.index_status.is_none() {
            let original_path = change.original_path.as_deref().ok_or_else(|| {
                CommandError::new(
                    "invalid_git_output",
                    "Git 重命名记录缺少原路径，未执行放弃操作",
                )
            })?;
            validate_pathspec(original_path)?;
            if restore_seen.insert(original_path) {
                restore_paths.push(original_path);
            }
            if clean_seen.insert(file_path.as_str()) {
                clean_paths.push(file_path.as_str());
            }
            continue;
        }

        if restore_seen.insert(file_path.as_str()) {
            restore_paths.push(file_path.as_str());
        }
    }

    if !restore_paths.is_empty() {
        restore_worktree_files(&root, &restore_paths)?;
    }
    if !clean_paths.is_empty() {
        clean_untracked_files(&root, &clean_paths)?;
    }
    Ok(())
}

pub fn create_commit(path: &Path, input: &CommitInput) -> Result<CommitSummary, CommandError> {
    let subject = input.subject.trim();
    let body = input.body.trim();
    validate_commit_message(subject, body)?;
    reject_any_conflict(path)?;
    if merge_in_progress(path)? {
        return Err(CommandError::new(
            "merge_recovery_required",
            "仓库正在合并，请使用专用的继续合并操作完成 merge commit",
        ));
    }
    if !has_staged_changes(path)? {
        return Err(CommandError::new(
            "nothing_to_commit",
            "没有已暂存的更改可提交",
        ));
    }

    let mut message = subject.to_owned();
    if !body.is_empty() {
        message.push_str("\n\n");
        message.push_str(body);
    }
    message.push('\n');
    execute_write_with_input(path, &["commit", "--file=-"], message.as_bytes())?;
    commit_summary(path, "HEAD")
}

pub fn preview_amend_commit(
    path: &Path,
    token_namespace: &Uuid,
) -> Result<AmendCommitPreview, CommandError> {
    let root = repository_root(path)?;
    let snapshot = amend_commit_snapshot(&root, token_namespace)?;
    Ok(AmendCommitPreview {
        current_branch: snapshot.current_branch,
        head_oid: snapshot.head_oid,
        current_subject: snapshot.current_subject,
        current_body: snapshot.current_body,
        staged_change_count: snapshot.staged_change_count,
        can_amend: snapshot.blocking_refs.is_empty(),
        blocking_refs: snapshot.blocking_refs,
        token: snapshot.token,
    })
}

pub fn amend_commit(
    path: &Path,
    input: &AmendCommitInput,
    token_namespace: &Uuid,
) -> Result<(String, CommitSummary), CommandError> {
    let root = repository_root(path)?;
    let subject = input.subject.trim();
    let body = input.body.trim();
    validate_commit_message(subject, body)?;
    validate_amend_commit_token(&input.expected_token)?;

    let snapshot = amend_commit_snapshot(&root, token_namespace)?;
    ensure_amend_snapshot_matches(&snapshot, &input.expected_token)?;
    ensure_amend_not_published(&snapshot)?;

    let verified = amend_commit_snapshot(&root, token_namespace)?;
    ensure_amend_snapshot_matches(&verified, &input.expected_token)?;
    ensure_amend_not_published(&verified)?;

    let tree_oid = write_index_tree(&root)?;
    ensure_amend_tree_matches(&verified, &tree_oid)?;
    // `write-tree` may race with another Git process outside this application's
    // repository queue. Re-read the complete preview snapshot after it, while
    // also requiring the produced tree to match the tree bound into the token.
    let finalized = amend_commit_snapshot(&root, token_namespace)?;
    ensure_amend_snapshot_matches(&finalized, &input.expected_token)?;
    ensure_amend_not_published(&finalized)?;
    ensure_amend_tree_matches(&finalized, &tree_oid)?;

    let mut message = subject.to_owned();
    if !body.is_empty() {
        message.push_str("\n\n");
        message.push_str(body);
    }
    message.push('\n');

    let new_oid = create_amended_commit_object(&root, &tree_oid, &finalized, message.as_bytes())?;
    update_amended_branch(&root, &finalized, &new_oid)?;
    Ok((finalized.head_oid, commit_summary(&root, &new_oid)?))
}

fn ensure_amend_snapshot_matches(
    snapshot: &AmendCommitSnapshot,
    expected_token: &str,
) -> Result<(), CommandError> {
    if snapshot.token == expected_token {
        return Ok(());
    }
    Err(CommandError::new(
        "amend_snapshot_changed",
        "HEAD、当前分支或暂存内容已发生变化，请重新预览后再修改提交",
    ))
}

fn ensure_amend_not_published(snapshot: &AmendCommitSnapshot) -> Result<(), CommandError> {
    if snapshot.blocking_refs.is_empty() {
        return Ok(());
    }
    Err(CommandError::new(
        "amend_head_is_published",
        "当前 HEAD 已被本地已知的远端引用或标签引用，安全修改已停止",
    ))
}

fn ensure_amend_tree_matches(
    snapshot: &AmendCommitSnapshot,
    tree_oid: &str,
) -> Result<(), CommandError> {
    if snapshot.index_tree_oid == tree_oid {
        return Ok(());
    }
    Err(CommandError::new(
        "amend_snapshot_changed",
        "HEAD、当前分支或暂存内容已发生变化，请重新预览后再修改提交",
    ))
}

fn reject_any_conflict(repository: &Path) -> Result<(), CommandError> {
    if has_unmerged_changes(&status(repository)?) {
        return Err(conflict_resolution_required());
    }
    Ok(())
}

fn reject_conflicted_paths<'a>(
    repository: &Path,
    paths: impl Iterator<Item = &'a OsStr>,
) -> Result<(), CommandError> {
    let requested = paths
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<HashSet<_>>();
    if status(repository)?.changes.iter().any(|change| {
        matches!(change.kind, ChangeKind::Unmerged) && requested.contains(&change.path)
    }) {
        return Err(conflict_resolution_required());
    }
    Ok(())
}

fn conflict_resolution_required() -> CommandError {
    CommandError::new(
        "conflict_resolution_required",
        "仓库存在未解决冲突，请先通过冲突解决流程处理",
    )
}

fn restore_worktree_files(repository: &Path, file_paths: &[&str]) -> Result<(), CommandError> {
    let mut arguments = vec![
        OsString::from("restore"),
        OsString::from("--worktree"),
        OsString::from("--"),
    ];
    arguments.extend(file_paths.iter().map(OsString::from));
    execute_write_os(repository, &arguments).map_err(|_| {
        CommandError::new(
            "discard_restore_failed",
            "恢复已跟踪文件失败，请刷新工作区后重试",
        )
    })
}

fn clean_untracked_files(repository: &Path, file_paths: &[&str]) -> Result<(), CommandError> {
    let mut arguments = vec![
        OsString::from("clean"),
        OsString::from("-f"),
        OsString::from("--"),
    ];
    arguments.extend(file_paths.iter().map(OsString::from));
    execute_write_os(repository, &arguments).map_err(|_| {
        CommandError::new(
            "discard_clean_failed",
            "删除未跟踪文件失败，请刷新工作区后重试",
        )
    })
}

impl RemoteSnapshot {
    fn remote_info(&self) -> RemoteInfo {
        RemoteInfo {
            name: self.name.clone(),
            fetch_url: sanitize_remote_url(&self.fetch_urls[0]),
            push_url: sanitize_remote_url(&self.effective_push_urls[0]),
            push_url_overridden: !self.explicit_push_urls.is_empty(),
        }
    }
}

fn read_remote_names(repository: &Path) -> Result<Vec<String>, CommandError> {
    let output = execute_limited(
        Some(repository),
        &[OsStr::new("remote")],
        MAX_REMOTE_OUTPUT_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "remote_list_too_large",
            "远端列表超过允许的读取上限",
        ));
    }

    let remote_names = String::from_utf8_lossy(&output.stdout);
    let mut names = remote_names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if names.len() > MAX_REMOTES {
        return Err(CommandError::new(
            "too_many_remotes",
            format!("单个仓库最多读取 {MAX_REMOTES} 个远端"),
        ));
    }

    names.sort();
    Ok(names)
}

fn read_remotes(repository: &Path) -> Result<Vec<RemoteInfo>, CommandError> {
    let names = read_remote_names(repository)?;
    let mut remotes = Vec::with_capacity(names.len());
    for name in names {
        let fetch_url = read_remote_url(repository, &name, false)?;
        let push_url = read_remote_url(repository, &name, true)?;
        let explicit_push_urls = read_remote_explicit_push_urls(repository, &name)?;
        remotes.push(RemoteInfo {
            name,
            fetch_url: sanitize_remote_url(&fetch_url),
            push_url: sanitize_remote_url(&push_url),
            push_url_overridden: !explicit_push_urls.is_empty(),
        });
    }
    Ok(remotes)
}

fn read_remote_url(
    repository: &Path,
    remote_name: &str,
    push: bool,
) -> Result<String, CommandError> {
    read_remote_urls(repository, remote_name, push).map(|urls| urls[0].clone())
}

fn read_remote_urls(
    repository: &Path,
    remote_name: &str,
    push: bool,
) -> Result<Vec<String>, CommandError> {
    let mut arguments = vec![OsStr::new("remote"), OsStr::new("get-url")];
    if push {
        arguments.push(OsStr::new("--push"));
    }
    arguments.push(OsStr::new("--all"));
    arguments.push(OsStr::new(remote_name));
    let output = execute_limited(Some(repository), &arguments, MAX_REMOTE_OUTPUT_BYTES)?;
    if output.truncated {
        return Err(CommandError::new(
            "remote_url_too_large",
            format!("远端 {remote_name} 的地址超过允许的读取上限"),
        ));
    }
    let urls = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if urls.is_empty() {
        Err(CommandError::new(
            "remote_url_missing",
            format!("远端 {remote_name} 没有可用地址"),
        ))
    } else {
        Ok(urls)
    }
}

fn read_remote_explicit_push_urls(
    repository: &Path,
    remote_name: &str,
) -> Result<Vec<String>, CommandError> {
    let key = format!("remote.{remote_name}.pushurl");
    let output = execute_limited_allow_codes(
        Some(repository),
        &[OsStr::new("config"), OsStr::new("--get-all"), key.as_ref()],
        MAX_REMOTE_OUTPUT_BYTES,
        &[0, 1],
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "remote_url_too_large",
            format!("远端 {remote_name} 的 Push 地址超过允许的读取上限"),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn load_remote_snapshot(
    repository: &Path,
    remote_name: &str,
    token_namespace: &Uuid,
) -> Result<RemoteSnapshot, CommandError> {
    if !read_remote_names(repository)?
        .iter()
        .any(|name| name == remote_name)
    {
        return Err(CommandError::new(
            "remote_not_found",
            "该远端已不存在，请刷新后重试",
        ));
    }
    let fetch_urls = read_remote_urls(repository, remote_name, false)?;
    let effective_push_urls = read_remote_urls(repository, remote_name, true)?;
    let explicit_push_urls = read_remote_explicit_push_urls(repository, remote_name)?;
    let upstream_prefix = format!("{remote_name}/");
    let mut affected_branches = repository_refs(repository)?
        .branches
        .into_iter()
        .filter(|branch| {
            matches!(branch.kind, BranchKind::Local)
                && branch
                    .upstream
                    .as_deref()
                    .is_some_and(|upstream| upstream.starts_with(&upstream_prefix))
        })
        .map(|branch| branch.name)
        .collect::<Vec<_>>();
    affected_branches.sort();

    let mut token_material = Vec::new();
    append_remote_token_values(&mut token_material, &[remote_name.to_owned()]);
    append_remote_token_values(&mut token_material, &fetch_urls);
    append_remote_token_values(&mut token_material, &effective_push_urls);
    append_remote_token_values(&mut token_material, &explicit_push_urls);
    append_remote_token_values(&mut token_material, &affected_branches);
    let token = Uuid::new_v5(token_namespace, &token_material).to_string();

    Ok(RemoteSnapshot {
        name: remote_name.to_owned(),
        fetch_urls,
        effective_push_urls,
        explicit_push_urls,
        affected_branches,
        token,
    })
}

fn append_remote_token_values(target: &mut Vec<u8>, values: &[String]) {
    target.extend_from_slice(values.len().to_string().as_bytes());
    target.push(0);
    for value in values {
        target.extend_from_slice(value.as_bytes());
        target.push(0);
    }
}

fn ensure_remote_is_editable(snapshot: &RemoteSnapshot) -> Result<(), CommandError> {
    if snapshot.fetch_urls.len() == 1
        && snapshot.effective_push_urls.len() == 1
        && snapshot.explicit_push_urls.len() <= 1
    {
        Ok(())
    } else {
        Err(CommandError::new(
            "remote_multiple_urls_unsupported",
            "该远端配置了多个 Fetch 或 Push 地址，请使用 Git 命令行管理",
        ))
    }
}

fn validate_remote_token(token: &str) -> Result<(), CommandError> {
    Uuid::parse_str(token)
        .map(|_| ())
        .map_err(|_| CommandError::new("invalid_remote_token", "远端配置确认令牌无效"))
}

fn load_expected_local_tag(
    repository: &Path,
    full_name: &str,
    expected_oid: &str,
) -> Result<TagInfo, CommandError> {
    if full_name.is_empty()
        || full_name.len() > MAX_BRANCH_SELECTOR_BYTES
        || !full_name.starts_with("refs/tags/")
    {
        return Err(CommandError::new(
            "local_tag_required",
            "只能操作已读取的本地标签",
        ));
    }
    validate_remote_tag_oid(expected_oid)?;
    let tag = repository_tags(repository)?
        .tags
        .into_iter()
        .find(|tag| tag.full_name == full_name)
        .ok_or_else(|| CommandError::new("tag_not_found", "该标签已不存在，请刷新后重试"))?;
    if !tag.oid.eq_ignore_ascii_case(expected_oid) {
        return Err(CommandError::new(
            "local_tag_changed",
            "本地标签已被移动或替换，请刷新后重试",
        ));
    }
    Ok(tag)
}

fn single_remote_push_url(
    repository: &Path,
    remote_name: &str,
) -> Result<(RemoteSnapshot, String), CommandError> {
    let snapshot = load_remote_snapshot(repository, remote_name, &Uuid::nil())?;
    if snapshot.effective_push_urls.len() != 1 || snapshot.explicit_push_urls.len() > 1 {
        return Err(CommandError::new(
            "remote_multiple_push_urls_unsupported",
            "该远端配置了多个 Push 地址，暂不支持此远端写操作",
        ));
    }
    let remote_url = validate_remote_url(&snapshot.effective_push_urls[0])?;
    Ok((snapshot, remote_url))
}

fn validate_remote_tag_oid(oid: &str) -> Result<(), CommandError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_remote_tag_oid",
            "标签对象标识格式无效",
        ))
    }
}

fn parse_exact_remote_tag(output: &[u8], full_name: &str) -> Result<String, CommandError> {
    let text = String::from_utf8_lossy(output);
    let mut matches = text.lines().filter(|line| !line.trim().is_empty());
    let Some(line) = matches.next() else {
        return Err(CommandError::new(
            "remote_tag_not_found",
            "该远端没有同名标签，无需删除",
        ));
    };
    if matches.next().is_some() {
        return Err(CommandError::new(
            "invalid_git_output",
            "远端标签查询返回了多个结果",
        ));
    }
    let Some((oid, reference)) = line.split_once('\t') else {
        return Err(CommandError::new(
            "invalid_git_output",
            "无法解析远端标签查询结果",
        ));
    };
    if reference != full_name {
        return Err(CommandError::new(
            "invalid_git_output",
            "远端标签查询返回了非预期引用",
        ));
    }
    validate_remote_tag_oid(oid)?;
    Ok(oid.to_ascii_lowercase())
}

fn parse_optional_exact_remote_ref(
    output: &[u8],
    full_name: &str,
) -> Result<Option<String>, CommandError> {
    let text = String::from_utf8_lossy(output);
    let mut matches = text.lines().filter(|line| !line.trim().is_empty());
    let Some(line) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(CommandError::new(
            "invalid_git_output",
            "远端引用查询返回了多个结果",
        ));
    }
    let Some((oid, reference)) = line.split_once('\t') else {
        return Err(CommandError::new(
            "invalid_git_output",
            "无法解析远端引用查询结果",
        ));
    };
    if reference != full_name {
        return Err(CommandError::new(
            "invalid_git_output",
            "远端引用查询返回了非预期结果",
        ));
    }
    validate_oid(oid)?;
    Ok(Some(oid.to_ascii_lowercase()))
}

fn remote_tag_delete_token(
    token_namespace: &Uuid,
    snapshot: &RemoteSnapshot,
    full_name: &str,
    local_oid: &str,
    remote_oid: &str,
) -> String {
    let mut token_material = Vec::new();
    append_remote_token_values(&mut token_material, std::slice::from_ref(&snapshot.name));
    append_remote_token_values(&mut token_material, &snapshot.effective_push_urls);
    append_remote_token_values(
        &mut token_material,
        &[
            full_name.to_owned(),
            local_oid.to_ascii_lowercase(),
            remote_oid.to_ascii_lowercase(),
        ],
    );
    Uuid::new_v5(token_namespace, &token_material).to_string()
}

fn validate_remote_name(repository: &Path, name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    let invalid = name.is_empty()
        || name.len() > MAX_REMOTE_NAME_BYTES
        || name.starts_with('-')
        || name.contains("..")
        || name
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || name.contains('/')
        || name.contains('\\');
    if invalid {
        return Err(CommandError::new(
            "invalid_remote_name",
            "远端名称不能为空，且不能包含空白、斜杠、连续点号或控制字符",
        ));
    }
    let candidate = format!("refs/remotes/{name}/placeholder");
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("check-ref-format"),
            OsStr::new(candidate.as_str()),
        ],
    )?;
    if output.status.success() {
        Ok(name.to_owned())
    } else {
        Err(CommandError::new(
            "invalid_remote_name",
            "远端名称不符合 Git 引用格式",
        ))
    }
}

fn validate_remote_url(value: &str) -> Result<String, CommandError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_REMOTE_URL_BYTES
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(CommandError::new("invalid_remote_url", "远端地址无效"));
    }

    if Path::new(value).is_absolute() {
        return Ok(value.to_owned());
    }

    if let Ok(url) = Url::parse(value) {
        if url.query().is_some() || url.fragment().is_some() || url.password().is_some() {
            return Err(CommandError::new(
                "invalid_remote_url",
                "远端地址不能包含查询参数、片段或密码",
            ));
        }
        if url.scheme() == "file" {
            if url
                .to_file_path()
                .ok()
                .is_some_and(|path| path.is_absolute())
            {
                return Ok(value.to_owned());
            }
            return Err(CommandError::new(
                "invalid_remote_url",
                "file:// 远端必须指向绝对路径",
            ));
        }
        if !matches!(url.scheme(), "https" | "ssh" | "git+ssh") || url.host_str().is_none() {
            return Err(CommandError::new(
                "unsupported_remote_url",
                "只支持 HTTPS、SSH、file:// 或本地绝对路径远端",
            ));
        }
        if url.scheme() == "https" && !url.username().is_empty() {
            return Err(CommandError::new(
                "remote_url_credentials_forbidden",
                "HTTPS 远端地址不能包含用户名或凭据",
            ));
        }
        reject_gitee_host(url.host_str().unwrap_or_default())?;
        return Ok(value.to_owned());
    }

    match validate_scp_like_clone_url(value) {
        Ok(()) => Ok(value.to_owned()),
        Err(error) if error.code == "gitee_not_supported" => Err(error),
        Err(_) => Err(CommandError::new(
            "invalid_remote_url",
            "远端地址必须是 HTTPS、SSH、user@host:path、file:// 或本地绝对路径",
        )),
    }
}

fn set_remote_fetch_url(
    repository: &Path,
    remote_name: &str,
    remote_url: &str,
) -> Result<(), CommandError> {
    execute_write_os(
        repository,
        &[
            OsString::from("remote"),
            OsString::from("set-url"),
            OsString::from(remote_name),
            OsString::from(remote_url),
        ],
    )
}

fn set_remote_push_url(
    repository: &Path,
    remote_name: &str,
    remote_url: &str,
) -> Result<(), CommandError> {
    execute_write_os(
        repository,
        &[
            OsString::from("remote"),
            OsString::from("set-url"),
            OsString::from("--push"),
            OsString::from(remote_name),
            OsString::from(remote_url),
        ],
    )
}

fn clear_remote_push_urls(repository: &Path, remote_name: &str) -> Result<(), CommandError> {
    let key = format!("remote.{remote_name}.pushurl");
    let arguments = [
        OsStr::new("config"),
        OsStr::new("--unset-all"),
        OsStr::new(key.as_str()),
    ];
    execute_capped(
        Some(repository),
        &arguments,
        MAX_STDERR_BYTES,
        &[0, 5],
        GitLocking::Required,
        None,
    )?;
    Ok(())
}

fn restore_remote_push_url(
    repository: &Path,
    remote_name: &str,
    remote_url: Option<&str>,
) -> Result<(), CommandError> {
    match remote_url {
        Some(remote_url) => set_remote_push_url(repository, remote_name, remote_url),
        None => clear_remote_push_urls(repository, remote_name),
    }
}

fn remove_remote(repository: &Path, remote_name: &str) -> Result<(), CommandError> {
    execute_write_os(
        repository,
        &[
            OsString::from("remote"),
            OsString::from("remove"),
            OsString::from(remote_name),
        ],
    )
}

fn sanitize_remote_url(value: &str) -> String {
    let without_query = value
        .split_once(['?', '#'])
        .map_or(value, |(prefix, _)| prefix);
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return without_query.to_owned();
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    let path = &remainder[authority_end..];
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    format!("{scheme}://{host}{path}")
}

fn validate_branch_name(repository: &Path, name: &str) -> Result<(), CommandError> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_BRANCH_NAME_BYTES {
        return Err(CommandError::new(
            "invalid_branch_name",
            "分支名不能为空且不能超过 255 字节",
        ));
    }
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("check-ref-format"),
            OsStr::new("--branch"),
            OsStr::new(name),
        ],
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_branch_name",
            "分支名不合法，请检查空格、连续点号或 Git 不允许的字符",
        ))
    }
}

fn execute(repository: Option<&Path>, arguments: &[&str]) -> Result<Output, CommandError> {
    let arguments = arguments.iter().map(OsStr::new).collect::<Vec<_>>();
    execute_os(repository, &arguments)
}

fn execute_os(repository: Option<&Path>, arguments: &[&OsStr]) -> Result<Output, CommandError> {
    let mut command = git_command(repository, GitLocking::Optional);
    command.args(arguments).stdin(Stdio::null());

    let output = command.output().map_err(|error| {
        CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}"))
    })?;

    ensure_success(output)
}

fn execute_write(repository: &Path, arguments: &[&str]) -> Result<(), CommandError> {
    let arguments = arguments.iter().map(OsStr::new).collect::<Vec<_>>();
    execute_capped(
        Some(repository),
        &arguments,
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        None,
    )?;
    Ok(())
}

fn execute_write_os(repository: &Path, arguments: &[OsString]) -> Result<(), CommandError> {
    let arguments = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    execute_capped(
        Some(repository),
        &arguments,
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        None,
    )?;
    Ok(())
}

fn execute_stash_write_os(repository: &Path, arguments: &[OsString]) -> Result<(), CommandError> {
    let arguments = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    execute_capped_with_pathspec_mode(
        Some(repository),
        &arguments,
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        None,
        false,
    )?;
    Ok(())
}

fn execute_write_with_input(
    repository: &Path,
    arguments: &[&str],
    input: &[u8],
) -> Result<(), CommandError> {
    let arguments = arguments.iter().map(OsStr::new).collect::<Vec<_>>();
    execute_capped(
        Some(repository),
        &arguments,
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        Some(input),
    )?;
    Ok(())
}

#[derive(Clone, Copy)]
enum GitLocking {
    Optional,
    Required,
}

fn git_command(repository: Option<&Path>, locking: GitLocking) -> Command {
    git_command_with_pathspec_mode(repository, locking, true)
}

fn git_command_with_pathspec_mode(
    repository: Option<&Path>,
    locking: GitLocking,
    literal_pathspecs: bool,
) -> Command {
    let mut command = Command::new("git");
    if matches!(locking, GitLocking::Optional) {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    command
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true");
    if let Some(repository) = repository {
        command.arg("-C").arg(repository);
    }
    command.arg("-c").arg("commit.gpgSign=false");
    if literal_pathspecs {
        command.arg("--literal-pathspecs");
    }
    command
}

fn ensure_success(output: Output) -> Result<Output, CommandError> {
    if output.status.success() {
        return Ok(output);
    }

    Err(git_failure(&output.stderr))
}

fn git_failure(_stderr: &[u8]) -> CommandError {
    CommandError::new(
        "git_command_failed",
        "Git 命令执行失败，请刷新仓库状态后重试",
    )
}

fn head_exists(repository: &Path) -> Result<bool, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("HEAD"),
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => ensure_success(output).map(|_| true),
    }
}

fn has_staged_changes(repository: &Path) -> Result<bool, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("diff"),
            OsStr::new("--cached"),
            OsStr::new("--quiet"),
            OsStr::new("--exit-code"),
            OsStr::new("--"),
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => ensure_success(output).map(|_| false),
    }
}

fn is_untracked(repository: &Path, file_path: &str) -> Result<bool, CommandError> {
    let output = execute_os(
        Some(repository),
        &[
            OsStr::new("ls-files"),
            OsStr::new("--others"),
            OsStr::new("--exclude-standard"),
            OsStr::new("-z"),
            OsStr::new("--"),
            OsStr::new(file_path),
        ],
    )?;
    Ok(!output.stdout.is_empty())
}

fn commit_summary(repository: &Path, revision: &str) -> Result<CommitSummary, CommandError> {
    commit_summary_and_body(repository, revision).map(|(summary, _)| summary)
}

fn commit_summary_and_body(
    repository: &Path,
    revision: &str,
) -> Result<(CommitSummary, String), CommandError> {
    let format = format!("--format={COMMIT_FORMAT}");
    let output = execute_limited(
        Some(repository),
        &[
            OsStr::new("show"),
            OsStr::new("-s"),
            OsStr::new("-z"),
            OsStr::new("--date=iso-strict"),
            OsStr::new("--no-show-signature"),
            format.as_ref(),
            OsStr::new(revision),
            OsStr::new("--"),
        ],
        MAX_COMMIT_DETAILS_OUTPUT_BYTES,
    )?;
    parse_bounded_commit_metadata(output)
}

fn parse_bounded_commit_metadata(
    output: LimitedOutput,
) -> Result<(CommitSummary, String), CommandError> {
    if output.truncated {
        return Err(CommandError::new(
            "commit_metadata_too_large",
            "提交消息和元数据超过允许的读取上限",
        ));
    }
    history_parser::parse_commit_metadata(&output.stdout)
}

fn parse_bounded_commit_files(
    output: LimitedOutput,
) -> Result<Vec<crate::domain::CommitFileChange>, CommandError> {
    if output.truncated {
        return Err(CommandError::new(
            "commit_file_list_too_large",
            "提交文件列表超过允许的读取上限",
        ));
    }
    let files = history_parser::parse_name_status(&output.stdout)?;
    if files.len() > MAX_COMMIT_FILES {
        return Err(CommandError::new(
            "too_many_commit_files",
            format!("单个提交最多读取 {MAX_COMMIT_FILES} 个变更文件"),
        ));
    }
    Ok(files)
}

fn execute_os_allow_failure(
    repository: Option<&Path>,
    arguments: &[&OsStr],
) -> Result<Output, CommandError> {
    let mut command = git_command(repository, GitLocking::Optional);
    command.args(arguments).stdin(Stdio::null());
    command
        .output()
        .map_err(|error| CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}")))
}

struct LimitedOutput {
    stdout: Vec<u8>,
    truncated: bool,
}

fn execute_limited(
    repository: Option<&Path>,
    arguments: &[&OsStr],
    stdout_limit: usize,
) -> Result<LimitedOutput, CommandError> {
    execute_limited_allow_codes(repository, arguments, stdout_limit, &[0])
}

fn execute_limited_allow_codes(
    repository: Option<&Path>,
    arguments: &[&OsStr],
    stdout_limit: usize,
    accepted_codes: &[i32],
) -> Result<LimitedOutput, CommandError> {
    execute_capped(
        repository,
        arguments,
        stdout_limit,
        accepted_codes,
        GitLocking::Optional,
        None,
    )
}

fn execute_capped(
    repository: Option<&Path>,
    arguments: &[&OsStr],
    stdout_limit: usize,
    accepted_codes: &[i32],
    locking: GitLocking,
    input: Option<&[u8]>,
) -> Result<LimitedOutput, CommandError> {
    execute_capped_with_pathspec_mode(
        repository,
        arguments,
        stdout_limit,
        accepted_codes,
        locking,
        input,
        true,
    )
}

fn execute_capped_with_pathspec_mode(
    repository: Option<&Path>,
    arguments: &[&OsStr],
    stdout_limit: usize,
    accepted_codes: &[i32],
    locking: GitLocking,
    input: Option<&[u8]>,
    literal_pathspecs: bool,
) -> Result<LimitedOutput, CommandError> {
    let mut command = git_command_with_pathspec_mode(repository, locking, literal_pathspecs);
    command.args(arguments);
    run_capped_command(command, stdout_limit, accepted_codes, input)
}

fn run_capped_command(
    command: Command,
    stdout_limit: usize,
    accepted_codes: &[i32],
    input: Option<&[u8]>,
) -> Result<LimitedOutput, CommandError> {
    run_capped_command_with_deadline(
        command,
        stdout_limit,
        accepted_codes,
        input,
        OperationDeadline::new(LOCAL_GIT_TIMEOUT),
    )
}

fn run_capped_command_with_deadline(
    mut command: Command,
    stdout_limit: usize,
    accepted_codes: &[i32],
    input: Option<&[u8]>,
    deadline: OperationDeadline,
) -> Result<LimitedOutput, CommandError> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}"))
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 标准输出",
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 错误输出",
            ));
        }
    };

    let stdout_reader = thread::spawn(move || read_capped(stdout, stdout_limit));
    let stderr_reader = thread::spawn(move || read_capped(stderr, MAX_STDERR_BYTES));
    if let Some(input) = input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| CommandError::new("git_input_failed", "无法写入 Git 标准输入"))?;
        if let Err(error) = stdin.write_all(input) {
            terminate_process_tree(&mut child);
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(CommandError::new(
                "git_input_failed",
                format!("无法写入 Git 标准输入：{error}"),
            ));
        }
    }

    let status = match wait_for_local_process(&mut child, deadline) {
        Ok(status) => status,
        Err(error) => {
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(error);
        }
    };
    let (stdout, truncated) = join_reader(stdout_reader)?;
    let (stderr, _) = join_reader(stderr_reader)?;
    if !status
        .code()
        .is_some_and(|code| accepted_codes.contains(&code))
    {
        return Err(git_failure(&stderr));
    }

    Ok(LimitedOutput { stdout, truncated })
}

fn wait_for_local_process(
    child: &mut Child,
    deadline: OperationDeadline,
) -> Result<ExitStatus, CommandError> {
    loop {
        if deadline.remaining_at(Instant::now()).is_none() {
            terminate_process_tree(child);
            return Err(CommandError::new(
                "git_operation_timed_out",
                LOCAL_GIT_TIMEOUT_MESSAGE,
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => thread::sleep(PROCESS_POLL_INTERVAL),
            Err(error) => {
                terminate_process_tree(child);
                return Err(CommandError::from(error));
            }
        }
    }
}

fn run_pull_merge_process(
    command: Command,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
    deadline: OperationDeadline,
) -> Result<(), CommandError> {
    run_network_process(
        command,
        cancellation,
        progress,
        deadline,
        PULL_CANCELLED_MESSAGE,
        PULL_TIMEOUT_MESSAGE,
        pull_failure,
    )
}

fn run_network_process(
    mut command: Command,
    cancellation: Arc<AtomicBool>,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
    deadline: OperationDeadline,
    cancellation_message: &'static str,
    timeout_message: &'static str,
    failure: fn(ExitStatus, &[u8]) -> CommandError,
) -> Result<(), CommandError> {
    let mut child = command.spawn().map_err(|error| {
        CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}"))
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 标准输出",
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 错误输出",
            ));
        }
    };

    let stdout_reader = thread::spawn(move || read_capped(stdout, MAX_STDERR_BYTES));
    let stderr_progress = Arc::clone(&progress);
    let stderr_reader =
        thread::spawn(move || read_fetch_stderr(stderr, MAX_STDERR_BYTES, stderr_progress));
    let status = loop {
        if cancellation.load(Ordering::SeqCst) {
            terminate_process_tree(&mut child);
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(CommandError::new(
                "git_operation_cancelled",
                cancellation_message,
            ));
        }
        if deadline.remaining_at(Instant::now()).is_none() {
            terminate_process_tree(&mut child);
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(CommandError::new(
                "git_operation_timed_out",
                timeout_message,
            ));
        }
        match child.try_wait().map_err(CommandError::from)? {
            Some(status) => break status,
            None => thread::sleep(PROCESS_POLL_INTERVAL),
        }
    };

    let _ = join_reader(stdout_reader)?;
    let (stderr, _) = join_reader(stderr_reader)?;
    if status.success() {
        Ok(())
    } else {
        Err(failure(status, &stderr))
    }
}

fn run_network_output_process(
    mut command: Command,
    cancellation: Arc<AtomicBool>,
    deadline: OperationDeadline,
    cancellation_message: &'static str,
    timeout_message: &'static str,
    failure: fn(ExitStatus, &[u8]) -> CommandError,
) -> Result<Vec<u8>, CommandError> {
    let mut child = command.spawn().map_err(|error| {
        CommandError::new("git_unavailable", format!("无法启动系统 Git：{error}"))
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 标准输出",
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_process_tree(&mut child);
            return Err(CommandError::new(
                "git_output_failed",
                "无法读取 Git 错误输出",
            ));
        }
    };

    let stdout_reader = thread::spawn(move || read_capped(stdout, MAX_REMOTE_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_capped_tail(stderr, MAX_STDERR_BYTES));
    let status = loop {
        if cancellation.load(Ordering::SeqCst) {
            terminate_process_tree(&mut child);
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(CommandError::new(
                "git_operation_cancelled",
                cancellation_message,
            ));
        }
        if deadline.remaining_at(Instant::now()).is_none() {
            terminate_process_tree(&mut child);
            let _ = join_reader(stdout_reader);
            let _ = join_reader(stderr_reader);
            return Err(CommandError::new(
                "git_operation_timed_out",
                timeout_message,
            ));
        }
        match child.try_wait().map_err(CommandError::from)? {
            Some(status) => break status,
            None => thread::sleep(PROCESS_POLL_INTERVAL),
        }
    };

    let (stdout, truncated) = join_reader(stdout_reader)?;
    let (stderr, _) = join_reader(stderr_reader)?;
    if !status.success() {
        return Err(failure(status, &stderr));
    }
    if truncated {
        return Err(CommandError::new(
            "remote_tag_output_too_large",
            "远端标签查询结果超过允许的读取上限",
        ));
    }
    Ok(stdout)
}

fn read_fetch_stderr(
    mut reader: impl Read,
    limit: usize,
    progress: Arc<dyn Fn(FetchProgress) + Send + Sync>,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut line = Vec::with_capacity(256);
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        truncated |= append_capped_tail(&mut output, &buffer[..count], limit);

        for byte in &buffer[..count] {
            if matches!(byte, b'\r' | b'\n') {
                emit_fetch_progress(&line, progress.as_ref());
                line.clear();
            } else if line.len() < 4096 {
                line.push(*byte);
            }
        }
    }
    emit_fetch_progress(&line, progress.as_ref());
    Ok((output, truncated))
}

fn emit_fetch_progress(line: &[u8], progress: &(dyn Fn(FetchProgress) + Send + Sync)) {
    let line = String::from_utf8_lossy(line);
    let trimmed = line.trim();
    let (phase, message) = if trimmed.starts_with("Cloning into") {
        ("preparing", "正在创建本地仓库")
    } else if trimmed.contains("Enumerating objects") {
        ("enumerating", "正在枚举远端对象")
    } else if trimmed.contains("Counting objects") {
        ("counting", "正在统计远端对象")
    } else if trimmed.contains("Compressing objects") {
        ("compressing", "正在压缩远端对象")
    } else if trimmed.contains("Receiving objects") {
        ("receiving", "正在接收远端对象")
    } else if trimmed.contains("Resolving deltas") {
        ("resolving", "正在解析增量")
    } else if trimmed.starts_with("From ") {
        ("updating_refs", "正在更新远端引用")
    } else {
        return;
    };
    progress(FetchProgress {
        phase: phase.to_owned(),
        percent: parse_progress_percent(trimmed),
        message: message.to_owned(),
    });
}

fn parse_progress_percent(line: &str) -> Option<u8> {
    let percent_index = line.find('%')?;
    let digits = line[..percent_index]
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    digits.parse::<u8>().ok().filter(|value| *value <= 100)
}

fn clone_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let shared = fetch_failure(status, stderr);
    if matches!(
        shared.code,
        "git_authentication_required" | "git_network_failed" | "git_remote_unavailable"
    ) {
        return shared;
    }
    CommandError::new(
        "git_clone_failed",
        status.code().map_or_else(
            || "克隆仓库失败".to_owned(),
            |code| format!("克隆仓库失败（Git 退出码 {code}）"),
        ),
    )
}

fn fetch_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if [
        "authentication failed",
        "could not read username",
        "terminal prompts disabled",
        "permission denied (publickey)",
        "authentication required",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
    {
        return CommandError::new(
            "git_authentication_required",
            "远端认证失败，请先在系统 Git 中配置可用凭据",
        );
    }
    if [
        "could not resolve host",
        "failed to connect",
        "network is unreachable",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
    {
        return CommandError::new("git_network_failed", "无法连接远端，请检查网络和远端地址");
    }
    if stderr.contains("repository not found")
        || stderr.contains("does not appear to be a git repository")
    {
        return CommandError::new("git_remote_unavailable", "远端仓库不存在或当前账号无权访问");
    }
    CommandError::new(
        "git_fetch_failed",
        status.code().map_or_else(
            || "获取远端更新失败".to_owned(),
            |code| format!("获取远端更新失败（Git 退出码 {code}）"),
        ),
    )
}

fn pull_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if stderr.contains("not possible to fast-forward")
        || stderr.contains("diverging branches can't be fast-forwarded")
        || stderr.contains("fatal: refusing to merge unrelated histories")
    {
        return CommandError::new(
            "pull_non_fast_forward",
            "本地分支与上游已经分叉，安全 Pull 不会自动合并或变基",
        );
    }
    if stderr.contains("would be overwritten by merge")
        || stderr.contains("your local changes to the following files would be overwritten")
        || stderr.contains("please commit your changes or stash them before you merge")
    {
        return CommandError::new(
            "pull_worktree_blocked",
            "工作区更改会被上游覆盖，请先提交、暂存处理或放弃相关更改",
        );
    }
    if stderr.contains("you have not concluded your merge")
        || stderr.contains("merging is not possible because you have unmerged files")
    {
        return CommandError::new(
            "pull_repository_conflict",
            "仓库正处于未完成的冲突状态，请先解决或中止现有操作",
        );
    }
    CommandError::new(
        "git_pull_failed",
        status.code().map_or_else(
            || "Pull 失败".to_owned(),
            |code| format!("Pull 失败（Git 退出码 {code}）"),
        ),
    )
}

fn push_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if [
        "authentication failed",
        "could not read username",
        "terminal prompts disabled",
        "permission denied (publickey)",
        "authentication required",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
    {
        return CommandError::new(
            "git_authentication_required",
            "远端认证失败，请先在系统 Git 中配置可用凭据",
        );
    }
    if [
        "could not resolve host",
        "failed to connect",
        "network is unreachable",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
    {
        return CommandError::new("git_network_failed", "无法连接远端，请检查网络和远端地址");
    }
    if stderr.contains("repository not found")
        || stderr.contains("does not appear to be a git repository")
    {
        return CommandError::new("git_remote_unavailable", "远端仓库不存在或当前账号无权访问");
    }
    if stderr.contains("non-fast-forward")
        || stderr.contains("fetch first")
        || stderr.contains("tip of your current branch is behind")
    {
        return CommandError::new(
            "push_non_fast_forward",
            "远端分支已有本地未包含的提交，请先 Fetch/Pull 后重试",
        );
    }
    if stderr.contains("remote rejected")
        || stderr.contains("hook declined")
        || stderr.contains("protected branch")
    {
        return CommandError::new(
            "push_rejected",
            "远端拒绝了 Push，请检查分支保护规则或提交检查",
        );
    }
    if stderr.contains("src refspec") && stderr.contains("does not match any") {
        return CommandError::new("push_no_commit", "当前分支没有可推送的提交");
    }
    CommandError::new(
        "git_push_failed",
        status.code().map_or_else(
            || "Push 失败".to_owned(),
            |code| format!("Push 失败（Git 退出码 {code}）"),
        ),
    )
}

fn publish_branch_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let normalized = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if normalized.contains("stale info")
        || normalized.contains("non-fast-forward")
        || normalized.contains("fetch first")
    {
        return CommandError::new(
            "publish_remote_branch_exists",
            "远端分支已经存在，请更换名称或先创建本地跟踪分支",
        );
    }
    push_failure(status, stderr)
}

fn push_target_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let normalized = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if normalized.contains("stale info") {
        return CommandError::new(
            "push_target_changed",
            "目标远端分支在推送前发生变化，安全 Push 已停止",
        );
    }
    push_failure(status, stderr)
}

fn remote_tag_push_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let normalized = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if normalized.contains("stale info")
        || normalized.contains("would clobber existing tag")
        || normalized.contains("already exists")
    {
        return CommandError::new(
            "remote_tag_already_exists",
            "远端已有不同的同名标签，安全发布不会覆盖它",
        );
    }
    let shared = push_failure(status, stderr);
    if shared.code == "git_push_failed" {
        CommandError::new(
            "remote_tag_push_failed",
            status.code().map_or_else(
                || "发布远端标签失败".to_owned(),
                |code| format!("发布远端标签失败（Git 退出码 {code}）"),
            ),
        )
    } else {
        shared
    }
}

fn remote_tag_delete_failure(status: ExitStatus, stderr: &[u8]) -> CommandError {
    let normalized = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if normalized.contains("stale info") || normalized.contains("remote ref does not exist") {
        return CommandError::new(
            "remote_tag_changed",
            "远端标签在确认后已变化或被删除，安全删除已停止",
        );
    }
    let shared = push_failure(status, stderr);
    if shared.code == "git_push_failed" {
        CommandError::new(
            "remote_tag_delete_failed",
            status.code().map_or_else(
                || "删除远端标签失败".to_owned(),
                |code| format!("删除远端标签失败（Git 退出码 {code}）"),
            ),
        )
    } else {
        shared
    }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) {
    let Ok(process_group) = i32::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    // SAFETY: the child was started in a new process group whose id equals its pid.
    let term_result = unsafe { libc::killpg(process_group, libc::SIGTERM) };
    if term_result != 0 {
        let _ = child.kill();
    }
    let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    // SAFETY: the process group id still refers to the isolated child process group.
    let _ = unsafe { libc::killpg(process_group, libc::SIGKILL) };
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_capped(mut reader: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        let kept = remaining.min(count);
        output.extend_from_slice(&buffer[..kept]);
        truncated |= kept < count;
    }
    Ok((output, truncated))
}

fn read_capped_tail(mut reader: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        truncated |= append_capped_tail(&mut output, &buffer[..count], limit);
    }
    Ok((output, truncated))
}

fn append_capped_tail(output: &mut Vec<u8>, chunk: &[u8], limit: usize) -> bool {
    if chunk.is_empty() {
        return false;
    }
    if limit == 0 {
        output.clear();
        return true;
    }

    let truncated = output.len().saturating_add(chunk.len()) > limit;
    if chunk.len() >= limit {
        output.clear();
        output.extend_from_slice(&chunk[chunk.len() - limit..]);
        return truncated;
    }

    let overflow = output
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(limit);
    if overflow > 0 {
        output.drain(..overflow);
    }
    output.extend_from_slice(chunk);
    truncated
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
) -> Result<(Vec<u8>, bool), CommandError> {
    reader
        .join()
        .map_err(|_| CommandError::new("git_output_failed", "Git 输出读取任务异常终止"))?
        .map_err(CommandError::from)
}

fn validate_pathspecs(paths: &[String]) -> Result<Vec<OsString>, CommandError> {
    if paths.is_empty() || paths.len() > MAX_PATHS_PER_OPERATION {
        return Err(CommandError::new(
            "invalid_repository_paths",
            format!("每次只能操作 1 到 {MAX_PATHS_PER_OPERATION} 个仓库路径"),
        ));
    }
    paths
        .iter()
        .map(|path| {
            validate_pathspec(path)?;
            Ok(OsString::from(path))
        })
        .collect()
}

fn validate_pathspec(path: &str) -> Result<(), CommandError> {
    let candidate = Path::new(path);
    let valid = !path.is_empty()
        && !path.starts_with(':')
        && !path.contains('\0')
        && path.len() <= 16 * 1024
        && !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        return Ok(());
    }
    Err(CommandError::new(
        "invalid_repository_pathspec",
        "仓库文件路径格式无效",
    ))
}

fn validate_commit_message(subject: &str, body: &str) -> Result<(), CommandError> {
    let valid = !subject.is_empty()
        && subject.chars().count() <= MAX_COMMIT_SUBJECT_CHARS
        && body.len() <= MAX_COMMIT_BODY_BYTES
        && !subject.contains('\0')
        && !body.contains('\0');
    if valid {
        return Ok(());
    }
    Err(CommandError::new(
        "invalid_commit_message",
        format!(
            "提交标题不能为空且不能超过 {MAX_COMMIT_SUBJECT_CHARS} 个字符，正文不能超过 {} KiB",
            MAX_COMMIT_BODY_BYTES / 1024
        ),
    ))
}

fn amend_commit_snapshot(
    repository: &Path,
    token_namespace: &Uuid,
) -> Result<AmendCommitSnapshot, CommandError> {
    ensure_amend_operation_idle(repository)?;
    let current_branch_ref = attached_head_ref(repository)?;
    let current_branch = current_branch_ref
        .strip_prefix("refs/heads/")
        .ok_or_else(|| {
            CommandError::new(
                "amend_local_branch_required",
                "只能修改当前 attached 本地分支的 HEAD 提交",
            )
        })?
        .to_owned();
    let head_oid = amend_head_oid(repository)?;
    let repository_status = status(repository)?;
    if has_unmerged_changes(&repository_status) {
        return Err(conflict_resolution_required());
    }
    if repository_status.branch.head.as_deref() != Some(current_branch.as_str()) {
        return Err(CommandError::new(
            "amend_branch_changed",
            "当前分支在预览期间发生变化，请刷新后重试",
        ));
    }

    let (commit, current_body) = commit_summary_and_body(repository, &head_oid)?;
    let staged_change_count = repository_status
        .changes
        .iter()
        .filter(|change| change.index_status.is_some())
        .count() as u64;
    let blocking_refs = amend_blocking_refs(repository, &head_oid)?;
    let index_snapshot = amend_command_snapshot(
        repository,
        &[
            OsStr::new("ls-files"),
            OsStr::new("--stage"),
            OsStr::new("-z"),
        ],
    )?;
    let staged_diff = amend_command_snapshot(
        repository,
        &[
            OsStr::new("diff"),
            OsStr::new("--cached"),
            OsStr::new("--binary"),
            OsStr::new("--full-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-color"),
            OsStr::new("--"),
        ],
    )?;
    let index_tree_oid = write_index_tree(repository)?;

    let mut token_material = Vec::new();
    append_token_bytes(&mut token_material, current_branch_ref.as_bytes());
    append_token_bytes(&mut token_material, head_oid.as_bytes());
    append_token_bytes(&mut token_material, commit.subject.as_bytes());
    append_token_bytes(&mut token_material, current_body.as_bytes());
    append_token_bytes(&mut token_material, commit.author_name.as_bytes());
    append_token_bytes(&mut token_material, commit.author_email.as_bytes());
    append_token_bytes(&mut token_material, commit.authored_at.as_bytes());
    for parent_oid in &commit.parent_oids {
        append_token_bytes(&mut token_material, parent_oid.as_bytes());
    }
    for reference in &blocking_refs {
        append_token_bytes(&mut token_material, reference.as_bytes());
    }
    append_token_bytes(&mut token_material, &index_snapshot);
    append_token_bytes(&mut token_material, &staged_diff);
    append_token_bytes(&mut token_material, index_tree_oid.as_bytes());

    Ok(AmendCommitSnapshot {
        current_branch,
        current_branch_ref,
        head_oid,
        current_subject: commit.subject,
        current_body,
        author_name: commit.author_name,
        author_email: commit.author_email,
        authored_at: commit.authored_at,
        parent_oids: commit.parent_oids,
        staged_change_count,
        blocking_refs,
        index_tree_oid,
        token: Uuid::new_v5(token_namespace, &token_material).to_string(),
    })
}

fn ensure_amend_operation_idle(repository: &Path) -> Result<(), CommandError> {
    const STATE_MARKERS: &[&str] = &[
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
    ];
    for marker in STATE_MARKERS {
        if fs::symlink_metadata(git_state_path(repository, marker)?).is_ok() {
            return Err(CommandError::new(
                "amend_operation_in_progress",
                "仓库存在尚未完成的 merge、rebase、cherry-pick 或 revert，不能修改 HEAD 提交",
            ));
        }
    }
    Ok(())
}

fn attached_head_ref(repository: &Path) -> Result<String, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("symbolic-ref"),
            OsStr::new("--quiet"),
            OsStr::new("HEAD"),
        ],
    )?;
    match output.status.code() {
        Some(0) => {
            let reference = String::from_utf8(output.stdout)
                .map_err(|_| CommandError::new("invalid_git_output", "当前分支名称不是 UTF-8"))?
                .trim()
                .to_owned();
            if reference.starts_with("refs/heads/") {
                Ok(reference)
            } else {
                Err(CommandError::new(
                    "amend_local_branch_required",
                    "只能修改当前 attached 本地分支的 HEAD 提交",
                ))
            }
        }
        Some(1) => Err(CommandError::new(
            "amend_detached_head",
            "Detached HEAD 不支持安全修改提交，请先切换到本地分支",
        )),
        _ => ensure_success(output).map(|_| unreachable!()),
    }
}

fn amend_head_oid(repository: &Path) -> Result<String, CommandError> {
    let output = execute_os_allow_failure(
        Some(repository),
        &[
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("HEAD^{commit}"),
        ],
    )?;
    match output.status.code() {
        Some(0) => {
            let oid = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_ascii_lowercase();
            validate_oid(&oid)?;
            Ok(oid)
        }
        Some(1) => Err(CommandError::new(
            "amend_no_head_commit",
            "当前分支还没有提交，无法执行 Amend",
        )),
        _ => ensure_success(output).map(|_| unreachable!()),
    }
}

fn amend_blocking_refs(repository: &Path, head_oid: &str) -> Result<Vec<String>, CommandError> {
    let mut references = read_refs_matching(
        repository,
        &format!("--contains={head_oid}"),
        "refs/remotes",
    )?;
    references.extend(read_refs_matching(
        repository,
        &format!("--points-at={head_oid}"),
        "refs/tags",
    )?);
    references.sort();
    references.dedup();
    Ok(references)
}

fn read_refs_matching(
    repository: &Path,
    predicate: &str,
    namespace: &str,
) -> Result<Vec<String>, CommandError> {
    let output = execute_limited(
        Some(repository),
        &[
            OsStr::new("for-each-ref"),
            OsStr::new("--format=%(refname)%00"),
            OsStr::new(predicate),
            OsStr::new(namespace),
        ],
        MAX_REFS_BYTES,
    )?;
    if output.truncated {
        return Err(CommandError::new(
            "amend_refs_too_large",
            "远端引用或标签数量超过安全读取上限，无法确认 Amend 边界",
        ));
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|value| {
            let value = value
                .iter()
                .copied()
                .skip_while(u8::is_ascii_whitespace)
                .collect::<Vec<_>>();
            (!value.is_empty()).then_some(value)
        })
        .map(|value| {
            std::str::from_utf8(&value)
                .map(str::to_owned)
                .map_err(|_| CommandError::new("invalid_git_output", "Git 引用名称不是 UTF-8"))
        })
        .collect()
}

fn amend_command_snapshot(
    repository: &Path,
    arguments: &[&OsStr],
) -> Result<Vec<u8>, CommandError> {
    let output = execute_limited(Some(repository), arguments, MAX_AMEND_SNAPSHOT_BYTES)?;
    if output.truncated {
        return Err(CommandError::new(
            "amend_snapshot_too_large",
            "暂存区快照超过安全读取上限，请使用系统 Git 完成 Amend",
        ));
    }
    Ok(output.stdout)
}

fn write_index_tree(repository: &Path) -> Result<String, CommandError> {
    let output = execute_capped(
        Some(repository),
        &[OsStr::new("write-tree")],
        MAX_STDERR_BYTES,
        &[0],
        GitLocking::Required,
        None,
    )?;
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    validate_oid(&oid)?;
    Ok(oid)
}

fn create_amended_commit_object(
    repository: &Path,
    tree_oid: &str,
    snapshot: &AmendCommitSnapshot,
    message: &[u8],
) -> Result<String, CommandError> {
    let mut command = git_command(Some(repository), GitLocking::Required);
    command
        .env("GIT_AUTHOR_NAME", &snapshot.author_name)
        .env("GIT_AUTHOR_EMAIL", &snapshot.author_email)
        .env("GIT_AUTHOR_DATE", &snapshot.authored_at)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("commit-tree")
        .arg(tree_oid);
    for parent_oid in &snapshot.parent_oids {
        command.arg("-p").arg(parent_oid);
    }
    let output = run_capped_command(command, MAX_STDERR_BYTES, &[0], Some(message))?;
    let oid = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    validate_oid(&oid)?;
    Ok(oid)
}

fn update_amended_branch(
    repository: &Path,
    snapshot: &AmendCommitSnapshot,
    new_oid: &str,
) -> Result<(), CommandError> {
    if attached_head_ref(repository)? != snapshot.current_branch_ref {
        return Err(CommandError::new(
            "amend_branch_changed",
            "当前分支已发生变化，替换提交已停止",
        ));
    }
    let result = execute_write_os(
        repository,
        &[
            OsString::from("update-ref"),
            OsString::from("-m"),
            OsString::from("commit (amend): git-knot safe amend"),
            OsString::from(&snapshot.current_branch_ref),
            OsString::from(new_oid),
            OsString::from(&snapshot.head_oid),
        ],
    );
    if result.is_ok() {
        return Ok(());
    }
    if exact_commit_oid(repository, &snapshot.current_branch_ref)
        .ok()
        .as_deref()
        != Some(snapshot.head_oid.as_str())
    {
        return Err(CommandError::new(
            "amend_head_changed",
            "当前分支 HEAD 已被其他 Git 进程移动，替换提交已停止",
        ));
    }
    Err(CommandError::new(
        "amend_update_failed",
        "新提交对象已创建，但无法安全替换当前分支引用；原 HEAD 未被应用修改",
    ))
}

fn validate_oid(oid: &str) -> Result<(), CommandError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(CommandError::new("invalid_commit_oid", "提交标识格式无效"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ChangeKind;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Cursor;
    use std::process::Command;
    use tempfile::tempdir;

    #[test]
    fn scans_git_repositories_recursively_and_skips_build_directories() {
        let directory = tempdir().unwrap();
        let direct = directory.path().join("alpha");
        let nested = directory.path().join("groups").join("beta");
        let ignored = directory.path().join("target").join("ignored");
        let inside_repository = direct.join("nested");

        for repository in [&direct, &nested, &ignored, &inside_repository] {
            fs::create_dir_all(repository.join(".git")).unwrap();
        }

        let repositories = scan_repositories(directory.path(), 4).unwrap();
        assert_eq!(
            repositories,
            vec![
                direct.canonicalize().unwrap(),
                nested.canonicalize().unwrap()
            ]
        );
    }

    #[test]
    fn scan_depth_limits_nested_repository_discovery() {
        let directory = tempdir().unwrap();
        let repository = directory.path().join("one").join("two").join("repo");
        fs::create_dir_all(repository.join(".git")).unwrap();

        assert!(scan_repositories(directory.path(), 1).unwrap().is_empty());
        assert_eq!(
            scan_repositories(directory.path(), 3).unwrap(),
            vec![repository.canonicalize().unwrap()]
        );
    }

    #[test]
    fn prepares_clone_targets_for_https_and_ssh_urls() {
        let directory = tempdir().unwrap();

        let https =
            prepare_clone("https://github.com/example/sample.git", directory.path()).unwrap();
        assert_eq!(https.repository_name, "sample");
        assert_eq!(
            https.target_directory,
            directory.path().canonicalize().unwrap().join("sample")
        );

        let ssh =
            prepare_clone("git@github.com:example/nested-repo.git", directory.path()).unwrap();
        assert_eq!(ssh.repository_name, "nested-repo");
        assert_eq!(
            ssh.target_directory,
            directory.path().canonicalize().unwrap().join("nested-repo")
        );
    }

    #[test]
    fn rejects_windows_reserved_or_trimmed_clone_directory_names() {
        let directory = tempdir().unwrap();
        for url in [
            "https://github.com/example/con.git",
            "https://github.com/example/NUL.txt.git",
            "git@github.com:example/com1.git",
            "git@github.com:example/LpT9.archive.git",
            "https://github.com/example/repository.",
            "git@github.com:example/repository .git",
        ] {
            let error = prepare_clone(url, directory.path()).unwrap_err();
            assert_eq!(
                error.code, "invalid_clone_repository_name",
                "unexpected result for {url}"
            );
        }

        for valid in ["console", "com0", "com10", "lpt0", "lpt10", "auxiliary"] {
            assert_eq!(
                clone_repository_name(&format!("git@github.com:example/{valid}.git")).unwrap(),
                valid
            );
        }
    }

    #[test]
    fn rejects_unsafe_or_unsupported_clone_urls() {
        let directory = tempdir().unwrap();
        for (url, expected_code) in [
            ("https://gitee.com/example/repo.git", "gitee_not_supported"),
            ("git@gitee.com:example/repo.git", "gitee_not_supported"),
            (
                "https://user:secret@github.com/example/repo.git",
                "unsupported_clone_url",
            ),
            (
                "https://github.com/example/repo.git?token=secret",
                "unsupported_clone_url",
            ),
            (
                "http://github.com/example/repo.git",
                "unsupported_clone_url",
            ),
            ("/tmp/local-repository", "unsupported_clone_url"),
        ] {
            let error = prepare_clone(url, directory.path()).unwrap_err();
            assert_eq!(error.code, expected_code, "unexpected result for {url}");
        }
    }

    #[test]
    fn reads_and_safely_locks_linked_worktrees() {
        let directory = tempdir().unwrap();
        let repository = directory.path().join("repository");
        let linked_path = directory.path().join("topic-worktree");
        fs::create_dir(&repository).unwrap();
        initialize_repository(&repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(&repository, &["add", "base.txt"]);
        run_git(&repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(&repository, &["branch", "topic"]);
        run_git(
            &repository,
            &[
                "worktree",
                "add",
                "--quiet",
                linked_path.to_str().unwrap(),
                "topic",
            ],
        );
        assert_eq!(
            repository_write_key(&repository).unwrap(),
            repository_write_key(&linked_path).unwrap()
        );

        let namespace = Uuid::new_v4();
        let initial = repository_worktrees(&repository, &namespace).unwrap();
        assert_eq!(initial.worktrees.len(), 2);
        assert!(initial.worktrees[0].is_main);
        assert_eq!(
            initial.worktrees[0].branch_full_name.as_deref(),
            status(&repository)
                .unwrap()
                .branch
                .head
                .as_deref()
                .map(|name| format!("refs/heads/{name}"))
                .as_deref()
        );
        let linked = initial
            .worktrees
            .iter()
            .find(|worktree| !worktree.is_main)
            .unwrap();
        assert_eq!(
            linked.path,
            linked_path.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(linked.branch.as_deref(), Some("topic"));
        assert!(!linked.locked);
        Uuid::parse_str(&linked.token).unwrap();
        let initial_linked_token = linked.token.clone();

        let main_error = lock_worktree(
            &repository,
            &WorktreeLockInput {
                worktree_path: initial.worktrees[0].path.clone(),
                expected_token: initial.worktrees[0].token.clone(),
                reason: None,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(main_error.code, "main_worktree_immutable");

        let invalid_token = lock_worktree(
            &repository,
            &WorktreeLockInput {
                worktree_path: linked.path.clone(),
                expected_token: "not-a-uuid".to_owned(),
                reason: None,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(invalid_token.code, "invalid_worktree_token");

        let missing = lock_worktree(
            &repository,
            &WorktreeLockInput {
                worktree_path: directory
                    .path()
                    .join("missing")
                    .to_string_lossy()
                    .into_owned(),
                expected_token: Uuid::new_v4().to_string(),
                reason: None,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(missing.code, "worktree_not_found");

        for reason in ["invalid\nreason".to_owned(), "x".repeat(257)] {
            let error = lock_worktree(
                &repository,
                &WorktreeLockInput {
                    worktree_path: linked.path.clone(),
                    expected_token: linked.token.clone(),
                    reason: Some(reason),
                },
                &namespace,
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid_worktree_lock_reason");
        }

        lock_worktree(
            &repository,
            &WorktreeLockInput {
                worktree_path: linked.path.clone(),
                expected_token: linked.token.clone(),
                reason: Some("--expire=now release validation".to_owned()),
            },
            &namespace,
        )
        .unwrap();
        let locked = repository_worktrees(&repository, &namespace).unwrap();
        let locked_linked = locked
            .worktrees
            .iter()
            .find(|worktree| !worktree.is_main)
            .unwrap();
        assert!(locked_linked.locked);
        assert_eq!(
            locked_linked.lock_reason.as_deref(),
            Some("--expire=now release validation")
        );
        assert_ne!(locked_linked.token, initial_linked_token);

        let stale = unlock_worktree(
            &repository,
            &WorktreeUnlockInput {
                worktree_path: linked.path.clone(),
                expected_token: initial_linked_token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(stale.code, "worktree_snapshot_changed");

        unlock_worktree(
            &repository,
            &WorktreeUnlockInput {
                worktree_path: locked_linked.path.clone(),
                expected_token: locked_linked.token.clone(),
            },
            &namespace,
        )
        .unwrap();
        let unlocked = repository_worktrees(&repository, &namespace).unwrap();
        assert!(
            !unlocked
                .worktrees
                .iter()
                .find(|worktree| !worktree.is_main)
                .unwrap()
                .locked
        );
    }

    #[test]
    fn creates_linked_worktrees_only_from_current_safe_candidates() {
        let directory = tempdir().unwrap();
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).unwrap();
        initialize_repository(&repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(&repository, &["add", "base.txt"]);
        run_git(&repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(&repository, &["branch", "topic/safe-create"]);
        run_git(&repository, &["branch", "occupied-target"]);

        let namespace = Uuid::new_v4();
        let initial = repository_worktrees(&repository, &namespace).unwrap();
        assert!(initial
            .create_candidates
            .iter()
            .all(|candidate| candidate.branch_full_name != "refs/heads/main"));
        let stale_candidate = initial
            .create_candidates
            .iter()
            .find(|candidate| candidate.branch_full_name == "refs/heads/topic/safe-create")
            .unwrap()
            .clone();
        assert!(stale_candidate.target_path.contains(".git-knot-worktrees"));

        fs::write(repository.join("next.txt"), "next\n").unwrap();
        run_git(&repository, &["add", "next.txt"]);
        run_git(&repository, &["commit", "--quiet", "-m", "Next"]);
        run_git(&repository, &["branch", "-f", "topic/safe-create", "HEAD"]);

        let stale = create_linked_worktree(
            &repository,
            &WorktreeCreateInput {
                branch_full_name: stale_candidate.branch_full_name.clone(),
                expected_token: stale_candidate.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(stale.code, "worktree_create_snapshot_changed");

        let refreshed = repository_worktrees(&repository, &namespace).unwrap();
        let candidate = refreshed
            .create_candidates
            .iter()
            .find(|candidate| candidate.branch_full_name == "refs/heads/topic/safe-create")
            .unwrap()
            .clone();
        create_linked_worktree(
            &repository,
            &WorktreeCreateInput {
                branch_full_name: candidate.branch_full_name.clone(),
                expected_token: candidate.token.clone(),
            },
            &namespace,
        )
        .unwrap();

        let created = repository_worktrees(&repository, &namespace).unwrap();
        let linked = created
            .worktrees
            .iter()
            .find(|worktree| worktree.path == candidate.target_path)
            .unwrap();
        assert_eq!(
            linked.branch_full_name.as_deref(),
            Some("refs/heads/topic/safe-create")
        );
        assert!(Path::new(&linked.path).join("next.txt").is_file());
        assert!(created
            .create_candidates
            .iter()
            .all(|item| item.branch_full_name != candidate.branch_full_name));

        let already_checked_out = create_linked_worktree(
            &repository,
            &WorktreeCreateInput {
                branch_full_name: candidate.branch_full_name,
                expected_token: candidate.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(already_checked_out.code, "worktree_create_unavailable");

        let occupied = created
            .create_candidates
            .iter()
            .find(|candidate| candidate.branch_full_name == "refs/heads/occupied-target")
            .unwrap()
            .clone();
        fs::create_dir_all(&occupied.target_path).unwrap();
        let collision = create_linked_worktree(
            &repository,
            &WorktreeCreateInput {
                branch_full_name: occupied.branch_full_name,
                expected_token: occupied.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(collision.code, "worktree_create_unavailable");
    }

    #[test]
    fn prunes_only_stale_worktree_records_after_snapshot_confirmation() {
        let directory = tempdir().unwrap();
        let repository = directory.path().join("repository");
        let linked_path = directory.path().join("topic-worktree");
        fs::create_dir(&repository).unwrap();
        initialize_repository(&repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(&repository, &["add", "base.txt"]);
        run_git(&repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(&repository, &["branch", "topic"]);
        run_git(
            &repository,
            &[
                "worktree",
                "add",
                "--quiet",
                linked_path.to_str().unwrap(),
                "topic",
            ],
        );

        // Simulate a stale administrative record. The checkout directory is
        // already gone, while the repository's worktree metadata remains.
        fs::remove_dir_all(&linked_path).unwrap();

        let namespace = Uuid::new_v4();
        let snapshot = repository_worktrees(&repository, &namespace).unwrap();
        assert_eq!(
            snapshot
                .worktrees
                .iter()
                .filter(|item| item.prunable)
                .count(),
            1
        );
        let stale = WorktreePruneInput {
            expected_token: snapshot.prune_token.clone(),
        };
        let stale_error = prune_worktrees(
            &repository,
            &WorktreePruneInput {
                expected_token: Uuid::new_v4().to_string(),
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(stale_error.code, "worktree_snapshot_changed");

        prune_worktrees(&repository, &stale, &namespace).unwrap();
        let after = repository_worktrees(&repository, &namespace).unwrap();
        assert_eq!(after.worktrees.len(), 1);
        assert!(after.worktrees[0].is_main);
        assert!(!linked_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_worktree_storage_roots() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let repository = directory.path().join("repository");
        let outside = directory.path().join("outside");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(&outside).unwrap();
        initialize_repository(&repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(&repository, &["add", "base.txt"]);
        run_git(&repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(&repository, &["branch", "topic"]);

        let namespace = Uuid::new_v4();
        let candidate = repository_worktrees(&repository, &namespace)
            .unwrap()
            .create_candidates
            .into_iter()
            .find(|candidate| candidate.branch_full_name == "refs/heads/topic")
            .unwrap();
        symlink(&outside, directory.path().join(".git-knot-worktrees")).unwrap();

        let error = create_linked_worktree(
            &repository,
            &WorktreeCreateInput {
                branch_full_name: candidate.branch_full_name,
                expected_token: candidate.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(error.code, "unsafe_worktree_storage");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn worktree_tokens_distinguish_missing_and_empty_marker_reasons() {
        let namespace = Uuid::new_v4();
        let base = worktrees_parser::ParsedWorktree {
            path: "/tmp/repository".to_owned(),
            head_oid: "a".repeat(40),
            branch_full_name: Some("refs/heads/main".to_owned()),
            detached: false,
            bare: false,
            lock_reason: None,
            prunable_reason: None,
            is_main: false,
        };
        let mut locked = base.clone();
        locked.lock_reason = Some(String::new());
        let mut prunable = base.clone();
        prunable.prunable_reason = Some(String::new());

        let base_token = worktree_info(base, &namespace).token;
        assert_ne!(base_token, worktree_info(locked, &namespace).token);
        assert_ne!(base_token, worktree_info(prunable, &namespace).token);
    }

    #[test]
    fn creates_updates_and_reads_safe_remote_configuration() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        let namespace = Uuid::new_v4();

        create_remote(
            repository,
            &RemoteCreateInput {
                name: "origin".to_owned(),
                fetch_url: "https://github.com/example/repository.git".to_owned(),
                push_url: Some("git@github.com:example/repository.git".to_owned()),
            },
        )
        .unwrap();

        let refs = repository_refs(repository).unwrap();
        assert_eq!(refs.remotes.len(), 1);
        assert_eq!(refs.remotes[0].name, "origin");
        assert_eq!(
            refs.remotes[0].fetch_url,
            "https://github.com/example/repository.git"
        );
        assert_eq!(
            refs.remotes[0].push_url,
            "git@github.com:example/repository.git"
        );
        assert!(refs.remotes[0].push_url_overridden);

        let preview = preview_remote_edit(repository, "origin", &namespace).unwrap();
        update_remote(
            repository,
            &RemoteUpdateInput {
                name: "origin".to_owned(),
                expected_token: preview.token,
                new_fetch_url: Some("https://gitlab.com/example/repository.git".to_owned()),
                new_push_url: None,
                reset_push_url: true,
            },
            &namespace,
        )
        .unwrap();

        let remote = repository_refs(repository).unwrap().remotes.remove(0);
        assert_eq!(
            remote.fetch_url,
            "https://gitlab.com/example/repository.git"
        );
        assert_eq!(remote.push_url, remote.fetch_url);
        assert!(!remote.push_url_overridden);
    }

    #[test]
    fn rejects_unsafe_remote_inputs_and_stale_edit_tokens() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        let namespace = Uuid::new_v4();

        for (name, url, expected_code) in [
            (
                "bad/name",
                "https://github.com/example/repository.git",
                "invalid_remote_name",
            ),
            (
                "origin",
                "https://token@github.com/example/repository.git",
                "remote_url_credentials_forbidden",
            ),
            (
                "origin",
                "git@gitee.com:example/repository.git",
                "gitee_not_supported",
            ),
            ("origin", "../relative/repository.git", "invalid_remote_url"),
        ] {
            let error = create_remote(
                repository,
                &RemoteCreateInput {
                    name: name.to_owned(),
                    fetch_url: url.to_owned(),
                    push_url: None,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, expected_code);
        }

        create_remote(
            repository,
            &RemoteCreateInput {
                name: "origin".to_owned(),
                fetch_url: "https://github.com/example/repository.git".to_owned(),
                push_url: None,
            },
        )
        .unwrap();
        let preview = preview_remote_edit(repository, "origin", &namespace).unwrap();
        run_git(
            repository,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/changed.git",
            ],
        );
        let error = update_remote(
            repository,
            &RemoteUpdateInput {
                name: "origin".to_owned(),
                expected_token: preview.token,
                new_fetch_url: Some("https://github.com/example/new.git".to_owned()),
                new_push_url: None,
                reset_push_url: false,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(error.code, "remote_snapshot_changed");
    }

    #[test]
    fn previews_affected_upstreams_before_deleting_a_remote() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let current_branch = status(repository).unwrap().branch.head.unwrap();
        let namespace = Uuid::new_v4();

        create_remote(
            repository,
            &RemoteCreateInput {
                name: "origin".to_owned(),
                fetch_url: "https://github.com/example/repository.git".to_owned(),
                push_url: None,
            },
        )
        .unwrap();
        run_git(
            repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_git(
            repository,
            &["branch", "--set-upstream-to=origin/main", &current_branch],
        );

        let preview = preview_remote_delete(repository, "origin", &namespace).unwrap();
        assert_eq!(preview.affected_branches, vec![current_branch]);
        delete_remote(
            repository,
            &RemoteDeleteInput {
                name: "origin".to_owned(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();
        assert!(repository_refs(repository).unwrap().remotes.is_empty());
    }

    #[test]
    fn clone_refuses_existing_destination_and_pre_cancel_creates_nothing() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("existing")).unwrap();
        let existing =
            prepare_clone("https://github.com/example/existing.git", directory.path()).unwrap_err();
        assert_eq!(existing.code, "clone_destination_exists");

        let target =
            prepare_clone("https://github.com/example/cancelled.git", directory.path()).unwrap();
        let cancelled =
            clone_repository(&target, Arc::new(AtomicBool::new(true)), Arc::new(|_| {}))
                .unwrap_err();
        assert_eq!(cancelled.code, "git_operation_cancelled");
        assert!(!target.target_directory.exists());
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".git-knot-clone-")));
    }

    #[test]
    fn pull_deadline_is_shared_between_fetch_and_merge() {
        let started_at = Instant::now();
        let deadline = OperationDeadline {
            started_at,
            timeout: Duration::from_secs(5 * 60),
        };

        assert_eq!(
            deadline.remaining_at(started_at + Duration::from_secs(90)),
            Some(Duration::from_secs(210))
        );
        assert_eq!(
            deadline.remaining_at(started_at + Duration::from_secs(5 * 60)),
            None
        );
        assert_eq!(
            deadline.remaining_at(started_at + Duration::from_secs(6 * 60)),
            None
        );
    }

    #[test]
    fn pull_cancellation_uses_pull_message_before_fetch() {
        let directory = tempdir().unwrap();
        let (_, _, client, _) = initialize_remote_clone(directory.path());
        let error = pull_fast_forward(&client, Arc::new(AtomicBool::new(true)), Arc::new(|_| {}))
            .unwrap_err();
        assert_eq!(error.code, "git_operation_cancelled");
        assert_eq!(error.message, PULL_CANCELLED_MESSAGE);
    }

    #[test]
    fn git_commands_are_non_interactive_and_disable_commit_signing() {
        let command = git_command_with_pathspec_mode(
            Some(Path::new("repository")),
            GitLocking::Required,
            true,
        );
        let environment = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<HashMap<_, _>>();

        assert_eq!(
            environment.get(OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&OsStr::new("0"))
        );
        assert_eq!(
            environment.get(OsStr::new("GCM_INTERACTIVE")),
            Some(&OsStr::new("Never"))
        );
        assert_eq!(
            environment.get(OsStr::new("GIT_EDITOR")),
            Some(&OsStr::new("true"))
        );
        assert_eq!(
            environment.get(OsStr::new("GIT_SEQUENCE_EDITOR")),
            Some(&OsStr::new("true"))
        );

        let arguments = command.get_args().collect::<Vec<_>>();
        assert!(arguments
            .windows(2)
            .any(|pair| pair == [OsStr::new("-c"), OsStr::new("commit.gpgSign=false")]));
    }

    #[test]
    fn create_commit_ignores_repository_commit_signing_configuration() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        run_git(repository, &["config", "commit.gpgSign", "true"]);
        run_git(
            repository,
            &["config", "gpg.program", "git-knot-missing-gpg-program"],
        );
        fs::write(repository.join("signed.txt"), "content\n").unwrap();
        stage(repository, &["signed.txt".to_owned()]).unwrap();

        let commit = create_commit(
            repository,
            &CommitInput {
                subject: "Unsigned by policy".to_owned(),
                body: String::new(),
            },
        )
        .unwrap();

        assert_eq!(commit.subject, "Unsigned by policy");
    }

    #[cfg(unix)]
    #[test]
    fn local_git_deadline_terminates_a_blocking_hook() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("blocked.txt"), "content\n").unwrap();
        stage(repository, &["blocked.txt".to_owned()]).unwrap();

        let hook = repository.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\ntrap '' TERM\nsleep 30\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

        let mut command = git_command(Some(repository), GitLocking::Required);
        command.args(["commit", "--file=-"]);
        let error = match run_capped_command_with_deadline(
            command,
            MAX_STDERR_BYTES,
            &[0],
            Some(b"Blocked by hook\n"),
            OperationDeadline::new(Duration::from_millis(50)),
        ) {
            Ok(_) => panic!("blocking hook should time out"),
            Err(error) => error,
        };

        assert_eq!(error.code, "git_operation_timed_out");
        assert_eq!(error.message, LOCAL_GIT_TIMEOUT_MESSAGE);
        assert!(!head_exists(repository).unwrap());
    }

    fn run_git(repository: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("system Git should be available for integration tests");

        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_with_dates(repository: &Path, arguments: &[&str], date: &str) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("system Git should be available for integration tests");

        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_expect_failure(repository: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("system Git should be available for integration tests");

        assert!(
            !output.status.success(),
            "git {} unexpectedly succeeded",
            arguments.join(" ")
        );
    }

    fn git_stdout(repository: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("system Git should be available for integration tests");

        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn history_query(offset: u32, limit: u32) -> HistoryQuery {
        HistoryQuery {
            offset,
            limit,
            ref_full_name: None,
            search: String::new(),
            author: String::new(),
            after: None,
            before: None,
            file_path: None,
        }
    }

    fn initialize_repository(repository: &Path) {
        run_git(repository, &["init", "--quiet"]);
        run_git(repository, &["config", "user.name", "git-knot Tests"]);
        run_git(
            repository,
            &["config", "user.email", "git-knot-tests@example.invalid"],
        );
        run_git(repository, &["config", "commit.gpgSign", "false"]);
    }

    fn initialize_text_conflict(repository: &Path) {
        initialize_repository(repository);
        fs::write(repository.join("conflict.txt"), "base\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        run_git(repository, &["checkout", "--quiet", "-b", "incoming-side"]);
        fs::write(repository.join("conflict.txt"), "incoming\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Incoming"]);
        run_git(repository, &["checkout", "--quiet", "-"]);
        fs::write(repository.join("conflict.txt"), "current\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Current"]);
        run_git_expect_failure(repository, &["merge", "--no-edit", "incoming-side"]);
    }

    fn initialize_remote_clone(root: &Path) -> (PathBuf, PathBuf, PathBuf, String) {
        let remote = root.join("remote.git");
        let source = root.join("source");
        let client = root.join("client");
        fs::create_dir(&remote).unwrap();
        fs::create_dir(&source).unwrap();
        run_git(&remote, &["init", "--bare", "--quiet"]);
        initialize_repository(&source);
        fs::write(source.join("base.txt"), "base\n").unwrap();
        run_git(&source, &["add", "base.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Base"]);
        let branch = status(&source).unwrap().branch.head.unwrap();
        run_git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        run_git(
            root,
            &[
                "clone",
                "--quiet",
                "--branch",
                &branch,
                remote.to_str().unwrap(),
                client.to_str().unwrap(),
            ],
        );
        run_git(&client, &["config", "user.name", "git-knot Tests"]);
        run_git(
            &client,
            &["config", "user.email", "git-knot-tests@example.invalid"],
        );
        run_git(&client, &["config", "commit.gpgSign", "false"]);
        (remote, source, client, branch)
    }

    #[test]
    fn bounded_status_rejects_truncated_and_excessive_change_lists() {
        let truncated = parse_bounded_status(
            Path::new("/repo"),
            LimitedOutput {
                stdout: Vec::new(),
                truncated: true,
            },
        )
        .unwrap_err();
        assert_eq!(truncated.code, "status_output_too_large");

        let excessive = parse_bounded_status(
            Path::new("/repo"),
            LimitedOutput {
                stdout: b"? a\0".repeat(MAX_STATUS_CHANGES + 1),
                truncated: false,
            },
        )
        .unwrap_err();
        assert_eq!(excessive.code, "too_many_status_changes");
    }

    #[test]
    fn status_reports_changes_from_a_real_repository() {
        let directory = tempdir().unwrap();
        let repository = directory.path();

        initialize_repository(repository);

        fs::write(repository.join("modified.txt"), "base\n").unwrap();
        fs::write(repository.join("renamed-before.txt"), "rename me\n").unwrap();
        run_git(repository, &["add", "."]);
        run_git(repository, &["commit", "--quiet", "-m", "Initial commit"]);

        fs::write(repository.join("staged.txt"), "staged\n").unwrap();
        run_git(repository, &["add", "staged.txt"]);
        fs::write(repository.join("modified.txt"), "base\nchanged\n").unwrap();
        run_git(
            repository,
            &["mv", "renamed-before.txt", "renamed-after.txt"],
        );
        fs::create_dir(repository.join("notes")).unwrap();
        fs::write(repository.join("notes/untracked file.md"), "untracked\n").unwrap();

        let result = status(repository).unwrap();

        assert_eq!(
            result.root,
            repository.canonicalize().unwrap().to_string_lossy()
        );
        assert!(result.branch.head.is_some());

        let staged = result
            .changes
            .iter()
            .find(|change| change.path == "staged.txt")
            .expect("staged file should be reported");
        assert_eq!(staged.index_status.as_deref(), Some("A"));
        assert!(staged.worktree_status.is_none());

        let modified = result
            .changes
            .iter()
            .find(|change| change.path == "modified.txt")
            .expect("modified file should be reported");
        assert!(modified.index_status.is_none());
        assert_eq!(modified.worktree_status.as_deref(), Some("M"));

        let renamed = result
            .changes
            .iter()
            .find(|change| change.path == "renamed-after.txt")
            .expect("renamed file should be reported");
        assert!(matches!(renamed.kind, ChangeKind::Renamed));
        assert_eq!(renamed.original_path.as_deref(), Some("renamed-before.txt"));

        let untracked = result
            .changes
            .iter()
            .find(|change| change.path == "notes/untracked file.md")
            .expect("untracked file should be reported");
        assert!(matches!(untracked.kind, ChangeKind::Untracked));
    }

    #[test]
    fn reads_submodule_inventory_without_mutating_or_recursing() {
        let directory = tempdir().unwrap();
        let superproject = directory.path().join("superproject");
        let child = directory.path().join("child");
        fs::create_dir(&superproject).unwrap();
        fs::create_dir(&child).unwrap();
        initialize_repository(&child);
        fs::write(child.join("child.txt"), "child\n").unwrap();
        run_git(&child, &["add", "child.txt"]);
        run_git(&child, &["commit", "--quiet", "-m", "Child"]);
        initialize_repository(&superproject);
        run_git(
            &superproject,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                child.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(&superproject, &["commit", "--quiet", "-am", "Add child"]);

        let clean = repository_submodules(&superproject).unwrap();
        assert!(clean.gitmodules_present);
        assert_eq!(clean.submodules.len(), 1);
        assert_eq!(clean.submodules[0].path, "deps/child");
        assert_eq!(clean.submodules[0].state, SubmoduleState::Clean);
        assert!(clean.submodules[0].configured);
        assert_eq!(
            clean.submodules[0].url.as_deref(),
            Some(child.to_str().unwrap())
        );

        fs::write(superproject.join("deps/child/child.txt"), "changed\n").unwrap();
        assert_eq!(
            repository_submodules(&superproject).unwrap().submodules[0].state,
            SubmoduleState::Modified
        );
        fs::remove_dir_all(superproject.join("deps/child")).unwrap();
        assert_eq!(
            repository_submodules(&superproject).unwrap().submodules[0].state,
            SubmoduleState::Uninitialized
        );
    }

    #[test]
    fn redacts_credentials_and_query_from_submodule_urls() {
        let directory = tempdir().unwrap();
        let superproject = directory.path().join("superproject");
        let child = directory.path().join("child");
        fs::create_dir(&superproject).unwrap();
        fs::create_dir(&child).unwrap();
        initialize_repository(&child);
        fs::write(child.join("child.txt"), "child\n").unwrap();
        run_git(&child, &["add", "child.txt"]);
        run_git(&child, &["commit", "--quiet", "-m", "Child"]);
        initialize_repository(&superproject);
        run_git(
            &superproject,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                child.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(
            &superproject,
            &[
                "config",
                "--file",
                ".gitmodules",
                "submodule.deps/child.url",
                "https://token:secret@example.com/repo.git?credential=value",
            ],
        );

        let inventory = repository_submodules(&superproject).unwrap();
        assert_eq!(
            inventory.submodules[0].url.as_deref(),
            Some("https://example.com/repo.git")
        );
    }

    #[test]
    fn missing_gitmodules_configuration_remains_unsafe_when_checkout_is_modified() {
        let directory = tempdir().unwrap();
        let superproject = directory.path().join("superproject");
        let child = directory.path().join("child");
        fs::create_dir(&superproject).unwrap();
        fs::create_dir(&child).unwrap();
        initialize_repository(&child);
        fs::write(child.join("child.txt"), "child\n").unwrap();
        run_git(&child, &["add", "child.txt"]);
        run_git(&child, &["commit", "--quiet", "-m", "Child"]);
        initialize_repository(&superproject);
        run_git(
            &superproject,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                child.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(&superproject, &["commit", "--quiet", "-am", "Add child"]);
        fs::remove_file(superproject.join(".gitmodules")).unwrap();
        fs::write(superproject.join("deps/child/child.txt"), "changed\n").unwrap();

        let inventory = repository_submodules(&superproject).unwrap();
        assert_eq!(inventory.submodules[0].state, SubmoduleState::Unsafe);
        assert!(!inventory.submodules[0].configured);
        assert_eq!(
            inventory.submodules[0].state_detail.as_deref(),
            Some("缺少 .gitmodules 配置条目")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_gitmodules_without_touching_the_target() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let repository = directory.path().join("repository");
        let external = directory.path().join("external-gitmodules");
        fs::create_dir(&repository).unwrap();
        initialize_repository(&repository);
        let original = "[submodule \"external\"]\n\tpath = deps/external\n";
        fs::write(&external, original).unwrap();
        symlink(&external, repository.join(".gitmodules")).unwrap();

        let error = repository_submodules(&repository).unwrap_err();
        assert_eq!(error.code, "unsafe_gitmodules");
        assert_eq!(fs::read_to_string(external).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn marks_symlinked_submodule_checkout_unsafe_without_entering_it() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let superproject = directory.path().join("superproject");
        let child = directory.path().join("child");
        let external = directory.path().join("external-checkout");
        fs::create_dir(&superproject).unwrap();
        fs::create_dir(&child).unwrap();
        fs::create_dir(&external).unwrap();
        initialize_repository(&child);
        fs::write(child.join("child.txt"), "child\n").unwrap();
        run_git(&child, &["add", "child.txt"]);
        run_git(&child, &["commit", "--quiet", "-m", "Child"]);
        initialize_repository(&superproject);
        run_git(
            &superproject,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                child.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(&superproject, &["commit", "--quiet", "-am", "Add child"]);
        fs::write(external.join("sentinel.txt"), "unchanged\n").unwrap();
        fs::remove_dir_all(superproject.join("deps/child")).unwrap();
        symlink(&external, superproject.join("deps/child")).unwrap();

        let inventory = repository_submodules(&superproject).unwrap();
        assert_eq!(inventory.submodules.len(), 1);
        assert_eq!(inventory.submodules[0].state, SubmoduleState::Unsafe);
        assert_eq!(
            inventory.submodules[0].state_detail.as_deref(),
            Some("子模块路径包含符号链接，已拒绝进入")
        );
        assert_eq!(
            fs::read_to_string(external.join("sentinel.txt")).unwrap(),
            "unchanged\n"
        );
    }

    #[test]
    fn reads_sanitized_branches_and_remotes_from_a_real_repository() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let current = status(repository).unwrap().branch.head.unwrap();
        run_git(repository, &["branch", "topic"]);
        run_git(
            repository,
            &[
                "remote",
                "add",
                "origin",
                "https://user:secret@example.com/acme/repository.git?token=hidden",
            ],
        );
        run_git(
            repository,
            &[
                "config",
                "remote.origin.pushurl",
                "ssh://user:secret@example.com/acme/repository.git#hidden",
            ],
        );
        run_git(
            repository,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{current}"),
                "HEAD",
            ],
        );
        run_git(
            repository,
            &[
                "branch",
                "--set-upstream-to",
                &format!("origin/{current}"),
                &current,
            ],
        );

        let refs = repository_refs(repository).unwrap();
        assert!(refs
            .branches
            .iter()
            .any(|branch| branch.name == current && branch.current));
        assert!(refs
            .branches
            .iter()
            .any(|branch| branch.name == "topic" && matches!(branch.kind, BranchKind::Local)));
        assert!(refs.branches.iter().any(|branch| {
            branch.name == format!("origin/{current}") && matches!(branch.kind, BranchKind::Remote)
        }));
        assert_eq!(refs.remotes.len(), 1);
        assert_eq!(
            refs.remotes[0].fetch_url,
            "https://example.com/acme/repository.git"
        );
        assert_eq!(
            refs.remotes[0].push_url,
            "ssh://example.com/acme/repository.git"
        );
    }

    #[test]
    fn creates_and_switches_only_local_branches() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();

        create_and_switch_branch(repository, "feature/safe-switch").unwrap();
        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some("feature/safe-switch")
        );

        switch_local_branch(repository, &format!("refs/heads/{initial}")).unwrap();
        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some(initial.as_str())
        );

        run_git(
            repository,
            &["remote", "add", "origin", "https://example.com/repo.git"],
        );
        run_git(
            repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        let remote_error = switch_local_branch(repository, "refs/remotes/origin/main").unwrap_err();
        assert_eq!(remote_error.code, "remote_branch_switch_unsupported");

        run_git(
            repository,
            &[
                "update-ref",
                "refs/remotes/origin/feature/safe-track",
                "HEAD",
            ],
        );
        create_tracking_branch(repository, "refs/remotes/origin/feature/safe-track").unwrap();
        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some("feature/safe-track")
        );
        let tracked = repository_refs(repository)
            .unwrap()
            .branches
            .into_iter()
            .find(|branch| branch.name == "feature/safe-track")
            .unwrap();
        assert_eq!(
            tracked.upstream.as_deref(),
            Some("origin/feature/safe-track")
        );

        let duplicate_error =
            create_tracking_branch(repository, "refs/remotes/origin/feature/safe-track")
                .unwrap_err();
        assert_eq!(duplicate_error.code, "local_branch_already_exists");

        let invalid_remote_error =
            create_tracking_branch(repository, "refs/heads/main").unwrap_err();
        assert_eq!(invalid_remote_error.code, "remote_branch_required");

        let invalid_error = create_and_switch_branch(repository, "bad branch").unwrap_err();
        assert_eq!(invalid_error.code, "invalid_branch_name");
    }

    #[test]
    fn switches_to_option_like_branch_without_discarding_changes() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(
            repository,
            &["update-ref", "refs/heads/--discard-changes", "HEAD"],
        );

        fs::write(repository.join("base.txt"), "staged\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        fs::write(repository.join("base.txt"), "unstaged\n").unwrap();

        switch_local_branch(repository, "refs/heads/--discard-changes").unwrap();

        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some("--discard-changes")
        );
        assert!(
            git_stdout(repository, &["diff", "--cached", "--", "base.txt"]).contains("+staged")
        );
        assert!(git_stdout(repository, &["diff", "--", "base.txt"]).contains("+unstaged"));
    }

    #[test]
    fn requires_an_initial_commit_before_creating_a_branch() {
        let directory = tempdir().unwrap();
        initialize_repository(directory.path());
        let error = create_and_switch_branch(directory.path(), "feature/first").unwrap_err();
        assert_eq!(error.code, "branch_requires_commit");
    }

    #[test]
    fn creates_a_local_branch_from_an_exact_commit_without_switching() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let base_oid = status(repository).unwrap().branch.oid.unwrap();

        fs::write(repository.join("base.txt"), "base\nhead\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Head"]);
        let before = status(repository).unwrap();

        create_branch_at_commit(repository, "feature/from-history", &base_oid).unwrap();

        let after = status(repository).unwrap();
        assert_eq!(after.branch.head, before.branch.head);
        assert_eq!(after.branch.oid, before.branch.oid);
        let created = repository_refs(repository)
            .unwrap()
            .branches
            .into_iter()
            .find(|branch| branch.full_name == "refs/heads/feature/from-history")
            .unwrap();
        assert!(!created.current);
        assert_eq!(created.oid, base_oid);

        let duplicate =
            create_branch_at_commit(repository, "feature/from-history", &base_oid).unwrap_err();
        assert_eq!(duplicate.code, "local_branch_already_exists");
    }

    #[test]
    fn rejects_non_exact_or_non_commit_branch_targets() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        let revision_error =
            create_branch_at_commit(repository, "feature/revision", "HEAD").unwrap_err();
        assert_eq!(revision_error.code, "invalid_commit_oid");

        let missing_error =
            create_branch_at_commit(repository, "feature/missing", &"f".repeat(40)).unwrap_err();
        assert_eq!(missing_error.code, "branch_target_not_found");

        let blob = execute(Some(repository), &["hash-object", "-w", "base.txt"]).unwrap();
        let blob_oid = String::from_utf8(blob.stdout).unwrap().trim().to_owned();
        let blob_error =
            create_branch_at_commit(repository, "feature/blob", &blob_oid).unwrap_err();
        assert_eq!(blob_error.code, "branch_target_not_commit");
    }

    #[test]
    fn rejects_branch_names_that_conflict_with_existing_ref_paths() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let oid = status(repository).unwrap().branch.oid.unwrap();

        create_branch_at_commit(repository, "topic/child", &oid).unwrap();
        let error = create_branch_at_commit(repository, "topic", &oid).unwrap_err();
        assert_eq!(error.code, "local_branch_name_conflict");
    }

    #[test]
    fn deletes_only_authoritative_non_current_local_branches() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let current = status(repository).unwrap().branch.head.unwrap();
        run_git(repository, &["branch", "merged-topic"]);

        let current_error =
            delete_local_branch(repository, &format!("refs/heads/{current}"), true).unwrap_err();
        assert_eq!(current_error.code, "current_branch_delete_unsupported");

        let remote_error =
            delete_local_branch(repository, "refs/remotes/origin/merged-topic", true).unwrap_err();
        assert_eq!(remote_error.code, "local_branch_required");

        let missing_error =
            delete_local_branch(repository, "refs/heads/missing-topic", true).unwrap_err();
        assert_eq!(missing_error.code, "branch_not_found");

        delete_local_branch(repository, "refs/heads/merged-topic", false).unwrap();
        assert!(!repository_refs(repository)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.full_name == "refs/heads/merged-topic"));
        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some(current.as_str())
        );
    }

    #[test]
    fn requires_explicit_confirmation_before_deleting_an_unmerged_branch() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();

        run_git(repository, &["switch", "--quiet", "-c", "unmerged-topic"]);
        fs::write(repository.join("topic.txt"), "topic\n").unwrap();
        run_git(repository, &["add", "topic.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Topic"]);
        run_git(repository, &["switch", "--quiet", &initial]);

        let error =
            delete_local_branch(repository, "refs/heads/unmerged-topic", false).unwrap_err();
        assert_eq!(error.code, "local_branch_not_merged");
        assert!(repository_refs(repository)
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.full_name == "refs/heads/unmerged-topic"));

        delete_local_branch(repository, "refs/heads/unmerged-topic", true).unwrap();
        let refs = repository_refs(repository).unwrap();
        assert!(!refs
            .branches
            .iter()
            .any(|branch| branch.full_name == "refs/heads/unmerged-topic"));
        assert_eq!(
            status(repository).unwrap().branch.head.as_deref(),
            Some(initial.as_str())
        );
    }

    #[test]
    fn branch_delete_cas_preserves_a_ref_moved_after_validation() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(repository, &["branch", "moving-topic"]);
        let checked_oid = exact_commit_oid(repository, "refs/heads/moving-topic").unwrap();

        fs::write(repository.join("next.txt"), "next\n").unwrap();
        run_git(repository, &["add", "next.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Next"]);
        let moved_oid = exact_commit_oid(repository, "HEAD").unwrap();
        run_git(
            repository,
            &["update-ref", "refs/heads/moving-topic", &moved_oid],
        );

        let error = delete_local_branch_ref(repository, "refs/heads/moving-topic", &checked_oid)
            .unwrap_err();

        assert_eq!(error.code, "git_command_failed");
        assert_eq!(
            exact_commit_oid(repository, "refs/heads/moving-topic").unwrap(),
            moved_oid
        );
    }

    #[test]
    fn previews_and_fast_forwards_an_authoritative_local_branch() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();

        run_git(repository, &["switch", "--quiet", "-c", "merge-topic"]);
        fs::write(repository.join("topic.txt"), "topic\n").unwrap();
        run_git(repository, &["add", "topic.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Topic"]);
        let target_oid = status(repository).unwrap().branch.oid.unwrap();
        run_git(repository, &["switch", "--quiet", &initial]);

        let preview = preview_local_merge(repository, "refs/heads/merge-topic").unwrap();
        assert_eq!(preview.current_branch, initial);
        assert_eq!(preview.target_branch, "merge-topic");
        assert_eq!(preview.mode, LocalMergeMode::FastForward);
        assert_eq!((preview.ahead, preview.behind), (0, 1));

        merge_local_branch(
            repository,
            "refs/heads/merge-topic",
            LocalMergeStrategy::FastForwardOnly,
        )
        .unwrap();
        let after = status(repository).unwrap();
        assert_eq!(after.branch.oid.as_deref(), Some(target_oid.as_str()));
        assert!(after.changes.is_empty());
    }

    #[test]
    fn creates_a_merge_commit_when_requested_for_a_fast_forward_relation() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();

        run_git(repository, &["switch", "--quiet", "-c", "merge-record"]);
        fs::write(repository.join("record.txt"), "record\n").unwrap();
        run_git(repository, &["add", "record.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Record"]);
        run_git(repository, &["switch", "--quiet", &initial]);

        merge_local_branch(
            repository,
            "refs/heads/merge-record",
            LocalMergeStrategy::CreateMergeCommit,
        )
        .unwrap();
        let output = execute(
            Some(repository),
            &["rev-list", "--parents", "-n", "1", "HEAD"],
        )
        .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .count(),
            3
        );
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn rejects_fast_forward_only_after_branches_diverge() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();
        run_git(repository, &["branch", "diverged-topic"]);

        fs::write(repository.join("current.txt"), "current\n").unwrap();
        run_git(repository, &["add", "current.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Current"]);
        run_git(repository, &["switch", "--quiet", "diverged-topic"]);
        fs::write(repository.join("topic.txt"), "topic\n").unwrap();
        run_git(repository, &["add", "topic.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Topic"]);
        run_git(repository, &["switch", "--quiet", &initial]);

        let preview = preview_local_merge(repository, "refs/heads/diverged-topic").unwrap();
        assert_eq!(preview.mode, LocalMergeMode::MergeCommit);
        assert_eq!((preview.ahead, preview.behind), (1, 1));
        let error = merge_local_branch(
            repository,
            "refs/heads/diverged-topic",
            LocalMergeStrategy::FastForwardOnly,
        )
        .unwrap_err();
        assert_eq!(error.code, "local_merge_not_fast_forward");
        assert!(!merge_in_progress(repository).unwrap());
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn aborts_a_conflicting_merge_and_restores_the_current_branch() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("conflict.txt"), "base\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let initial = status(repository).unwrap().branch.head.unwrap();
        run_git(repository, &["branch", "conflict-topic"]);

        fs::write(repository.join("conflict.txt"), "current\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Current"]);
        run_git(repository, &["switch", "--quiet", "conflict-topic"]);
        fs::write(repository.join("conflict.txt"), "topic\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Topic"]);
        run_git(repository, &["switch", "--quiet", &initial]);

        let error = merge_local_branch(
            repository,
            "refs/heads/conflict-topic",
            LocalMergeStrategy::CreateMergeCommit,
        )
        .unwrap_err();
        assert_eq!(error.code, "local_merge_conflict");
        assert!(!merge_in_progress(repository).unwrap());
        assert_eq!(
            fs::read_to_string(repository.join("conflict.txt")).unwrap(),
            "current\n"
        );
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn local_merge_requires_a_clean_attached_local_branch_and_local_full_ref() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        run_git(repository, &["branch", "safe-topic"]);

        fs::write(repository.join("dirty.txt"), "dirty\n").unwrap();
        let dirty = preview_local_merge(repository, "refs/heads/safe-topic").unwrap_err();
        assert_eq!(dirty.code, "local_merge_dirty_worktree");
        fs::remove_file(repository.join("dirty.txt")).unwrap();

        let remote = preview_local_merge(repository, "refs/remotes/origin/safe-topic").unwrap_err();
        assert_eq!(remote.code, "local_branch_required");
        run_git(repository, &["switch", "--quiet", "--detach", "HEAD"]);
        let detached = preview_local_merge(repository, "refs/heads/safe-topic").unwrap_err();
        assert_eq!(detached.code, "local_merge_current_branch_required");
    }

    #[test]
    fn creates_reads_and_deletes_only_local_tags_for_commit_oids() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let target_oid = status(repository).unwrap().branch.oid.unwrap();
        run_git(repository, &["config", "tag.gpgSign", "true"]);

        create_tag(repository, "v1.0.0", &target_oid, None).unwrap();
        create_tag(
            repository,
            "release/v2.0.0",
            &target_oid,
            Some("Release 2\n\nStable release"),
        )
        .unwrap();

        let tags = repository_tags(repository).unwrap().tags;
        assert_eq!(tags.len(), 2);
        let lightweight = tags.iter().find(|tag| tag.name == "v1.0.0").unwrap();
        assert!(!lightweight.annotated);
        assert_eq!(lightweight.target_oid, target_oid);
        let annotated = tags
            .iter()
            .find(|tag| tag.name == "release/v2.0.0")
            .unwrap();
        assert!(annotated.annotated);
        assert_eq!(annotated.target_oid, target_oid);
        assert_eq!(annotated.subject.as_deref(), Some("Release 2"));
        assert!(annotated.tagger_date.is_some());

        let duplicate = create_tag(repository, "v1.0.0", &target_oid, None).unwrap_err();
        assert_eq!(duplicate.code, "tag_already_exists");
        let invalid_name = create_tag(repository, "bad tag", &target_oid, None).unwrap_err();
        assert_eq!(invalid_name.code, "invalid_tag_name");
        let missing_target = create_tag(repository, "missing", &"f".repeat(40), None).unwrap_err();
        assert_eq!(missing_target.code, "tag_target_not_found");
        let invalid_selector = delete_tag(repository, "refs/heads/main").unwrap_err();
        assert_eq!(invalid_selector.code, "local_tag_required");

        delete_tag(repository, "refs/tags/release/v2.0.0").unwrap();
        let tags = repository_tags(repository).unwrap().tags;
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "v1.0.0");
    }

    #[test]
    fn safely_publishes_a_remote_tag_without_overwriting_a_different_value() {
        let directory = tempdir().unwrap();
        let (remote, _, client, _) = initialize_remote_clone(directory.path());
        run_git(&client, &["tag", "v1.0.0"]);
        let first_oid = git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]);

        push_remote_tag(
            &client,
            &RemoteTagPushInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: first_oid.clone(),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
        assert_eq!(
            git_stdout(&remote, &["rev-parse", "refs/tags/v1.0.0"]),
            first_oid
        );

        fs::write(client.join("next.txt"), "next\n").unwrap();
        run_git(&client, &["add", "next.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Next"]);
        run_git(&client, &["tag", "--force", "v1.0.0"]);
        let moved_oid = git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]);
        assert_ne!(moved_oid, first_oid);

        let error = push_remote_tag(
            &client,
            &RemoteTagPushInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: moved_oid,
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(error.code, "remote_tag_already_exists");
        assert_eq!(
            git_stdout(&remote, &["rev-parse", "refs/tags/v1.0.0"]),
            first_oid
        );
    }

    #[test]
    fn previews_and_deletes_only_the_expected_remote_tag_value() {
        let directory = tempdir().unwrap();
        let (remote, _, client, _) = initialize_remote_clone(directory.path());
        run_git(&client, &["tag", "v1.0.0"]);
        let local_oid = git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]);
        let namespace = Uuid::new_v4();
        push_remote_tag(
            &client,
            &RemoteTagPushInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: local_oid.clone(),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();

        let preview = preview_remote_tag_delete(
            &client,
            &RemoteTagDeletePreviewInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: local_oid.clone(),
            },
            &namespace,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
        assert_eq!(preview.remote_oid, local_oid);
        assert!(!preview.token.is_empty());

        delete_remote_tag(
            &client,
            &RemoteTagDeleteInput {
                remote_name: preview.remote_name,
                full_name: preview.full_name,
                expected_local_oid: preview.local_oid,
                expected_remote_oid: preview.remote_oid,
                expected_token: preview.token,
            },
            &namespace,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();

        run_git_expect_failure(&remote, &["rev-parse", "--verify", "refs/tags/v1.0.0"]);
        assert_eq!(
            git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]),
            local_oid
        );
    }

    #[test]
    fn refuses_remote_tag_delete_when_the_remote_value_changed_after_preview() {
        let directory = tempdir().unwrap();
        let (remote, source, client, _) = initialize_remote_clone(directory.path());
        run_git(&client, &["tag", "v1.0.0"]);
        let local_oid = git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]);
        let namespace = Uuid::new_v4();
        push_remote_tag(
            &client,
            &RemoteTagPushInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: local_oid.clone(),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
        let preview = preview_remote_tag_delete(
            &client,
            &RemoteTagDeletePreviewInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: local_oid,
            },
            &namespace,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();

        fs::write(source.join("competitor.txt"), "competitor\n").unwrap();
        run_git(&source, &["add", "competitor.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Competitor"]);
        run_git(&source, &["tag", "--force", "v1.0.0"]);
        run_git(
            &source,
            &["push", "--quiet", "--force", "origin", "refs/tags/v1.0.0"],
        );
        let competing_oid = git_stdout(&remote, &["rev-parse", "refs/tags/v1.0.0"]);
        assert_ne!(competing_oid, preview.remote_oid);

        let error = delete_remote_tag(
            &client,
            &RemoteTagDeleteInput {
                remote_name: preview.remote_name,
                full_name: preview.full_name,
                expected_local_oid: preview.local_oid,
                expected_remote_oid: preview.remote_oid,
                expected_token: preview.token,
            },
            &namespace,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(error.code, "remote_tag_changed");
        assert_eq!(
            git_stdout(&remote, &["rev-parse", "refs/tags/v1.0.0"]),
            competing_oid
        );
    }

    #[test]
    fn validates_remote_tag_inputs_before_starting_network_writes() {
        let directory = tempdir().unwrap();
        let (_, _, client, _) = initialize_remote_clone(directory.path());
        run_git(&client, &["tag", "v1.0.0"]);
        let local_oid = git_stdout(&client, &["rev-parse", "refs/tags/v1.0.0"]);
        let base = RemoteTagPushInput {
            remote_name: "origin".to_owned(),
            full_name: "refs/tags/v1.0.0".to_owned(),
            expected_local_oid: local_oid.clone(),
        };

        let invalid_ref = push_remote_tag(
            &client,
            &RemoteTagPushInput {
                full_name: "refs/heads/main".to_owned(),
                ..base.clone()
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(invalid_ref.code, "local_tag_required");

        let stale_local = push_remote_tag(
            &client,
            &RemoteTagPushInput {
                expected_local_oid: "f".repeat(40),
                ..base.clone()
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(stale_local.code, "local_tag_changed");

        let cancelled = push_remote_tag(
            &client,
            &base,
            Arc::new(AtomicBool::new(true)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(cancelled.code, "git_operation_cancelled");

        run_git(
            &client,
            &[
                "config",
                "remote.origin.pushurl",
                "https://gitee.com/example/repository.git",
            ],
        );
        let gitee = push_remote_tag(
            &client,
            &base,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(gitee.code, "gitee_not_supported");

        run_git(&client, &["config", "--unset-all", "remote.origin.pushurl"]);
        run_git(
            &client,
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                directory.path().join("one.git").to_str().unwrap(),
            ],
        );
        run_git(
            &client,
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                directory.path().join("two.git").to_str().unwrap(),
            ],
        );
        let multiple = push_remote_tag(
            &client,
            &base,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(multiple.code, "remote_multiple_push_urls_unsupported");

        let invalid_remote_oid = delete_remote_tag(
            &client,
            &RemoteTagDeleteInput {
                remote_name: "origin".to_owned(),
                full_name: "refs/tags/v1.0.0".to_owned(),
                expected_local_oid: local_oid,
                expected_remote_oid: "not-an-oid".to_owned(),
                expected_token: Uuid::new_v4().to_string(),
            },
            &Uuid::new_v4(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(invalid_remote_oid.code, "invalid_remote_tag_oid");
    }

    #[test]
    fn creates_reads_and_drops_stashes_by_exact_oid() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repository.join("untracked.txt"), "draft\n").unwrap();
        create_stash(
            repository,
            &StashCreateInput {
                message: Some("--index --include-untracked Save local work".to_owned()),
                include_untracked: true,
                keep_index: false,
            },
        )
        .unwrap();

        let stashes = repository_stashes(repository).unwrap().stashes;
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert!(stashes[0]
            .subject
            .contains("--index --include-untracked Save local work"));
        assert!(matches!(stashes[0].oid.len(), 40 | 64));
        assert!(status(repository).unwrap().changes.is_empty());

        let nothing = create_stash(
            repository,
            &StashCreateInput {
                message: None,
                include_untracked: true,
                keep_index: false,
            },
        )
        .unwrap_err();
        assert_eq!(nothing.code, "nothing_to_stash");

        let invalid = drop_stash(repository, "stash@{0}").unwrap_err();
        assert_eq!(invalid.code, "invalid_stash_oid");
        drop_stash(repository, &stashes[0].oid).unwrap();
        assert!(repository_stashes(repository).unwrap().stashes.is_empty());
    }

    #[test]
    fn applies_and_pops_stashes_without_accepting_revisions() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("tracked.txt"), "stashed\n").unwrap();
        create_stash(
            repository,
            &StashCreateInput {
                message: None,
                include_untracked: false,
                keep_index: false,
            },
        )
        .unwrap();
        let oid = repository_stashes(repository).unwrap().stashes[0]
            .oid
            .clone();

        apply_stash(repository, &oid, false).unwrap();
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "stashed\n"
        );
        assert_eq!(repository_stashes(repository).unwrap().stashes.len(), 1);

        run_git(repository, &["reset", "--hard", "--quiet", "HEAD"]);
        pop_stash(repository, &oid, false).unwrap();
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "stashed\n"
        );
        assert!(repository_stashes(repository).unwrap().stashes.is_empty());
    }

    #[test]
    fn pop_conflict_returns_stable_error_and_keeps_stash() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("conflict.txt"), "base\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("conflict.txt"), "stashed\n").unwrap();
        create_stash(
            repository,
            &StashCreateInput {
                message: Some("Conflict candidate".to_owned()),
                include_untracked: false,
                keep_index: false,
            },
        )
        .unwrap();
        let oid = repository_stashes(repository).unwrap().stashes[0]
            .oid
            .clone();

        fs::write(repository.join("conflict.txt"), "current\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Current"]);
        let error = pop_stash(repository, &oid, false).unwrap_err();
        assert_eq!(error.code, "stash_pop_conflict");
        assert!(status(repository)
            .unwrap()
            .changes
            .iter()
            .any(|change| matches!(change.kind, ChangeKind::Unmerged)));
        assert_eq!(repository_stashes(repository).unwrap().stashes.len(), 1);
    }

    #[test]
    fn validates_stash_creation_boundaries_and_keep_index() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("draft.txt"), "draft\n").unwrap();

        let no_head = create_stash(
            repository,
            &StashCreateInput {
                message: None,
                include_untracked: true,
                keep_index: false,
            },
        )
        .unwrap_err();
        assert_eq!(no_head.code, "stash_initial_commit_required");

        run_git(repository, &["add", "draft.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("draft.txt"), "staged\n").unwrap();
        run_git(repository, &["add", "draft.txt"]);

        for message in [
            "   ".to_owned(),
            "line one\nline two".to_owned(),
            "x".repeat(501),
        ] {
            let error = create_stash(
                repository,
                &StashCreateInput {
                    message: Some(message),
                    include_untracked: false,
                    keep_index: true,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid_stash_message");
        }

        create_stash(
            repository,
            &StashCreateInput {
                message: Some("Keep staged work".to_owned()),
                include_untracked: false,
                keep_index: true,
            },
        )
        .unwrap();
        let current = status(repository).unwrap();
        assert_eq!(current.changes.len(), 1);
        assert_eq!(current.changes[0].index_status.as_deref(), Some("M"));
    }

    #[test]
    fn sanitizes_url_credentials_and_query_values() {
        assert_eq!(
            sanitize_remote_url("https://user:secret@example.com/org/repo.git?token=hidden"),
            "https://example.com/org/repo.git"
        );
        assert_eq!(
            sanitize_remote_url("git@example.com:org/repo.git"),
            "git@example.com:org/repo.git"
        );
    }

    #[test]
    fn parses_only_structured_fetch_progress() {
        assert_eq!(
            parse_progress_percent("Receiving objects: 64% (64/100)"),
            Some(64)
        );
        assert_eq!(
            parse_progress_percent("remote: Enumerating objects: 3"),
            None
        );

        let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = Arc::clone(&updates);
        emit_fetch_progress(b"Receiving objects: 64% (64/100)", &move |update| {
            captured.lock().unwrap().push(update)
        });
        emit_fetch_progress(
            b"fatal: https://user:secret@example.com/repo.git?token=hidden",
            &move |_| panic!("sensitive unstructured stderr must not be emitted"),
        );

        assert_eq!(
            updates.lock().unwrap().as_slice(),
            &[FetchProgress {
                phase: "receiving".to_owned(),
                percent: Some(64),
                message: "正在接收远端对象".to_owned(),
            }]
        );
    }

    #[test]
    fn fetches_only_existing_remotes_and_honors_pre_cancel() {
        let directory = tempdir().unwrap();
        let remote = directory.path().join("remote.git");
        let source = directory.path().join("source");
        let client = directory.path().join("client");
        fs::create_dir(&remote).unwrap();
        fs::create_dir(&source).unwrap();
        run_git(&remote, &["init", "--bare", "--quiet"]);
        initialize_repository(&source);
        fs::write(source.join("base.txt"), "base\n").unwrap();
        run_git(&source, &["add", "base.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Base"]);
        let branch = status(&source).unwrap().branch.head.unwrap();
        run_git(
            &source,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        run_git(
            directory.path(),
            &[
                "clone",
                "--quiet",
                "--branch",
                &branch,
                remote.to_str().unwrap(),
                client.to_str().unwrap(),
            ],
        );

        fs::write(source.join("second.txt"), "second\n").unwrap();
        run_git(&source, &["add", "second.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Second"]);
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );

        fetch_remote(
            &client,
            "origin",
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
        let source_oid = execute(Some(&source), &["rev-parse", "HEAD"]).unwrap();
        let fetched_oid = execute(
            Some(&client),
            &["rev-parse", &format!("refs/remotes/origin/{branch}")],
        )
        .unwrap();
        assert_eq!(source_oid.stdout, fetched_oid.stdout);

        let missing = fetch_remote(
            &client,
            "missing",
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(missing.code, "remote_not_found");

        let cancelled = fetch_remote(
            &client,
            "origin",
            Arc::new(AtomicBool::new(true)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(cancelled.code, "git_operation_cancelled");
    }

    #[test]
    fn pushes_the_current_branch_to_its_upstream() {
        let directory = tempdir().unwrap();
        let (remote, _, client, branch) = initialize_remote_clone(directory.path());

        fs::write(client.join("pushed.txt"), "pushed\n").unwrap();
        run_git(&client, &["add", "pushed.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Push"]);

        push_current_branch(&client, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).unwrap();

        let remote_oid = execute(
            Some(&remote),
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
        .unwrap();
        let client_oid = execute(Some(&client), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(remote_oid.stdout, client_oid.stdout);
    }

    #[test]
    fn publishes_a_new_remote_branch_and_sets_upstream() {
        let directory = tempdir().unwrap();
        let remote = directory.path().join("remote.git");
        let client = directory.path().join("client");
        fs::create_dir(&remote).unwrap();
        fs::create_dir(&client).unwrap();
        run_git(&remote, &["init", "--bare", "--quiet"]);
        initialize_repository(&client);
        fs::write(client.join("base.txt"), "base\n").unwrap();
        run_git(&client, &["add", "base.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Base"]);
        run_git(
            &client,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let local_oid = git_stdout(&client, &["rev-parse", "HEAD"]);

        publish_current_branch(
            &client,
            &PublishBranchInput {
                local_full_name: git_stdout(&client, &["symbolic-ref", "HEAD"]),
                remote_name: "origin".to_owned(),
                remote_branch_name: "feature/published".to_owned(),
                expected_local_oid: local_oid.clone(),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();

        assert_eq!(
            git_stdout(&remote, &["rev-parse", "refs/heads/feature/published"]),
            local_oid
        );
        assert_eq!(
            git_stdout(&client, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/feature/published"
        );
    }

    #[test]
    fn pushes_to_a_selected_existing_remote_branch_and_sets_upstream() {
        let directory = tempdir().unwrap();
        let (remote, _, client, branch) = initialize_remote_clone(directory.path());
        let remote_oid = git_stdout(&remote, &["rev-parse", &format!("refs/heads/{branch}")]);
        fs::write(client.join("selected-target.txt"), "selected target\n").unwrap();
        run_git(&client, &["add", "selected-target.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Selected target"]);
        let local_oid = git_stdout(&client, &["rev-parse", "HEAD"]);

        push_current_branch_to_target(
            &client,
            &PushBranchTargetInput {
                local_full_name: git_stdout(&client, &["symbolic-ref", "HEAD"]),
                remote_name: "origin".to_owned(),
                remote_branch_name: branch.clone(),
                expected_local_oid: local_oid.clone(),
                expected_remote_oid: Some(remote_oid),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();

        assert_eq!(
            git_stdout(&remote, &["rev-parse", &format!("refs/heads/{branch}")]),
            local_oid
        );
        assert_eq!(
            git_stdout(&client, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            format!("origin/{branch}")
        );
    }

    #[test]
    fn selected_push_creates_only_absent_targets_and_refuses_stale_snapshots() {
        let directory = tempdir().unwrap();
        let (remote, source, client, branch) = initialize_remote_clone(directory.path());
        fs::write(client.join("local.txt"), "local\n").unwrap();
        run_git(&client, &["add", "local.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Local"]);
        let local_full_name = git_stdout(&client, &["symbolic-ref", "HEAD"]);
        let local_oid = git_stdout(&client, &["rev-parse", "HEAD"]);

        let existing_as_new = push_current_branch_to_target(
            &client,
            &PushBranchTargetInput {
                local_full_name: local_full_name.clone(),
                remote_name: "origin".to_owned(),
                remote_branch_name: branch.clone(),
                expected_local_oid: local_oid.clone(),
                expected_remote_oid: None,
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(existing_as_new.code, "push_target_exists");

        let stale_remote_oid = git_stdout(&remote, &["rev-parse", &format!("refs/heads/{branch}")]);
        fs::write(source.join("remote.txt"), "remote\n").unwrap();
        run_git(&source, &["add", "remote.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Remote"]);
        run_git(&source, &["push", "--quiet", "origin", &branch]);
        let stale = push_current_branch_to_target(
            &client,
            &PushBranchTargetInput {
                local_full_name,
                remote_name: "origin".to_owned(),
                remote_branch_name: branch,
                expected_local_oid: local_oid,
                expected_remote_oid: Some(stale_remote_oid),
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(stale.code, "push_target_changed");
    }

    #[test]
    fn publish_branch_refuses_stale_local_and_existing_remote_branches() {
        let directory = tempdir().unwrap();
        let remote = directory.path().join("remote.git");
        let client = directory.path().join("client");
        fs::create_dir(&remote).unwrap();
        fs::create_dir(&client).unwrap();
        run_git(&remote, &["init", "--bare", "--quiet"]);
        initialize_repository(&client);
        fs::write(client.join("base.txt"), "base\n").unwrap();
        run_git(&client, &["add", "base.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Base"]);
        run_git(
            &client,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let local_oid = git_stdout(&client, &["rev-parse", "HEAD"]);
        let input = PublishBranchInput {
            local_full_name: git_stdout(&client, &["symbolic-ref", "HEAD"]),
            remote_name: "origin".to_owned(),
            remote_branch_name: "feature/published".to_owned(),
            expected_local_oid: local_oid.clone(),
        };

        let stale = publish_current_branch(
            &client,
            &PublishBranchInput {
                expected_local_oid: "f".repeat(40),
                ..input.clone()
            },
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(stale.code, "publish_local_branch_changed");

        let original_branch = git_stdout(&client, &["branch", "--show-current"]);
        run_git(&client, &["switch", "--quiet", "-c", "other-local"]);
        let switched = publish_current_branch(
            &client,
            &input,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(switched.code, "publish_local_branch_changed");
        run_git(&client, &["switch", "--quiet", "--", &original_branch]);

        publish_current_branch(
            &client,
            &input,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
        run_git(&client, &["branch", "--unset-upstream"]);
        let existing = publish_current_branch(
            &client,
            &input,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(existing.code, "publish_remote_branch_exists");
    }

    #[test]
    fn push_requires_upstream_and_refuses_non_fast_forward() {
        let standalone = tempdir().unwrap();
        initialize_repository(standalone.path());
        fs::write(standalone.path().join("base.txt"), "base\n").unwrap();
        run_git(standalone.path(), &["add", "base.txt"]);
        run_git(standalone.path(), &["commit", "--quiet", "-m", "Base"]);
        let no_upstream = push_current_branch(
            standalone.path(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(no_upstream.code, "push_no_upstream");

        let directory = tempdir().unwrap();
        let (remote, source, client, branch) = initialize_remote_clone(directory.path());
        fs::write(source.join("remote.txt"), "remote\n").unwrap();
        run_git(&source, &["add", "remote.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Remote"]);
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        fs::write(client.join("local.txt"), "local\n").unwrap();
        run_git(&client, &["add", "local.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Local"]);

        let rejected =
            push_current_branch(&client, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}))
                .unwrap_err();
        assert_eq!(rejected.code, "push_non_fast_forward");
        let remote_oid = execute(
            Some(&remote),
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
        .unwrap();
        let source_oid = execute(Some(&source), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(remote_oid.stdout, source_oid.stdout);
    }

    #[test]
    fn pulls_the_current_branch_by_fast_forward() {
        let directory = tempdir().unwrap();
        let (_, source, client, branch) = initialize_remote_clone(directory.path());

        fs::write(source.join("second.txt"), "second\n").unwrap();
        run_git(&source, &["add", "second.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Second"]);
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );

        pull_fast_forward(&client, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).unwrap();

        let source_oid = execute(Some(&source), &["rev-parse", "HEAD"]).unwrap();
        let client_oid = execute(Some(&client), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(source_oid.stdout, client_oid.stdout);
        assert_eq!(
            fs::read_to_string(client.join("second.txt")).unwrap(),
            "second\n"
        );
    }

    #[test]
    fn pull_requires_upstream_and_refuses_divergent_history() {
        let standalone = tempdir().unwrap();
        initialize_repository(standalone.path());
        fs::write(standalone.path().join("base.txt"), "base\n").unwrap();
        run_git(standalone.path(), &["add", "base.txt"]);
        run_git(standalone.path(), &["commit", "--quiet", "-m", "Base"]);
        let no_upstream = pull_fast_forward(
            standalone.path(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap_err();
        assert_eq!(no_upstream.code, "pull_no_upstream");

        let directory = tempdir().unwrap();
        let (_, source, client, branch) = initialize_remote_clone(directory.path());
        fs::write(source.join("remote.txt"), "remote\n").unwrap();
        run_git(&source, &["add", "remote.txt"]);
        run_git(&source, &["commit", "--quiet", "-m", "Remote"]);
        run_git(
            &source,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        fs::write(client.join("local.txt"), "local\n").unwrap();
        run_git(&client, &["add", "local.txt"]);
        run_git(&client, &["commit", "--quiet", "-m", "Local"]);
        let before = execute(Some(&client), &["rev-parse", "HEAD"]).unwrap();

        let divergent =
            pull_fast_forward(&client, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}))
                .unwrap_err();
        assert_eq!(divergent.code, "pull_non_fast_forward");
        let after = execute(Some(&client), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(before.stdout, after.stdout);
        run_git_expect_failure(&client, &["rev-parse", "--verify", "MERGE_HEAD"]);
    }

    #[test]
    fn history_and_commit_details_use_real_git_output() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("before.txt"), "first line\n").unwrap();
        run_git(repository, &["add", "before.txt"]);
        run_git(
            repository,
            &[
                "commit",
                "--quiet",
                "-m",
                "Initial commit",
                "-m",
                "Initial body",
            ],
        );

        run_git(repository, &["mv", "before.txt", "after.txt"]);
        run_git(
            repository,
            &["commit", "--quiet", "-m", "Rename tracked file"],
        );

        let history_page = commit_history(repository, &history_query(0, 10)).unwrap();
        assert!(!history_page.has_more);
        assert_eq!(history_page.next_offset, 2);
        let history = history_page.commits;
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].subject, "Rename tracked file");
        assert_eq!(history[1].subject, "Initial commit");
        assert_eq!(history[0].parent_oids.len(), 1);

        let second_page = commit_history(repository, &history_query(1, 1)).unwrap();
        assert_eq!(second_page.commits.len(), 1);
        assert_eq!(second_page.commits[0].subject, "Initial commit");
        assert!(!second_page.has_more);
        assert_eq!(second_page.next_offset, 2);

        let details = commit_details(repository, &history[0].oid).unwrap();
        assert_eq!(details.commit.oid, history[0].oid);
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].path, "after.txt");
        assert_eq!(
            details.files[0].original_path.as_deref(),
            Some("before.txt")
        );
        assert!(details
            .patch
            .contains("diff --git a/before.txt b/after.txt"));
        assert!(!details.patch_truncated);

        let initial = commit_details(repository, &history[1].oid).unwrap();
        assert_eq!(initial.body.trim(), "Initial body");
    }

    #[test]
    fn bounded_commit_files_reject_truncated_and_excessive_lists() {
        let truncated = parse_bounded_commit_files(LimitedOutput {
            stdout: Vec::new(),
            truncated: true,
        })
        .unwrap_err();
        assert_eq!(truncated.code, "commit_file_list_too_large");

        let excessive = parse_bounded_commit_files(LimitedOutput {
            stdout: b"M\0a\0".repeat(MAX_COMMIT_FILES + 1),
            truncated: false,
        })
        .unwrap_err();
        assert_eq!(excessive.code, "too_many_commit_files");
    }

    #[test]
    fn commit_metadata_rejects_output_above_the_hard_limit() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("tracked.txt"), "content\n").unwrap();
        fs::write(
            repository.join("message.txt"),
            "x".repeat(MAX_COMMIT_DETAILS_OUTPUT_BYTES + 1024),
        )
        .unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-F", "message.txt"]);

        let error = commit_summary_and_body(repository, "HEAD").unwrap_err();
        assert_eq!(error.code, "commit_metadata_too_large");
    }

    #[test]
    fn history_is_empty_before_the_first_commit() {
        let directory = tempdir().unwrap();
        initialize_repository(directory.path());
        let page = commit_history(directory.path(), &history_query(7, 10)).unwrap();
        assert!(page.commits.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.next_offset, 7);
    }

    #[test]
    fn safely_amends_head_with_staged_changes_and_preserves_author_and_parents() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git_with_dates(
            repository,
            &[
                "commit",
                "--quiet",
                "--author",
                "Original Author <author@example.invalid>",
                "-m",
                "Original subject",
                "-m",
                "Original body",
            ],
            "2026-08-15T09:30:00+08:00",
        );
        let original = commit_summary(repository, "HEAD").unwrap();
        fs::write(repository.join("staged.txt"), "included\n").unwrap();
        run_git(repository, &["add", "staged.txt"]);

        let namespace = Uuid::new_v4();
        let preview = preview_amend_commit(repository, &namespace).unwrap();
        assert_eq!(preview.head_oid, original.oid);
        assert_eq!(preview.current_subject, "Original subject");
        assert_eq!(preview.current_body.trim(), "Original body");
        assert_eq!(preview.staged_change_count, 1);
        assert!(preview.can_amend);

        let (previous_oid, amended) = amend_commit(
            repository,
            &AmendCommitInput {
                subject: "Updated subject".to_owned(),
                body: "Updated body".to_owned(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        assert_eq!(previous_oid, original.oid);
        assert_ne!(amended.oid, previous_oid);
        assert_eq!(amended.parent_oids, original.parent_oids);
        assert_eq!(amended.author_name, "Original Author");
        assert_eq!(amended.author_email, "author@example.invalid");
        assert_eq!(amended.authored_at, original.authored_at);
        assert_eq!(amended.subject, "Updated subject");
        let (_, body) = commit_summary_and_body(repository, "HEAD").unwrap();
        assert_eq!(body.trim(), "Updated body");
        assert_eq!(
            git_stdout(repository, &["show", "HEAD:staged.txt"]),
            "included"
        );
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn message_only_amend_keeps_the_existing_tree() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Before"]);
        let original_tree = git_stdout(repository, &["rev-parse", "HEAD^{tree}"]);
        let namespace = Uuid::new_v4();
        let preview = preview_amend_commit(repository, &namespace).unwrap();
        assert_eq!(preview.staged_change_count, 0);

        amend_commit(
            repository,
            &AmendCommitInput {
                subject: "After".to_owned(),
                body: String::new(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        assert_eq!(
            git_stdout(repository, &["rev-parse", "HEAD^{tree}"]),
            original_tree
        );
        assert_eq!(commit_summary(repository, "HEAD").unwrap().subject, "After");
    }

    #[test]
    fn rejects_stale_amend_tokens_without_moving_head() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let namespace = Uuid::new_v4();
        let preview = preview_amend_commit(repository, &namespace).unwrap();
        let before = git_stdout(repository, &["rev-parse", "HEAD"]);
        fs::write(repository.join("later.txt"), "later\n").unwrap();
        run_git(repository, &["add", "later.txt"]);

        let error = amend_commit(
            repository,
            &AmendCommitInput {
                subject: "Unsafe".to_owned(),
                body: String::new(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(error.code, "amend_snapshot_changed");
        assert_eq!(git_stdout(repository, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn rejects_an_index_tree_captured_during_a_stage_and_restore_race() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("previewed.txt"), "previewed\n").unwrap();
        run_git(repository, &["add", "previewed.txt"]);

        let namespace = Uuid::new_v4();
        let previewed = amend_commit_snapshot(repository, &namespace).unwrap();
        fs::write(repository.join("surprise.txt"), "surprise\n").unwrap();
        run_git(repository, &["add", "surprise.txt"]);
        let raced_tree = write_index_tree(repository).unwrap();
        run_git(
            repository,
            &["reset", "--quiet", "HEAD", "--", "surprise.txt"],
        );
        let restored = amend_commit_snapshot(repository, &namespace).unwrap();

        assert_eq!(restored.token, previewed.token);
        assert_eq!(restored.index_tree_oid, previewed.index_tree_oid);
        assert_ne!(raced_tree, previewed.index_tree_oid);
        assert_eq!(
            ensure_amend_tree_matches(&restored, &raced_tree)
                .unwrap_err()
                .code,
            "amend_snapshot_changed"
        );
    }

    #[test]
    fn blocks_amend_for_published_tagged_detached_or_in_progress_head() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let namespace = Uuid::new_v4();

        run_git(
            repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        let published = preview_amend_commit(repository, &namespace).unwrap();
        assert!(!published.can_amend);
        assert_eq!(published.blocking_refs, vec!["refs/remotes/origin/main"]);
        let error = amend_commit(
            repository,
            &AmendCommitInput {
                subject: "Blocked".to_owned(),
                body: String::new(),
                expected_token: published.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(error.code, "amend_head_is_published");

        run_git(
            repository,
            &["update-ref", "-d", "refs/remotes/origin/main"],
        );
        run_git(repository, &["tag", "v1.0.0"]);
        let tagged = preview_amend_commit(repository, &namespace).unwrap();
        assert_eq!(tagged.blocking_refs, vec!["refs/tags/v1.0.0"]);
        run_git(repository, &["tag", "-d", "v1.0.0"]);

        let marker = git_state_path(repository, "CHERRY_PICK_HEAD").unwrap();
        fs::write(&marker, git_stdout(repository, &["rev-parse", "HEAD"])).unwrap();
        let in_progress = preview_amend_commit(repository, &namespace).unwrap_err();
        assert_eq!(in_progress.code, "amend_operation_in_progress");
        fs::remove_file(marker).unwrap();

        run_git(repository, &["checkout", "--quiet", "--detach"]);
        let detached = preview_amend_commit(repository, &namespace).unwrap_err();
        assert_eq!(detached.code, "amend_detached_head");
    }

    #[test]
    fn history_pagination_reports_more_results_and_next_offset() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        for index in 1..=3 {
            fs::write(repository.join("history.txt"), format!("{index}\n")).unwrap();
            run_git(repository, &["add", "history.txt"]);
            run_git(
                repository,
                &["commit", "--quiet", "-m", &format!("Commit {index}")],
            );
        }

        let first_page = commit_history(repository, &history_query(0, 2)).unwrap();
        assert_eq!(first_page.commits.len(), 2);
        assert_eq!(first_page.commits[0].subject, "Commit 3");
        assert_eq!(first_page.commits[1].subject, "Commit 2");
        assert!(first_page.has_more);
        assert_eq!(first_page.next_offset, 2);

        let second_page =
            commit_history(repository, &history_query(first_page.next_offset, 2)).unwrap();
        assert_eq!(second_page.commits.len(), 1);
        assert_eq!(second_page.commits[0].subject, "Commit 1");
        assert!(!second_page.has_more);
        assert_eq!(second_page.next_offset, 3);
    }

    #[test]
    fn automatic_history_includes_the_current_branch_upstream() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let main_branch = git_stdout(repository, &["branch", "--show-current"]);
        let local_oid = git_stdout(repository, &["rev-parse", "HEAD"]);

        fs::write(repository.join("remote.txt"), "remote\n").unwrap();
        run_git(repository, &["add", "remote.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Remote only"]);
        run_git(
            repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run_git(repository, &["reset", "--quiet", "--hard", &local_oid]);
        run_git(repository, &["config", "remote.origin.url", "unused"]);
        run_git(
            repository,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        run_git(
            repository,
            &["config", &format!("branch.{main_branch}.remote"), "origin"],
        );
        run_git(
            repository,
            &[
                "config",
                &format!("branch.{main_branch}.merge"),
                "refs/heads/main",
            ],
        );

        let page = commit_history(repository, &history_query(0, 10)).unwrap();
        assert_eq!(
            page.commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["Remote only", "Base"]
        );
    }

    #[test]
    fn history_filters_message_author_date_and_literal_path() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("alpha.txt"), "alpha\n").unwrap();
        run_git(repository, &["add", "alpha.txt"]);
        run_git_with_dates(
            repository,
            &[
                "commit",
                "--quiet",
                "--author",
                "Alice Example <alice@example.invalid>",
                "-m",
                "Alpha [literal]",
            ],
            "2026-08-14T09:00:00+08:00",
        );

        fs::write(repository.join("beta.txt"), "beta\n").unwrap();
        run_git(repository, &["add", "beta.txt"]);
        run_git_with_dates(
            repository,
            &[
                "commit",
                "--quiet",
                "--author",
                "Bob Example <bob@example.invalid>",
                "-m",
                "Beta release",
            ],
            "2026-08-16T09:00:00+08:00",
        );

        let mut query = history_query(0, 10);
        query.search = "[literal]".to_owned();
        let message_page = commit_history(repository, &query).unwrap();
        assert_eq!(message_page.commits.len(), 1);
        assert_eq!(message_page.commits[0].subject, "Alpha [literal]");

        query.search.clear();
        query.author = "ALICE@EXAMPLE.INVALID".to_owned();
        let author_page = commit_history(repository, &query).unwrap();
        assert_eq!(author_page.commits.len(), 1);
        assert_eq!(author_page.commits[0].author_name, "Alice Example");

        query.author.clear();
        query.after = Some("2026-08-15".to_owned());
        query.before = Some("2026-08-16".to_owned());
        let date_page = commit_history(repository, &query).unwrap();
        assert_eq!(date_page.commits.len(), 1);
        assert_eq!(date_page.commits[0].subject, "Beta release");

        query.after = None;
        query.before = None;
        query.file_path = Some("alpha.txt".to_owned());
        let path_page = commit_history(repository, &query).unwrap();
        assert_eq!(path_page.commits.len(), 1);
        assert_eq!(path_page.commits[0].subject, "Alpha [literal]");
    }

    #[test]
    fn history_can_be_scoped_to_an_existing_full_ref_only() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let base_oid = git_stdout(repository, &["rev-parse", "HEAD"]);
        let main_branch = git_stdout(repository, &["branch", "--show-current"]);

        run_git(repository, &["branch", "topic", &base_oid]);
        run_git(repository, &["switch", "--quiet", "topic"]);
        fs::write(repository.join("topic.txt"), "topic\n").unwrap();
        run_git(repository, &["add", "topic.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Topic only"]);

        run_git(repository, &["switch", "--quiet", &main_branch]);
        fs::write(repository.join("main.txt"), "main\n").unwrap();
        run_git(repository, &["add", "main.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Main only"]);

        let mut topic_query = history_query(0, 10);
        topic_query.ref_full_name = Some("refs/heads/topic".to_owned());
        let topic_page = commit_history(repository, &topic_query).unwrap();
        assert_eq!(
            topic_page
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["Topic only", "Base"]
        );

        topic_query.ref_full_name = Some("HEAD~1".to_owned());
        assert_eq!(
            commit_history(repository, &topic_query).unwrap_err().code,
            "invalid_history_ref"
        );

        topic_query.ref_full_name = Some("refs/heads/no-longer-here".to_owned());
        assert_eq!(
            commit_history(repository, &topic_query).unwrap_err().code,
            "history_ref_not_found"
        );
    }

    #[test]
    fn history_rejects_output_above_the_hard_limit() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("tracked.txt"), "content\n").unwrap();
        fs::write(
            repository.join("message.txt"),
            "x".repeat(MAX_HISTORY_OUTPUT_BYTES + 1024),
        )
        .unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-F", "message.txt"]);

        let error = commit_history(repository, &history_query(0, 1)).unwrap_err();
        assert_eq!(error.code, "history_output_too_large");
    }

    #[test]
    fn history_rejects_invalid_query_boundaries() {
        let directory = tempdir().unwrap();
        initialize_repository(directory.path());

        let mut query = history_query(0, 0);
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_limit"
        );

        query.limit = 10;
        query.offset = u32::MAX;
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_offset"
        );

        query.offset = 0;
        query.search = "x".repeat(MAX_HISTORY_TEXT_QUERY_CHARS + 1);
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_query"
        );

        query.search = "bad\nquery".to_owned();
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_query"
        );

        query.search.clear();
        query.after = Some("2026-02-29".to_owned());
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_date"
        );

        query.after = Some("2026-08-17".to_owned());
        query.before = Some("2026-08-16".to_owned());
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_history_date_range"
        );

        query.after = None;
        query.before = None;
        query.file_path = Some("../outside.txt".to_owned());
        assert_eq!(
            commit_history(directory.path(), &query).unwrap_err().code,
            "invalid_repository_pathspec"
        );
    }

    #[test]
    fn merge_commit_details_use_the_first_parent_diff() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        run_git(repository, &["checkout", "--quiet", "-b", "feature"]);
        fs::write(repository.join("feature.txt"), "feature\n").unwrap();
        run_git(repository, &["add", "feature.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Feature"]);

        run_git(repository, &["checkout", "--quiet", "-"]);
        fs::write(repository.join("main.txt"), "main\n").unwrap();
        run_git(repository, &["add", "main.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Main"]);
        run_git(
            repository,
            &["merge", "--quiet", "--no-ff", "--no-edit", "feature"],
        );

        let merge_commit = commit_history(repository, &history_query(0, 1))
            .unwrap()
            .commits
            .remove(0);
        assert_eq!(merge_commit.parent_oids.len(), 2);

        let details = commit_details(repository, &merge_commit.oid).unwrap();
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].status, "A");
        assert_eq!(details.files[0].path, "feature.txt");
        assert!(details
            .patch
            .contains("diff --git a/feature.txt b/feature.txt"));
        assert!(!details.patch.contains("main.txt"));
    }

    #[test]
    fn reads_image_diffs_for_commits_and_worktree_files() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        let png = b"\x89PNG\r\n\x1a\nmock-png";
        fs::write(repository.join("image.png"), png).unwrap();
        run_git(repository, &["add", "image.png"]);
        run_git(repository, &["commit", "--quiet", "-m", "Add image"]);
        let first_oid = exact_commit_oid(repository, "HEAD").unwrap();

        let first_diff = commit_image_diff(repository, &first_oid, "image.png", None)
            .unwrap()
            .expect("new image diff");
        assert!(first_diff.old.is_none());
        assert_eq!(first_diff.new.as_ref().unwrap().mime_type, "image/png");
        assert!(first_diff
            .new
            .as_ref()
            .unwrap()
            .data_url
            .starts_with("data:image/png;base64,"));

        fs::write(repository.join("image.png"), b"\x89PNG\r\n\x1a\nnext-png").unwrap();
        run_git(repository, &["add", "image.png"]);
        run_git(repository, &["commit", "--quiet", "-m", "Update image"]);
        let second_oid = exact_commit_oid(repository, "HEAD").unwrap();
        let second_diff = commit_image_diff(repository, &second_oid, "image.png", None)
            .unwrap()
            .expect("changed image diff");
        assert!(second_diff.old.is_some());
        assert!(second_diff.new.is_some());

        fs::write(repository.join("draft.png"), png).unwrap();
        let worktree = worktree_diff(repository, "draft.png", false).unwrap();
        assert_eq!(
            worktree
                .image
                .as_ref()
                .unwrap()
                .new
                .as_ref()
                .unwrap()
                .mime_type,
            "image/png"
        );
    }

    #[test]
    fn reads_worktree_diffs_for_tracked_untracked_and_staged_files() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("tracked.txt"), "base\nchanged\n").unwrap();
        fs::write(repository.join("untracked.txt"), "draft\n").unwrap();

        let tracked = worktree_diff(repository, "tracked.txt", false).unwrap();
        assert!(tracked.patch.contains("+changed"));
        assert!(!tracked.patch_truncated);

        let untracked = worktree_diff(repository, "untracked.txt", false).unwrap();
        assert!(untracked.patch.contains("+draft"));
        assert!(!untracked.patch_truncated);

        stage(repository, &["tracked.txt".to_owned()]).unwrap();
        let staged = worktree_diff(repository, "tracked.txt", true).unwrap();
        assert!(staged.patch.contains("+changed"));
        assert!(worktree_diff(repository, "tracked.txt", false)
            .unwrap()
            .patch
            .is_empty());
    }

    #[test]
    fn stages_unstages_and_creates_a_commit() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("first.txt"), "first\n").unwrap();
        stage_all(repository).unwrap();
        let staged_status = status(repository).unwrap();
        assert_eq!(staged_status.changes[0].index_status.as_deref(), Some("A"));

        unstage_all(repository).unwrap();
        let unstaged_status = status(repository).unwrap();
        assert!(unstaged_status.changes[0].index_status.is_none());
        assert!(matches!(
            unstaged_status.changes[0].kind,
            ChangeKind::Untracked
        ));

        stage(repository, &["first.txt".to_owned()]).unwrap();
        let commit = create_commit(
            repository,
            &CommitInput {
                subject: "Create first file".to_owned(),
                body: "Commit body".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(commit.subject, "Create first file");
        assert!(status(repository).unwrap().changes.is_empty());

        let details = commit_details(repository, &commit.oid).unwrap();
        assert_eq!(details.body.trim(), "Commit body");

        fs::write(repository.join("first.txt"), "first\nsecond\n").unwrap();
        stage(repository, &["first.txt".to_owned()]).unwrap();
        unstage(repository, &["first.txt".to_owned()]).unwrap();
        let status = status(repository).unwrap();
        assert!(status.changes[0].index_status.is_none());
        assert_eq!(status.changes[0].worktree_status.as_deref(), Some("M"));
    }

    #[test]
    fn parses_only_well_formed_conflict_index_records() {
        let sha1 = "a".repeat(40);
        let sha256 = "b".repeat(64);
        let output = format!(
            "100644 {sha1} 1\tconflict.txt\0\
             100755 {sha1} 2\tconflict.txt\0\
             120000 {sha256} 3\tconflict.txt\0"
        );
        let (current, incoming) = parse_conflict_stages(output.as_bytes(), "conflict.txt").unwrap();
        assert_eq!(current.unwrap().mode, "100755");
        assert_eq!(incoming.unwrap().oid, sha256);

        for malformed in [
            format!("10064 {sha1} 2\tconflict.txt\0"),
            format!("100648 {sha1} 2\tconflict.txt\0"),
            "100644 deadbeef 2\tconflict.txt\0".to_owned(),
            format!("100644 {} 2\tconflict.txt\0", "g".repeat(40)),
        ] {
            let error = parse_conflict_stages(malformed.as_bytes(), "conflict.txt").unwrap_err();
            assert_eq!(error.code, "invalid_git_output");
        }
    }

    #[test]
    fn identifies_gitlink_conflicts_as_unsupported() {
        let snapshot = ConflictSnapshot {
            path: "module".to_owned(),
            current: Some(ConflictStage {
                mode: "160000".to_owned(),
                oid: "a".repeat(40),
            }),
            incoming: None,
            token: Uuid::nil().to_string(),
        };
        assert_eq!(
            conflict_unsupported_reason(&snapshot),
            Some("暂不支持直接解决子模块冲突")
        );
    }

    #[test]
    fn merge_recovery_preview_is_absent_without_an_active_merge() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        assert!(preview_merge_recovery(repository, &Uuid::new_v4())
            .unwrap()
            .is_none());
    }

    #[test]
    fn merge_recovery_preview_reports_unresolved_conflicts() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_text_conflict(repository);

        let preview = preview_merge_recovery(repository, &Uuid::new_v4())
            .unwrap()
            .expect("conflicted merge should expose a recovery preview");

        assert_eq!(preview.unresolved_conflict_count, 1);
        assert!(preview.has_unstaged_changes);
        assert!(!preview.can_continue);
        assert_eq!(preview.head_oid.len(), 40);
        assert_eq!(preview.merge_head_oid.len(), 40);
        assert!(preview.current_branch.is_some());
    }

    #[test]
    fn merge_recovery_rejects_stale_tokens_after_resolution() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        let namespace = Uuid::new_v4();
        initialize_text_conflict(repository);
        let stale = preview_merge_recovery(repository, &namespace)
            .unwrap()
            .unwrap();

        fs::write(repository.join("conflict.txt"), "resolved\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        let input = MergeRecoveryInput {
            expected_token: stale.token,
        };

        for error in [
            continue_merge_recovery(repository, &input, &namespace).unwrap_err(),
            abort_merge_recovery(repository, &input, &namespace).unwrap_err(),
        ] {
            assert_eq!(error.code, "merge_recovery_changed");
        }
        assert!(merge_in_progress(repository).unwrap());
    }

    #[test]
    fn merge_recovery_continues_a_resolved_merge_without_interaction() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        let namespace = Uuid::new_v4();
        initialize_text_conflict(repository);

        fs::write(repository.join("conflict.txt"), "resolved\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        let preview = preview_merge_recovery(repository, &namespace)
            .unwrap()
            .unwrap();
        assert_eq!(preview.unresolved_conflict_count, 0);
        assert!(!preview.has_unstaged_changes);
        assert!(preview.can_continue);

        let bypass = create_commit(
            repository,
            &CommitInput {
                subject: "Bypass merge recovery".to_owned(),
                body: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(bypass.code, "merge_recovery_required");

        continue_merge_recovery(
            repository,
            &MergeRecoveryInput {
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        assert!(!merge_in_progress(repository).unwrap());
        assert!(status(repository).unwrap().changes.is_empty());
        let commit_line = git_stdout(repository, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(commit_line.split_whitespace().count(), 3);
        assert_eq!(
            fs::read_to_string(repository.join("conflict.txt")).unwrap(),
            "resolved\n"
        );
    }

    #[test]
    fn merge_recovery_aborts_to_the_pre_merge_head() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        let namespace = Uuid::new_v4();
        initialize_text_conflict(repository);
        let before_head = git_stdout(repository, &["rev-parse", "HEAD"]);
        let preview = preview_merge_recovery(repository, &namespace)
            .unwrap()
            .unwrap();

        abort_merge_recovery(
            repository,
            &MergeRecoveryInput {
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        assert!(!merge_in_progress(repository).unwrap());
        assert_eq!(git_stdout(repository, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(
            fs::read_to_string(repository.join("conflict.txt")).unwrap(),
            "current\n"
        );
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn merge_recovery_validates_tokens_conflicts_and_worktree_cleanliness() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        let namespace = Uuid::new_v4();
        initialize_text_conflict(repository);

        let invalid = continue_merge_recovery(
            repository,
            &MergeRecoveryInput {
                expected_token: "not-a-uuid".to_owned(),
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(invalid.code, "invalid_merge_recovery_token");

        let conflicted = preview_merge_recovery(repository, &namespace)
            .unwrap()
            .unwrap();
        let unresolved = continue_merge_recovery(
            repository,
            &MergeRecoveryInput {
                expected_token: conflicted.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(unresolved.code, "merge_conflicts_unresolved");

        fs::write(repository.join("conflict.txt"), "resolved\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        fs::write(repository.join("untracked.txt"), "local\n").unwrap();
        let dirty = preview_merge_recovery(repository, &namespace)
            .unwrap()
            .unwrap();
        assert_eq!(dirty.unresolved_conflict_count, 0);
        assert!(dirty.has_unstaged_changes);
        assert!(!dirty.can_continue);
        let error = continue_merge_recovery(
            repository,
            &MergeRecoveryInput {
                expected_token: dirty.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(error.code, "merge_worktree_not_clean");
        assert!(merge_in_progress(repository).unwrap());
    }

    #[test]
    fn reads_conflict_sides_and_resolves_current_or_incoming() {
        for (choice, expected) in [
            (ConflictResolutionChoice::Current, "current\n"),
            (ConflictResolutionChoice::Incoming, "incoming\n"),
        ] {
            let directory = tempdir().unwrap();
            let repository = directory.path();
            initialize_text_conflict(repository);

            let details = conflict_details(repository, "conflict.txt").unwrap();
            assert_eq!(details.current.content.as_deref(), Some("current\n"));
            assert_eq!(details.incoming.content.as_deref(), Some("incoming\n"));
            assert!(details.resolvable);
            assert!(!details.is_binary);
            assert!(!details.content_truncated);

            resolve_conflict(
                repository,
                "conflict.txt",
                &ConflictResolutionInput {
                    choice,
                    expected_token: details.token,
                },
            )
            .unwrap();

            assert_eq!(
                fs::read_to_string(repository.join("conflict.txt")).unwrap(),
                expected
            );
            let result = status(repository).unwrap();
            assert!(!has_unmerged_changes(&result));
            if matches!(choice, ConflictResolutionChoice::Incoming) {
                let resolved = result
                    .changes
                    .iter()
                    .find(|change| change.path == "conflict.txt")
                    .unwrap();
                assert!(resolved.index_status.is_some());
                assert!(resolved.worktree_status.is_none());
            } else {
                assert!(result
                    .changes
                    .iter()
                    .all(|change| change.path != "conflict.txt"));
            }
        }
    }

    #[test]
    fn resolving_a_missing_conflict_side_deletes_the_file() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("delete-me.txt"), "base\n").unwrap();
        run_git(repository, &["add", "delete-me.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        run_git(repository, &["checkout", "--quiet", "-b", "delete-side"]);
        run_git(repository, &["rm", "--quiet", "delete-me.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Delete"]);
        run_git(repository, &["checkout", "--quiet", "-"]);
        fs::write(repository.join("delete-me.txt"), "current\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Modify"]);
        run_git_expect_failure(repository, &["merge", "--no-edit", "delete-side"]);

        let details = conflict_details(repository, "delete-me.txt").unwrap();
        assert!(details.current.exists);
        assert!(!details.incoming.exists);
        resolve_conflict(
            repository,
            "delete-me.txt",
            &ConflictResolutionInput {
                choice: ConflictResolutionChoice::Incoming,
                expected_token: details.token,
            },
        )
        .unwrap();

        assert!(!repository.join("delete-me.txt").exists());
        assert!(!has_unmerged_changes(&status(repository).unwrap()));
    }

    #[test]
    fn rejects_stale_conflict_snapshots_without_mutating() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_text_conflict(repository);
        let details = conflict_details(repository, "conflict.txt").unwrap();
        fs::write(repository.join("conflict.txt"), "manually edited\n").unwrap();

        let error = resolve_conflict(
            repository,
            "conflict.txt",
            &ConflictResolutionInput {
                choice: ConflictResolutionChoice::Current,
                expected_token: details.token,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "conflict_snapshot_changed");
        assert_eq!(
            fs::read_to_string(repository.join("conflict.txt")).unwrap(),
            "manually edited\n"
        );
        assert!(has_unmerged_changes(&status(repository).unwrap()));
    }

    #[test]
    fn blocks_generic_index_and_commit_operations_while_conflicted() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_text_conflict(repository);
        let paths = ["conflict.txt".to_owned()];

        for error in [
            stage(repository, &paths).unwrap_err(),
            stage_all(repository).unwrap_err(),
            unstage(repository, &paths).unwrap_err(),
            unstage_all(repository).unwrap_err(),
            create_commit(
                repository,
                &CommitInput {
                    subject: "Unsafe commit".to_owned(),
                    body: String::new(),
                },
            )
            .unwrap_err(),
        ] {
            assert_eq!(error.code, "conflict_resolution_required");
        }
        assert!(has_unmerged_changes(&status(repository).unwrap()));
    }

    #[test]
    fn hides_binary_and_oversized_conflict_previews() {
        let binary = ConflictStage {
            mode: "100644".to_owned(),
            oid: String::new(),
        };
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("binary.bin"), [0_u8, 1, 2, 3]).unwrap();
        run_git(repository, &["hash-object", "-w", "binary.bin"]);
        let oid = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(repository)
                .args(["hash-object", "binary.bin"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let binary = ConflictStage {
            oid: oid.trim().to_owned(),
            ..binary
        };
        let preview = read_conflict_side(repository, Some(&binary)).unwrap();
        assert!(preview.is_binary);
        assert!(preview.side.content.is_none());

        let oversized_bytes = vec![b'x'; MAX_CONFLICT_PREVIEW_BYTES + 1];
        fs::write(repository.join("large.txt"), oversized_bytes).unwrap();
        run_git(repository, &["hash-object", "-w", "large.txt"]);
        let oid = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(repository)
                .args(["hash-object", "large.txt"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let large = ConflictStage {
            mode: "100644".to_owned(),
            oid: oid.trim().to_owned(),
        };
        let preview = read_conflict_side(repository, Some(&large)).unwrap();
        assert!(preview.content_truncated);
        assert!(preview.side.content.is_none());
    }

    #[test]
    fn discards_tracked_and_untracked_worktree_changes() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repository.join("untracked.txt"), "draft\n").unwrap();

        discard_files(
            repository,
            &["tracked.txt".to_owned(), "untracked.txt".to_owned()],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "base\n"
        );
        assert!(!repository.join("untracked.txt").exists());
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn batch_discard_validates_every_entry_before_mutating() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repository.join("untracked.txt"), "draft\n").unwrap();
        fs::write(repository.join("staged-only.txt"), "staged\n").unwrap();
        stage(repository, &["staged-only.txt".to_owned()]).unwrap();

        let error = discard_files(
            repository,
            &[
                "tracked.txt".to_owned(),
                "staged-only.txt".to_owned(),
                "untracked.txt".to_owned(),
            ],
        )
        .unwrap_err();

        assert_eq!(error.code, "unstaged_change_required");
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "changed\n"
        );
        assert!(repository.join("untracked.txt").exists());
        assert!(repository.join("staged-only.txt").exists());
    }

    #[test]
    fn discarding_worktree_changes_preserves_the_staged_version() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("both.txt"), "base\n").unwrap();
        run_git(repository, &["add", "both.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("both.txt"), "staged\n").unwrap();
        stage(repository, &["both.txt".to_owned()]).unwrap();
        fs::write(repository.join("both.txt"), "worktree\n").unwrap();

        discard_files(repository, &["both.txt".to_owned()]).unwrap();

        assert_eq!(
            fs::read_to_string(repository.join("both.txt")).unwrap(),
            "staged\n"
        );
        let result = status(repository).unwrap();
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].index_status.as_deref(), Some("M"));
        assert!(result.changes[0].worktree_status.is_none());
        assert!(worktree_diff(repository, "both.txt", true)
            .unwrap()
            .patch
            .contains("+staged"));
    }

    #[test]
    fn rejects_discard_for_conflicts_and_staged_only_changes() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);

        fs::write(repository.join("conflict.txt"), "base\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        run_git(repository, &["checkout", "--quiet", "-b", "conflict-side"]);
        fs::write(repository.join("conflict.txt"), "side\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Side"]);
        run_git(repository, &["checkout", "--quiet", "-"]);
        fs::write(repository.join("conflict.txt"), "main\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Main"]);
        run_git_expect_failure(repository, &["merge", "--no-edit", "conflict-side"]);

        let conflict_error = discard_files(repository, &["conflict.txt".to_owned()]).unwrap_err();
        assert_eq!(conflict_error.code, "conflict_discard_unsupported");

        run_git(repository, &["merge", "--abort"]);
        fs::write(repository.join("staged-only.txt"), "staged\n").unwrap();
        stage(repository, &["staged-only.txt".to_owned()]).unwrap();
        let staged_error = discard_files(repository, &["staged-only.txt".to_owned()]).unwrap_err();
        assert_eq!(staged_error.code, "unstaged_change_required");
        assert!(repository.join("staged-only.txt").exists());
    }

    #[test]
    fn rejects_pathspec_magic_and_parent_traversal() {
        let directory = tempdir().unwrap();
        initialize_repository(directory.path());

        for invalid in ["../outside.txt", ":(top)**", "/absolute.txt", ""] {
            let error = stage(directory.path(), &[invalid.to_owned()]).unwrap_err();
            assert_eq!(error.code, "invalid_repository_pathspec");

            let error = discard_files(directory.path(), &[invalid.to_owned()]).unwrap_err();
            assert_eq!(error.code, "invalid_repository_pathspec");
        }

        let empty_error = discard_files(directory.path(), &[]).unwrap_err();
        assert_eq!(empty_error.code, "invalid_repository_paths");

        let duplicate_error = discard_files(
            directory.path(),
            &["same.txt".to_owned(), "same.txt".to_owned()],
        )
        .unwrap_err();
        assert_eq!(duplicate_error.code, "duplicate_repository_path");

        let too_many = (0..=MAX_PATHS_PER_OPERATION)
            .map(|index| format!("file-{index}.txt"))
            .collect::<Vec<_>>();
        let too_many_error = discard_files(directory.path(), &too_many).unwrap_err();
        assert_eq!(too_many_error.code, "invalid_repository_paths");
    }

    #[test]
    fn refuses_to_commit_without_staged_changes() {
        let directory = tempdir().unwrap();
        initialize_repository(directory.path());
        let error = create_commit(
            directory.path(),
            &CommitInput {
                subject: "Nothing".to_owned(),
                body: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "nothing_to_commit");
    }

    #[test]
    fn previews_and_reverts_a_single_parent_commit_without_rewriting_history() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);

        fs::write(repository.join("second.txt"), "second\n").unwrap();
        run_git(repository, &["add", "second.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Second"]);
        let target_oid = exact_commit_oid(repository, "HEAD").unwrap();

        fs::write(repository.join("third.txt"), "third\n").unwrap();
        run_git(repository, &["add", "third.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Third"]);
        let before_oid = exact_commit_oid(repository, "HEAD").unwrap();
        let before_branch = status(repository).unwrap().branch.head.unwrap();

        let namespace = Uuid::new_v4();
        let preview = preview_revert(repository, &target_oid, &namespace).unwrap();
        assert_eq!(preview.current_branch, before_branch);
        assert_eq!(preview.current_oid, before_oid);
        assert_eq!(preview.target_oid, target_oid);
        assert_eq!(preview.target_subject, "Second");

        revert_commit(
            repository,
            &RevertCommitInput {
                target_oid: target_oid.clone(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        let after_oid = exact_commit_oid(repository, "HEAD").unwrap();
        assert_ne!(after_oid, before_oid);
        assert_eq!(status(repository).unwrap().branch.head, Some(before_branch));
        assert!(!repository.join("second.txt").exists());
        assert_eq!(
            fs::read_to_string(repository.join("third.txt")).unwrap(),
            "third\n"
        );
        assert!(is_ancestor(repository, &target_oid, &after_oid).unwrap());
        assert_eq!(
            commit_summary_and_body(repository, &after_oid)
                .unwrap()
                .0
                .subject,
            "Revert \"Second\""
        );
    }

    #[test]
    fn rejects_stale_revert_previews_and_dirty_worktrees() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("target.txt"), "target\n").unwrap();
        run_git(repository, &["add", "target.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Target"]);
        let target_oid = exact_commit_oid(repository, "HEAD").unwrap();

        let namespace = Uuid::new_v4();
        let preview = preview_revert(repository, &target_oid, &namespace).unwrap();
        fs::write(repository.join("later.txt"), "later\n").unwrap();
        run_git(repository, &["add", "later.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Later"]);
        let head_after_external_commit = exact_commit_oid(repository, "HEAD").unwrap();
        let stale = revert_commit(
            repository,
            &RevertCommitInput {
                target_oid: target_oid.clone(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap_err();
        assert_eq!(stale.code, "revert_snapshot_changed");
        assert_eq!(
            exact_commit_oid(repository, "HEAD").unwrap(),
            head_after_external_commit
        );

        fs::write(repository.join("dirty.txt"), "dirty\n").unwrap();
        let dirty = preview_revert(repository, &target_oid, &namespace).unwrap_err();
        assert_eq!(dirty.code, "revert_dirty_worktree");
    }

    #[test]
    fn rejects_revert_targets_outside_current_history() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let current_branch = status(repository).unwrap().branch.head.unwrap();

        run_git(repository, &["switch", "--quiet", "-c", "other"]);
        fs::write(repository.join("other.txt"), "other\n").unwrap();
        run_git(repository, &["add", "other.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Other"]);
        let other_oid = exact_commit_oid(repository, "HEAD").unwrap();
        run_git(repository, &["switch", "--quiet", &current_branch]);
        fs::write(repository.join("main.txt"), "main\n").unwrap();
        run_git(repository, &["add", "main.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Main"]);

        let error = preview_revert(repository, &other_oid, &Uuid::new_v4()).unwrap_err();
        assert_eq!(error.code, "revert_target_not_in_history");
    }

    #[test]
    fn rejects_root_and_merge_commit_reverts() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let root_oid = exact_commit_oid(repository, "HEAD").unwrap();
        let current_branch = status(repository).unwrap().branch.head.unwrap();

        run_git(repository, &["switch", "--quiet", "-c", "side"]);
        fs::write(repository.join("side.txt"), "side\n").unwrap();
        run_git(repository, &["add", "side.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Side"]);
        run_git(repository, &["switch", "--quiet", &current_branch]);
        fs::write(repository.join("main.txt"), "main\n").unwrap();
        run_git(repository, &["add", "main.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Main"]);
        run_git(repository, &["merge", "--quiet", "--no-edit", "side"]);
        let merge_oid = exact_commit_oid(repository, "HEAD").unwrap();
        let namespace = Uuid::new_v4();

        for target_oid in [root_oid, merge_oid] {
            let error = preview_revert(repository, &target_oid, &namespace).unwrap_err();
            assert_eq!(error.code, "revert_merge_commit_unsupported");
        }
    }

    #[test]
    fn aborts_a_conflicting_revert_and_restores_a_clean_repository() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("conflict.txt"), "base\n").unwrap();
        run_git(repository, &["add", "conflict.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("conflict.txt"), "target\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Target"]);
        let target_oid = exact_commit_oid(repository, "HEAD").unwrap();
        fs::write(repository.join("conflict.txt"), "later\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Later"]);
        let head_before = exact_commit_oid(repository, "HEAD").unwrap();

        let namespace = Uuid::new_v4();
        let preview = preview_revert(repository, &target_oid, &namespace).unwrap();
        let error = revert_commit(
            repository,
            &RevertCommitInput {
                target_oid,
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap_err();

        assert_eq!(error.code, "revert_conflict");
        assert_eq!(exact_commit_oid(repository, "HEAD").unwrap(), head_before);
        assert!(status(repository).unwrap().changes.is_empty());
        assert!(!git_state_path(repository, "REVERT_HEAD").unwrap().exists());
        assert_eq!(
            fs::read_to_string(repository.join("conflict.txt")).unwrap(),
            "later\n"
        );
    }

    #[test]
    fn previews_and_cherry_picks_a_single_parent_commit() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        let base_oid = exact_commit_oid(repository, "HEAD").unwrap();
        fs::write(repository.join("picked.txt"), "picked\n").unwrap();
        run_git(repository, &["add", "picked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Picked change"]);
        let target_oid = exact_commit_oid(repository, "HEAD").unwrap();
        run_git(
            repository,
            &["switch", "--quiet", "-c", "pick-target", &base_oid],
        );

        let namespace = Uuid::new_v4();
        let preview = preview_cherry_pick(repository, &target_oid, &namespace).unwrap();
        assert_eq!(preview.current_branch, "pick-target");
        assert_eq!(preview.target_subject, "Picked change");
        cherry_pick_commit(
            repository,
            &CherryPickCommitInput {
                target_oid: target_oid.clone(),
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap();

        let new_head = exact_commit_oid(repository, "HEAD").unwrap();
        // Replaying onto the same parent can legitimately recreate the exact same
        // commit object when author and committer metadata fall in the same second.
        assert_eq!(exact_commit_oid(repository, "HEAD^").unwrap(), base_oid);
        assert_eq!(
            fs::read_to_string(repository.join("picked.txt")).unwrap(),
            "picked\n"
        );
        assert_eq!(
            commit_summary_and_body(repository, &new_head)
                .unwrap()
                .0
                .subject,
            "Picked change"
        );
        assert!(status(repository).unwrap().changes.is_empty());
    }

    #[test]
    fn reset_modes_move_head_with_expected_index_and_worktree_behavior() {
        for mode in [
            ResetCommitMode::Soft,
            ResetCommitMode::Mixed,
            ResetCommitMode::Hard,
        ] {
            let directory = tempdir().unwrap();
            let repository = directory.path();
            initialize_repository(repository);
            fs::write(repository.join("base.txt"), "base\n").unwrap();
            run_git(repository, &["add", "base.txt"]);
            run_git(repository, &["commit", "--quiet", "-m", "Base"]);
            fs::write(repository.join("second.txt"), "second\n").unwrap();
            run_git(repository, &["add", "second.txt"]);
            run_git(repository, &["commit", "--quiet", "-m", "Second"]);
            let second_oid = exact_commit_oid(repository, "HEAD").unwrap();
            fs::write(repository.join("third.txt"), "third\n").unwrap();
            run_git(repository, &["add", "third.txt"]);
            run_git(repository, &["commit", "--quiet", "-m", "Third"]);
            let third_oid = exact_commit_oid(repository, "HEAD").unwrap();

            let namespace = Uuid::new_v4();
            let preview = preview_reset_commit(repository, &third_oid, mode, &namespace).unwrap();
            assert!(preview.selected_is_head);
            assert_eq!(preview.target_oid, second_oid);
            reset_commit(
                repository,
                &ResetCommitInput {
                    selected_oid: third_oid,
                    mode,
                    expected_token: preview.token,
                },
                &namespace,
            )
            .unwrap();

            assert_eq!(exact_commit_oid(repository, "HEAD").unwrap(), second_oid);
            match mode {
                ResetCommitMode::Soft => {
                    assert!(repository.join("third.txt").exists());
                    let staged =
                        execute(Some(repository), &["diff", "--cached", "--name-only"]).unwrap();
                    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "third.txt");
                }
                ResetCommitMode::Mixed => {
                    assert!(repository.join("third.txt").exists());
                    let staged =
                        execute(Some(repository), &["diff", "--cached", "--name-only"]).unwrap();
                    assert!(staged.stdout.is_empty());
                    assert!(!status(repository).unwrap().changes.is_empty());
                }
                ResetCommitMode::Hard => {
                    assert!(!repository.join("third.txt").exists());
                    assert!(status(repository).unwrap().changes.is_empty());
                }
            }
        }
    }

    #[test]
    fn rejects_reset_previews_for_dirty_worktrees_and_published_heads() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("tracked.txt"), "head\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Head"]);
        let head_oid = exact_commit_oid(repository, "HEAD").unwrap();
        let namespace = Uuid::new_v4();

        fs::write(repository.join("tracked.txt"), "dirty\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        for mode in [
            ResetCommitMode::Soft,
            ResetCommitMode::Mixed,
            ResetCommitMode::Hard,
        ] {
            let error = preview_reset_commit(repository, &head_oid, mode, &namespace).unwrap_err();
            assert_eq!(error.code, "reset_dirty_worktree");
        }
        run_git(repository, &["reset", "--hard", "HEAD"]);

        run_git(
            repository,
            &["update-ref", "refs/remotes/origin/main", &head_oid],
        );
        let remote_error =
            preview_reset_commit(repository, &head_oid, ResetCommitMode::Mixed, &namespace)
                .unwrap_err();
        assert_eq!(remote_error.code, "reset_published_history");
        run_git(
            repository,
            &["update-ref", "-d", "refs/remotes/origin/main"],
        );

        run_git(repository, &["tag", "published-head", &head_oid]);
        let tag_error =
            preview_reset_commit(repository, &head_oid, ResetCommitMode::Mixed, &namespace)
                .unwrap_err();
        assert_eq!(tag_error.code, "reset_published_history");
    }

    #[test]
    fn rejects_hard_reset_when_worktree_changes_after_preview() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(repository, &["add", "tracked.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("tracked.txt"), "head\n").unwrap();
        run_git(repository, &["commit", "--quiet", "-am", "Head"]);
        let head_oid = exact_commit_oid(repository, "HEAD").unwrap();

        let namespace = Uuid::new_v4();
        let preview =
            preview_reset_commit(repository, &head_oid, ResetCommitMode::Hard, &namespace).unwrap();
        fs::write(repository.join("tracked.txt"), "edited after preview\n").unwrap();
        let error = reset_commit(
            repository,
            &ResetCommitInput {
                selected_oid: head_oid.clone(),
                mode: ResetCommitMode::Hard,
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap_err();

        assert_eq!(error.code, "reset_dirty_worktree");
        assert_eq!(exact_commit_oid(repository, "HEAD").unwrap(), head_oid);
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "edited after preview\n"
        );
    }

    #[test]
    fn rejects_reset_when_head_changes_after_preview() {
        let directory = tempdir().unwrap();
        let repository = directory.path();
        initialize_repository(repository);
        fs::write(repository.join("base.txt"), "base\n").unwrap();
        run_git(repository, &["add", "base.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Base"]);
        fs::write(repository.join("head.txt"), "head\n").unwrap();
        run_git(repository, &["add", "head.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Head"]);
        let selected_oid = exact_commit_oid(repository, "HEAD").unwrap();

        let namespace = Uuid::new_v4();
        let preview = preview_reset_commit(
            repository,
            &selected_oid,
            ResetCommitMode::Mixed,
            &namespace,
        )
        .unwrap();
        fs::write(repository.join("new-head.txt"), "new head\n").unwrap();
        run_git(repository, &["add", "new-head.txt"]);
        run_git(repository, &["commit", "--quiet", "-m", "Move HEAD"]);
        let changed_head = exact_commit_oid(repository, "HEAD").unwrap();

        let error = reset_commit(
            repository,
            &ResetCommitInput {
                selected_oid,
                mode: ResetCommitMode::Mixed,
                expected_token: preview.token,
            },
            &namespace,
        )
        .unwrap_err();

        assert_eq!(error.code, "reset_snapshot_changed");
        assert_eq!(exact_commit_oid(repository, "HEAD").unwrap(), changed_head);
        assert!(repository.join("new-head.txt").exists());
    }

    #[test]
    fn local_git_failures_never_expose_stderr() {
        let error = git_failure(
            b"fatal: failed to open /Users/example/private-repository; token=secret-value\n",
        );

        assert_eq!(error.code, "git_command_failed");
        assert_eq!(error.message, "Git 命令执行失败，请刷新仓库状态后重试");
        assert!(!error.message.contains("private-repository"));
        assert!(!error.message.contains("secret-value"));
    }

    #[test]
    fn capped_reader_drains_input_without_growing_past_the_limit() {
        let (output, truncated) = read_capped(Cursor::new(b"abcdef"), 3).unwrap();
        assert_eq!(output, b"abc");
        assert!(truncated);
    }

    #[test]
    fn capped_tail_reader_preserves_terminal_network_errors() {
        let mut push_stderr = vec![b'x'; MAX_STDERR_BYTES + 1024];
        push_stderr.extend_from_slice(b"\nremote: error: protected branch hook declined\n");
        let (push_tail, push_truncated) =
            read_capped_tail(Cursor::new(push_stderr), MAX_STDERR_BYTES).unwrap();

        assert!(push_truncated);
        assert_eq!(push_tail.len(), MAX_STDERR_BYTES);
        assert!(String::from_utf8_lossy(&push_tail).contains("protected branch hook declined"));
        let push_status = Command::new("git")
            .arg("--version")
            .output()
            .unwrap()
            .status;
        assert_eq!(push_failure(push_status, &push_tail).code, "push_rejected");

        let mut pull_stderr = vec![b'x'; MAX_STDERR_BYTES + 1024];
        pull_stderr.extend_from_slice(b"\nfatal: Not possible to fast-forward, aborting.\n");
        let (pull_tail, pull_truncated) =
            read_capped_tail(Cursor::new(pull_stderr), MAX_STDERR_BYTES).unwrap();

        assert!(pull_truncated);
        let pull_status = Command::new("git")
            .arg("--version")
            .output()
            .unwrap()
            .status;
        assert_eq!(
            pull_failure(pull_status, &pull_tail).code,
            "pull_non_fast_forward"
        );
    }

    #[test]
    fn fetch_progress_reader_preserves_terminal_authentication_errors() {
        let mut stderr = vec![b'x'; MAX_STDERR_BYTES + 1024];
        stderr.extend_from_slice(b"\nfatal: Authentication failed for remote repository\n");
        let (tail, truncated) =
            read_fetch_stderr(Cursor::new(stderr), MAX_STDERR_BYTES, Arc::new(|_| {})).unwrap();

        assert!(truncated);
        assert_eq!(tail.len(), MAX_STDERR_BYTES);
        assert!(String::from_utf8_lossy(&tail).contains("Authentication failed"));
        let fetch_status = Command::new("git")
            .arg("--version")
            .output()
            .unwrap()
            .status;
        assert_eq!(
            fetch_failure(fetch_status, &tail).code,
            "git_authentication_required"
        );
        let clone_status = Command::new("git")
            .arg("--version")
            .output()
            .unwrap()
            .status;
        assert_eq!(
            clone_failure(clone_status, &tail).code,
            "git_authentication_required"
        );
    }
}
