use super::RepositoryStatus;
use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreateAtCommitInput {
    pub name: String,
    pub target_oid: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchKind {
    Local,
    Remote,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub full_name: String,
    pub kind: BranchKind,
    pub current: bool,
    pub oid: String,
    pub upstream: Option<String>,
    pub upstream_missing: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub ahead: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub behind: u64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
    pub push_url_overridden: bool,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishBranchInput {
    pub local_full_name: String,
    pub remote_name: String,
    pub remote_branch_name: String,
    pub expected_local_oid: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCreateInput {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdateInput {
    pub name: String,
    pub expected_token: String,
    pub new_fetch_url: Option<String>,
    pub new_push_url: Option<String>,
    pub reset_push_url: bool,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeleteInput {
    pub name: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditPreview {
    pub remote: RemoteInfo,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeletePreview {
    pub remote: RemoteInfo,
    pub affected_branches: Vec<String>,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRefs {
    pub branches: Vec<BranchInfo>,
    pub remotes: Vec<RemoteInfo>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRefsMutationResult {
    pub refs: RepositoryRefs,
    pub status: RepositoryStatus,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalMergeStrategy {
    FastForwardOnly,
    CreateMergeCommit,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalMergeMode {
    UpToDate,
    FastForward,
    MergeCommit,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMergePreview {
    pub current_branch: String,
    pub current_full_name: String,
    pub current_oid: String,
    pub target_branch: String,
    pub target_full_name: String,
    pub target_oid: String,
    pub mode: LocalMergeMode,
    #[cfg_attr(test, ts(type = "number"))]
    pub ahead: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub behind: u64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitPreview {
    pub current_branch: String,
    pub current_oid: String,
    pub target_oid: String,
    pub target_parent_oid: String,
    pub target_subject: String,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitInput {
    pub target_oid: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickCommitPreview {
    pub current_branch: String,
    pub current_oid: String,
    pub target_oid: String,
    pub target_subject: String,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickCommitInput {
    pub target_oid: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetCommitMode {
    Soft,
    Mixed,
    Hard,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCommitPreview {
    pub current_branch: String,
    pub current_oid: String,
    pub selected_oid: String,
    pub selected_subject: String,
    pub target_oid: String,
    pub selected_is_head: bool,
    pub mode: ResetCommitMode,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCommitInput {
    pub selected_oid: String,
    pub mode: ResetCommitMode,
    pub expected_token: String,
}
