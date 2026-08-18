use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub offset: u32,
    pub limit: u32,
    pub ref_full_name: Option<String>,
    pub search: String,
    pub author: String,
    pub after: Option<String>,
    pub before: Option<String>,
    pub file_path: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
    pub next_offset: u32,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub oid: String,
    pub parent_oids: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub subject: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub status: String,
    pub path: String,
    pub original_path: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    pub mime_type: String,
    pub data_url: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub byte_length: u64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDiff {
    pub old: Option<ImagePreview>,
    pub new: Option<ImagePreview>,
    pub unsupported_reason: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub commit: CommitSummary,
    pub body: String,
    pub files: Vec<CommitFileChange>,
    pub patch: String,
    pub patch_truncated: bool,
}
