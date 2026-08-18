use crate::domain::GitVersion;
use crate::error::CommandError;
use crate::infrastructure::git;

#[tauri::command]
pub async fn git_version() -> Result<GitVersion, CommandError> {
    tauri::async_runtime::spawn_blocking(git::version)
        .await
        .map_err(|error| {
            CommandError::new("git_task_failed", format!("Git 检测任务失败：{error}"))
        })?
}
