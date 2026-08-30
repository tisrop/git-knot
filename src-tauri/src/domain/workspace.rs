use super::{CommitSummary, ImageDiff, RepositoryStatus};
use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub exists: bool,
    pub content: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetails {
    pub path: String,
    pub current: ConflictSide,
    pub incoming: ConflictSide,
    pub is_binary: bool,
    pub content_truncated: bool,
    pub resolvable: bool,
    pub unsupported_reason: Option<String>,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolutionChoice {
    Current,
    Incoming,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionInput {
    pub choice: ConflictResolutionChoice,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRecoveryInput {
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRecoveryPreview {
    pub current_branch: Option<String>,
    pub head_oid: String,
    pub merge_head_oid: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub unresolved_conflict_count: u64,
    pub has_unstaged_changes: bool,
    pub can_continue: bool,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub path: String,
    pub staged: bool,
    pub patch: String,
    pub patch_truncated: bool,
    pub image: Option<ImageDiff>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInput {
    pub subject: String,
    #[serde(default)]
    pub body: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendCommitInput {
    pub subject: String,
    #[serde(default)]
    pub body: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendAndPushInput {
    pub subject: String,
    #[serde(default)]
    pub body: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendAndPushPreview {
    pub current_branch: String,
    pub head_oid: String,
    pub current_subject: String,
    pub current_body: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub staged_change_count: u64,
    pub remote_name: String,
    pub remote_branch_name: String,
    pub remote_full_name: String,
    pub expected_remote_oid: String,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendCommitPreview {
    pub current_branch: String,
    pub head_oid: String,
    pub current_subject: String,
    pub current_body: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub staged_change_count: u64,
    pub blocking_refs: Vec<String>,
    pub can_amend: bool,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMutationResult {
    pub status: RepositoryStatus,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCreated {
    pub commit: CommitSummary,
    pub status: RepositoryStatus,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendCommitCreated {
    pub previous_oid: String,
    pub commit: CommitSummary,
    pub status: RepositoryStatus,
}
