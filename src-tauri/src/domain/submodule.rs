use serde::Serialize;

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    Clean,
    Modified,
    Uninitialized,
    Conflicted,
    Unsafe,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub path: String,
    pub name: Option<String>,
    pub url: Option<String>,
    pub branch: Option<String>,
    pub expected_oid: Option<String>,
    pub conflict_oids: Vec<String>,
    pub state: SubmoduleState,
    pub configured: bool,
    pub state_detail: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySubmodules {
    pub submodules: Vec<SubmoduleInfo>,
    pub gitmodules_present: bool,
}
