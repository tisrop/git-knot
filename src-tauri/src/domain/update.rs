use serde::Serialize;

pub const UPDATE_PROGRESS_EVENT: &str = "update://progress";

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub request_id: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub downloaded: u64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub total: Option<u64>,
    pub phase: String,
}
