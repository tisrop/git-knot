use crate::domain::{
    CloneOperationStarted, GitOperationEvent, GitOperationKind, GitOperationState, Project,
    ProjectMetadataUpdateInput, GIT_OPERATION_EVENT,
};
use crate::error::CommandError;
use crate::infrastructure::git::{self, FetchProgress};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

fn task_error(operation: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::new("git_task_failed", format!("{operation}任务失败：{error}"))
}

fn emit_operation(app: &AppHandle, event: GitOperationEvent) {
    let _ = app.emit(GIT_OPERATION_EVENT, event);
}

fn project_from_root(root: &Path) -> Project {
    let normalized_path = root.to_string_lossy().into_owned();
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Repository")
        .to_owned();
    Project {
        id: Uuid::new_v5(&Uuid::NAMESPACE_URL, normalized_path.as_bytes()).to_string(),
        name,
        path: normalized_path,
        added_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        favorite: false,
        group: None,
    }
}

#[tauri::command]
pub fn project_list(state: State<'_, AppState>) -> Result<Vec<Project>, CommandError> {
    state.config.projects()
}

#[tauri::command]
pub fn project_remove(id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    state.config.remove_project(&id)
}

#[tauri::command]
pub fn project_update_metadata(
    input: ProjectMetadataUpdateInput,
    state: State<'_, AppState>,
) -> Result<Project, CommandError> {
    state.config.update_project_metadata(input)
}

#[tauri::command]
pub async fn project_add(
    path: String,
    state: State<'_, AppState>,
) -> Result<Project, CommandError> {
    let selected_path = PathBuf::from(path);
    let root = tauri::async_runtime::spawn_blocking(move || git::repository_root(&selected_path))
        .await
        .map_err(|error| task_error("仓库检测", error))??;
    state.config.add_project(project_from_root(&root))
}

#[tauri::command]
pub async fn project_scan(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Project>, CommandError> {
    let root = PathBuf::from(root_path);
    let roots = tauri::async_runtime::spawn_blocking(move || git::scan_repositories(&root, 4))
        .await
        .map_err(|error| task_error("项目扫描", error))??;
    let projects = roots
        .iter()
        .map(|root| project_from_root(root))
        .collect::<Vec<_>>();

    let mut persisted = Vec::with_capacity(projects.len());
    for project in projects.iter().rev() {
        persisted.push(state.config.add_project(project.clone())?);
    }
    persisted.reverse();
    Ok(persisted)
}

#[tauri::command]
pub async fn project_clone_start(
    remote_url: String,
    parent_directory: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CloneOperationStarted, CommandError> {
    let parent_directory = PathBuf::from(parent_directory);
    let target = tauri::async_runtime::spawn_blocking(move || {
        git::prepare_clone(&remote_url, &parent_directory)
    })
    .await
    .map_err(|error| task_error("克隆准备", error))??;

    let operation = state.git_operations.register()?;
    let operation_id = operation.operation_id().to_owned();
    let cancellation = operation.cancellation();
    let repository = state.repository.clone();
    let config = Arc::clone(&state.config);
    let repository_path = target.target_directory.to_string_lossy().into_owned();
    let task_operation_id = operation_id.clone();
    let response_repository_path = repository_path.clone();

    emit_operation(
        &app,
        GitOperationEvent {
            operation_id: operation_id.clone(),
            repository_path: repository_path.clone(),
            kind: GitOperationKind::Clone,
            state: GitOperationState::Queued,
            phase: Some("queued".to_owned()),
            percent: None,
            message: format!("正在等待克隆 {}", target.repository_name),
            remote_tag_delete_preview: None,
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let started_app = app.clone();
        let started_operation_id = task_operation_id.clone();
        let started_repository_path = repository_path.clone();
        let started: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            emit_operation(
                &started_app,
                GitOperationEvent {
                    operation_id: started_operation_id.clone(),
                    repository_path: started_repository_path.clone(),
                    kind: GitOperationKind::Clone,
                    state: GitOperationState::Running,
                    phase: Some("connecting".to_owned()),
                    percent: None,
                    message: "正在连接远端仓库".to_owned(),
                    remote_tag_delete_preview: None,
                },
            );
        });

        let progress_app = app.clone();
        let progress_operation_id = task_operation_id.clone();
        let progress_repository_path = repository_path.clone();
        let progress: Arc<dyn Fn(FetchProgress) + Send + Sync> = Arc::new(move |update| {
            emit_operation(
                &progress_app,
                GitOperationEvent {
                    operation_id: progress_operation_id.clone(),
                    repository_path: progress_repository_path.clone(),
                    kind: GitOperationKind::Clone,
                    state: GitOperationState::Progress,
                    phase: Some(update.phase),
                    percent: update.percent,
                    message: update.message,
                    remote_tag_delete_preview: None,
                },
            );
        });

        let result = repository
            .clone_repository(target, cancellation, started, progress)
            .and_then(|root| config.add_project(project_from_root(&root)));
        let event = match result {
            Ok(project) => GitOperationEvent {
                operation_id: task_operation_id.clone(),
                repository_path: project.path,
                kind: GitOperationKind::Clone,
                state: GitOperationState::Succeeded,
                phase: Some("completed".to_owned()),
                percent: Some(100),
                message: "仓库已克隆并添加到项目列表".to_owned(),
                remote_tag_delete_preview: None,
            },
            Err(error) => {
                let state = match error.code {
                    "git_operation_cancelled" => GitOperationState::Cancelled,
                    "git_operation_timed_out" => GitOperationState::TimedOut,
                    _ => GitOperationState::Failed,
                };
                GitOperationEvent {
                    operation_id: task_operation_id.clone(),
                    repository_path,
                    kind: GitOperationKind::Clone,
                    state,
                    phase: Some("completed".to_owned()),
                    percent: None,
                    message: error.message,
                    remote_tag_delete_preview: None,
                }
            }
        };
        emit_operation(&app, event);
    });

    Ok(CloneOperationStarted {
        operation_id,
        repository_path: response_repository_path,
    })
}
