use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head_oid: String,
    pub branch: Option<String>,
    pub branch_full_name: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prunable_reason: Option<String>,
    pub is_main: bool,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktrees {
    pub worktrees: Vec<WorktreeInfo>,
    pub create_candidates: Vec<WorktreeCreateCandidate>,
    /// Snapshot token for pruning only the stale records shown in this list.
    pub prune_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateCandidate {
    pub branch: String,
    pub branch_full_name: String,
    pub head_oid: String,
    pub target_path: String,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateInput {
    pub branch_full_name: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLockInput {
    pub worktree_path: String,
    pub expected_token: String,
    pub reason: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUnlockInput {
    pub worktree_path: String,
    pub expected_token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePruneInput {
    pub expected_token: String,
}
