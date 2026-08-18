use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub added_at: u64,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub group: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadataUpdateInput {
    pub id: String,
    pub favorite: bool,
    pub group: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub schema_version: u32,
    pub projects: Vec<Project>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            projects: Vec::new(),
        }
    }
}
