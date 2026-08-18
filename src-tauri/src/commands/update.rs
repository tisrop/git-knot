use crate::domain::{UpdateCheckResult, UpdateProgressEvent, UPDATE_PROGRESS_EVENT};
use crate::error::CommandError;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Error as UpdaterError, UpdaterExt};

const MAX_RELEASE_NOTES_CHARS: usize = 16_000;
const RELEASE_NOTES_TRUNCATED_SUFFIX: &str = "\n\n[更新说明过长，已截断]";

struct UpdateGuard<'a>(&'a AppState);

impl Drop for UpdateGuard<'_> {
    fn drop(&mut self) {
        self.0.update_in_progress.store(false, Ordering::Release);
    }
}

fn begin_update(state: &AppState) -> Result<UpdateGuard<'_>, CommandError> {
    state
        .update_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| CommandError::new("update_busy", "已有更新正在下载或安装，请稍候"))?;
    Ok(UpdateGuard(state))
}

fn ensure_restart_allowed(update_in_progress: &AtomicBool) -> Result<(), CommandError> {
    if update_in_progress.load(Ordering::Acquire) {
        return Err(CommandError::new(
            "update_busy",
            "更新正在下载或安装，请完成后再重启",
        ));
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), CommandError> {
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CommandError::new(
            "invalid_update_request",
            "更新请求标识格式无效",
        ));
    }
    Ok(())
}

fn validate_version(version: &str) -> Result<(), CommandError> {
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err(CommandError::new(
            "invalid_update_version",
            "更新版本格式无效",
        ));
    }
    Ok(())
}

fn sanitize_release_notes(notes: Option<String>) -> Option<String> {
    notes.map(|notes| {
        if notes.chars().count() <= MAX_RELEASE_NOTES_CHARS {
            return notes;
        }
        let mut truncated: String = notes.chars().take(MAX_RELEASE_NOTES_CHARS).collect();
        truncated.push_str(RELEASE_NOTES_TRUNCATED_SUFFIX);
        truncated
    })
}

fn check_error(error: UpdaterError) -> CommandError {
    let message = match error {
        UpdaterError::ReleaseNotFound => "GitHub Release 尚未提供有效的 latest.json，请稍后重试",
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => {
            "最新版本缺少当前系统或架构的安装包"
        }
        UpdaterError::Serialization(_)
        | UpdaterError::Semver(_)
        | UpdaterError::UrlParse(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::Minisign(_) => "更新元数据或签名格式无效，已拒绝更新",
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => "检查更新失败，请检查网络连接后重试",
        UpdaterError::InsecureTransportProtocol => "更新源不是安全的 HTTPS 地址，已拒绝连接",
        UpdaterError::UnsupportedArch | UpdaterError::UnsupportedOs => {
            "当前系统或架构暂不支持自动更新"
        }
        UpdaterError::EmptyEndpoints => "应用未配置 GitHub Release 更新源",
        _ => "检查更新失败，请稍后重试",
    };
    CommandError::new("update_check_failed", message)
}

fn download_error(error: UpdaterError) -> CommandError {
    let message = match error {
        UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) | UpdaterError::Minisign(_) => {
            "更新包签名验证失败，已停止安装"
        }
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => "下载更新失败，请检查网络连接后重试",
        UpdaterError::InsecureTransportProtocol => "更新包地址不是 HTTPS，已拒绝下载",
        _ => "下载更新失败，请稍后重试",
    };
    CommandError::new("update_download_failed", message)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateCheckResult, CommandError> {
    let updater = app
        .updater()
        .map_err(|_| CommandError::new("updater_unavailable", "初始化更新服务失败"))?;
    let update = updater.check().await.map_err(check_error)?;
    Ok(match update {
        Some(update) => UpdateCheckResult {
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            available: true,
            version: Some(update.version),
            notes: sanitize_release_notes(update.body),
            published_at: update.date.map(|date| date.to_string()),
        },
        None => UpdateCheckResult {
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            available: false,
            version: None,
            notes: None,
            published_at: None,
        },
    })
}

#[tauri::command]
pub async fn update_download_and_install(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    expected_version: String,
) -> Result<(), CommandError> {
    validate_request_id(&request_id)?;
    validate_version(&expected_version)?;
    let _guard = begin_update(&state)?;
    let updater = app
        .updater()
        .map_err(|_| CommandError::new("updater_unavailable", "初始化更新服务失败"))?;
    let update = updater
        .check()
        .await
        .map_err(check_error)?
        .ok_or_else(|| CommandError::new("update_not_available", "当前已是最新版本"))?;
    if update.version != expected_version {
        return Err(CommandError::new(
            "update_version_changed",
            format!(
                "可用更新已从 v{expected_version} 变更为 v{}，请重新检查并确认",
                update.version
            ),
        ));
    }

    let progress_app = app.clone();
    let install_app = app.clone();
    let install_request_id = request_id.clone();
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            move |chunk_size, total| {
                downloaded = downloaded.saturating_add(chunk_size as u64);
                let _ = progress_app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgressEvent {
                        request_id: request_id.clone(),
                        downloaded,
                        total,
                        phase: "downloading".to_owned(),
                    },
                );
            },
            move || {
                let _ = install_app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgressEvent {
                        request_id: install_request_id,
                        downloaded: 0,
                        total: None,
                        phase: "installing".to_owned(),
                    },
                );
            },
        )
        .await
        .map_err(download_error)?;

    update
        .install(bytes)
        .map_err(|_| CommandError::new("update_install_failed", "安装更新失败，应用尚未重启"))?;
    Ok(())
}

#[tauri::command]
pub fn update_restart(app: AppHandle, state: State<'_, AppState>) -> Result<(), CommandError> {
    ensure_restart_allowed(&state.update_in_progress)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_restart_while_update_is_in_progress() {
        let update_in_progress = AtomicBool::new(true);
        let error = ensure_restart_allowed(&update_in_progress).unwrap_err();
        assert_eq!(error.code, "update_busy");

        update_in_progress.store(false, Ordering::Release);
        assert!(ensure_restart_allowed(&update_in_progress).is_ok());
    }

    #[test]
    fn validates_request_and_version_inputs() {
        assert!(validate_request_id("update-123").is_ok());
        assert!(validate_request_id("../unsafe").is_err());
        assert!(validate_version("1.2.3-beta.1+build.2").is_ok());
        assert!(validate_version("1.2.3\nunsafe").is_err());
    }

    #[test]
    fn truncates_oversized_release_notes_on_character_boundaries() {
        let notes = "更".repeat(MAX_RELEASE_NOTES_CHARS + 1);
        let sanitized = sanitize_release_notes(Some(notes)).expect("notes");
        assert!(sanitized.ends_with(RELEASE_NOTES_TRUNCATED_SUFFIX));
        assert_eq!(
            sanitized
                .trim_end_matches(RELEASE_NOTES_TRUNCATED_SUFFIX)
                .chars()
                .count(),
            MAX_RELEASE_NOTES_CHARS
        );
    }
}
