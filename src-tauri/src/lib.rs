mod application;
#[cfg(test)]
mod bindings;
mod commands;
mod domain;
mod error;
mod infrastructure;
mod state;

use infrastructure::config::ConfigStore;
use state::AppState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let store = ConfigStore::open(app_data_dir.join("config.json"))?;
            app.manage(AppState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git::git_version,
            commands::project::project_add,
            commands::project::project_clone_start,
            commands::project::project_list,
            commands::project::project_remove,
            commands::project::project_scan,
            commands::project::project_update_metadata,
            commands::repository::repository_abort_merge_recovery,
            commands::repository::repository_amend_commit,
            commands::repository::repository_cherry_pick_commit,
            commands::repository::repository_commit,
            commands::repository::repository_commit_image_diff,
            commands::repository::repository_apply_stash,
            commands::repository::repository_conflict_details,
            commands::repository::repository_create_branch,
            commands::repository::repository_create_branch_at_commit,
            commands::repository::repository_create_linked_worktree,
            commands::repository::repository_create_tracking_branch,
            commands::repository::repository_create_commit,
            commands::repository::repository_continue_merge_recovery,
            commands::repository::repository_create_remote,
            commands::repository::repository_create_stash,
            commands::repository::repository_create_tag,
            commands::repository::repository_delete_branch,
            commands::repository::repository_delete_remote,
            commands::repository::repository_delete_remote_tag_start,
            commands::repository::repository_delete_tag,
            commands::repository::repository_discard_files,
            commands::repository::repository_drop_stash,
            commands::repository::repository_fetch_start,
            commands::repository::repository_history,
            commands::repository::repository_lock_worktree,
            commands::repository::repository_merge_local_branch,
            commands::repository::repository_operation_cancel,
            commands::repository::repository_preview_local_merge,
            commands::repository::repository_preview_amend_commit,
            commands::repository::repository_preview_cherry_pick,
            commands::repository::repository_preview_merge_recovery,
            commands::repository::repository_preview_remote_delete,
            commands::repository::repository_preview_remote_edit,
            commands::repository::repository_preview_remote_tag_delete_start,
            commands::repository::repository_preview_revert,
            commands::repository::repository_preview_reset_commit,
            commands::repository::repository_pull_start,
            commands::repository::repository_pop_stash,
            commands::repository::repository_push_start,
            commands::repository::repository_push_tag_start,
            commands::repository::repository_sync_start,
            commands::repository::repository_refs,
            commands::repository::repository_resolve_conflict,
            commands::repository::repository_revert_commit,
            commands::repository::repository_reset_commit,
            commands::repository::repository_stage,
            commands::repository::repository_stage_all,
            commands::repository::repository_status,
            commands::repository::repository_stashes,
            commands::repository::repository_submodules,
            commands::repository::repository_switch_branch,
            commands::repository::repository_tags,
            commands::repository::repository_unstage,
            commands::repository::repository_unstage_all,
            commands::repository::repository_unlock_worktree,
            commands::repository::repository_prune_worktrees,
            commands::repository::repository_update_remote,
            commands::repository::repository_worktree_diff,
            commands::repository::repository_worktrees,
            commands::update::update_check,
            commands::update::update_download_and_install,
            commands::update::update_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building git-knot")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.git_operations.cancel_all();
                }
            }
        });
}
