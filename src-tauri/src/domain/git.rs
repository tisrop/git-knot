use serde::Serialize;

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub raw: String,
    pub version: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub head: Option<String>,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub ahead: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub behind: u64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Ordinary,
    Renamed,
    Unmerged,
    Untracked,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: Option<String>,
    pub worktree_status: Option<String>,
    pub kind: ChangeKind,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    pub root: String,
    pub branch: BranchStatus,
    pub changes: Vec<FileChange>,
}
