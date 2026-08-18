use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub target_oid: String,
    pub annotated: bool,
    pub subject: Option<String>,
    pub tagger_date: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryTags {
    pub tags: Vec<TagInfo>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryTagsMutationResult {
    pub tags: RepositoryTags,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTagPushInput {
    pub remote_name: String,
    pub full_name: String,
    pub expected_local_oid: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTagDeletePreviewInput {
    pub remote_name: String,
    pub full_name: String,
    pub expected_local_oid: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTagDeletePreview {
    pub remote_name: String,
    pub name: String,
    pub full_name: String,
    pub local_oid: String,
    pub remote_oid: String,
    pub token: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTagDeleteInput {
    pub remote_name: String,
    pub full_name: String,
    pub expected_local_oid: String,
    pub expected_remote_oid: String,
    pub expected_token: String,
}
