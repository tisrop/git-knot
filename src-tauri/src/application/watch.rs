use crate::domain::{WorkspaceChangedEvent, WORKSPACE_CHANGED_EVENT};
use crate::error::CommandError;
use crate::infrastructure::git;
use crate::infrastructure::watch::RepositoryWatch;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Owns the single active repository watch.
///
/// Only the repository the user currently has open is observed: watching every
/// registered project would multiply the operating system's watch budget by the
/// size of the project list for state nobody is looking at.
#[derive(Clone, Default)]
pub struct RepositoryWatchManager {
    active: Arc<Mutex<Option<ActiveWatch>>>,
    generation: Arc<AtomicU64>,
}

struct ActiveWatch {
    requested_path: String,
    /// Held only for its `Drop`: releasing it stops the watcher thread.
    #[allow(dead_code)]
    watch: RepositoryWatch,
}

impl RepositoryWatchManager {
    /// Starts observing `requested_path`, replacing any previous watch.
    ///
    /// Re-requesting the repository that is already being watched is a no-op,
    /// so re-rendering the frontend does not tear down and rebuild the watch.
    pub fn start(&self, app: AppHandle, requested_path: String) -> Result<(), CommandError> {
        {
            let active = self.active.lock().map_err(watch_state_error)?;
            if active
                .as_ref()
                .is_some_and(|current| current.requested_path == requested_path)
            {
                return Ok(());
            }
        }

        let root = git::repository_root(&PathBuf::from(&requested_path))?;
        let git_dir = git::repository_write_key(&root)?;

        let mut active = self.active.lock().map_err(watch_state_error)?;
        // Stop the previous watch before claiming the new generation so a
        // late event from the old thread cannot be mistaken for the new one.
        *active = None;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let emit_app = app;
        let emit_path = requested_path.clone();
        let emit_generation = Arc::clone(&self.generation);
        let watch = RepositoryWatch::start(&root, &git_dir, move || {
            if emit_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let _ = emit_app.emit(
                WORKSPACE_CHANGED_EVENT,
                WorkspaceChangedEvent {
                    // Echo the path the frontend asked for rather than the
                    // canonical root, so it can match the event against its
                    // own project record without normalising paths.
                    repository_path: emit_path.clone(),
                },
            );
        })?;

        *active = Some(ActiveWatch {
            requested_path,
            watch,
        });
        Ok(())
    }

    /// Stops the active watch, if any. Best-effort: a poisoned mutex during
    /// shutdown has no useful error path.
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut active) = self.active.lock() {
            *active = None;
        }
    }
}

fn watch_state_error(_: impl std::fmt::Display) -> CommandError {
    CommandError::new("watch_state_unavailable", "文件监听状态不可用，请重启应用")
}
