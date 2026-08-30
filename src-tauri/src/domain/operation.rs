use crate::domain::RemoteTagDeletePreview;
use serde::Serialize;

pub const GIT_OPERATION_EVENT: &str = "git-operation://status";

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationKind {
    AmendPush,
    Fetch,
    Pull,
    Push,
    Sync,
    Clone,
    TagPush,
    TagDeletePreview,
    TagDelete,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitOperationState {
    Queued,
    Running,
    Progress,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationStarted {
    pub operation_id: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOperationStarted {
    pub operation_id: String,
    pub repository_path: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationEvent {
    pub operation_id: String,
    pub repository_path: String,
    pub kind: GitOperationKind,
    pub state: GitOperationState,
    pub phase: Option<String>,
    pub percent: Option<u8>,
    pub message: String,
    pub remote_tag_delete_preview: Option<RemoteTagDeletePreview>,
}
