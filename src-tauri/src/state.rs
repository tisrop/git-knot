use crate::application::{GitOperationManager, RepositoryService};
use crate::infrastructure::config::ConfigStore;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct AppState {
    pub config: Arc<ConfigStore>,
    pub git_operations: GitOperationManager,
    pub repository: RepositoryService,
    pub update_in_progress: AtomicBool,
}

impl AppState {
    pub fn new(config: ConfigStore) -> Self {
        Self {
            config: Arc::new(config),
            git_operations: GitOperationManager::default(),
            repository: RepositoryService::default(),
            update_in_progress: AtomicBool::new(false),
        }
    }
}
