//! Read-only filesystem observation for a single repository.
//!
//! This adapter never runs Git and never mutates anything. It only reports
//! "something that could change `git status` happened", so the application
//! layer can ask for authoritative state again.

use crate::error::CommandError;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long the debouncer waits for the event stream to go quiet before it
/// reports a change. Bursty writers (editors, `git checkout`, package
/// managers) collapse into a single notification.
const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(300);

/// Upper bound on how long a single burst may postpone a notification. Without
/// it, sustained activity (a package manager writing thousands of files) would
/// keep resetting the debounce window and the view would never update.
const MAX_COALESCE_WINDOW: Duration = Duration::from_secs(2);

/// Git-internal subtrees that churn constantly without changing the answer of
/// `git status`.
const IGNORED_GIT_DIRECTORIES: &[&str] = &["objects", "logs", "lfs", "modules"];

/// Git-internal files that are written as part of normal plumbing but never
/// affect the workspace view.
const IGNORED_GIT_FILES: &[&str] = &["FETCH_HEAD", "COMMIT_EDITMSG"];

/// An active filesystem observation. Dropping it stops the watcher and asks
/// the debounce thread to exit.
pub struct RepositoryWatch {
    stopped: Arc<AtomicBool>,
    watcher: Option<RecommendedWatcher>,
    debouncer: Option<JoinHandle<()>>,
}

impl RepositoryWatch {
    /// Starts watching `root` (the worktree) and `git_dir` (the Git common
    /// directory) and invokes `on_change` after each debounced burst of
    /// relevant events.
    pub fn start(
        root: &Path,
        git_dir: &Path,
        on_change: impl Fn() + Send + 'static,
    ) -> Result<Self, CommandError> {
        let (sender, receiver) = mpsc::channel::<Event>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            // A dropped receiver means the watch was stopped; there is no
            // useful error path here.
            if let Ok(event) = result {
                let _ = sender.send(event);
            }
        })
        .map_err(watch_error)?;

        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(watch_error)?;
        // A linked worktree keeps its administrative files outside the
        // worktree, so the common directory needs its own watch.
        if !git_dir.starts_with(root) {
            watcher
                .watch(git_dir, RecursiveMode::Recursive)
                .map_err(watch_error)?;
        }

        let stopped = Arc::new(AtomicBool::new(false));
        let debouncer = spawn_debouncer(
            receiver,
            git_dir.to_path_buf(),
            Arc::clone(&stopped),
            on_change,
        );

        Ok(Self {
            stopped,
            watcher: Some(watcher),
            debouncer: Some(debouncer),
        })
    }
}

impl Drop for RepositoryWatch {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        // Dropping the watcher closes the channel, which wakes the debounce
        // thread out of `recv`/`recv_timeout` so it can observe the flag.
        self.watcher = None;
        if let Some(debouncer) = self.debouncer.take() {
            let _ = debouncer.join();
        }
    }
}

fn spawn_debouncer(
    receiver: Receiver<Event>,
    git_dir: PathBuf,
    stopped: Arc<AtomicBool>,
    on_change: impl Fn() + Send + 'static,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let is_relevant = |event: &Event| {
            event
                .paths
                .iter()
                .any(|path| is_relevant_change(path, &git_dir))
        };

        loop {
            // Wait for the first relevant event without burning CPU.
            let Ok(event) = receiver.recv() else { return };
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            if !is_relevant(&event) {
                continue;
            }

            // Collapse the rest of the burst.
            let burst_started = Instant::now();
            loop {
                match receiver.recv_timeout(DEBOUNCE_INTERVAL) {
                    Ok(_) if burst_started.elapsed() < MAX_COALESCE_WINDOW => continue,
                    Ok(_) => break,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            if stopped.load(Ordering::SeqCst) {
                return;
            }
            on_change();
        }
    })
}

/// Decides whether a filesystem path could change what the workspace view
/// shows.
///
/// Worktree paths are always relevant: applying `.gitignore` here would mean
/// reimplementing Git's ignore rules, so ignored-file noise is absorbed by the
/// debouncer and by the frontend, which drops refreshes that produce an
/// identical status.
pub(crate) fn is_relevant_change(path: &Path, git_dir: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(git_dir) else {
        return true;
    };

    let mut components = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        });

    let Some(first) = components.next() else {
        // The Git directory itself.
        return false;
    };

    if IGNORED_GIT_DIRECTORIES.contains(&first) || IGNORED_GIT_FILES.contains(&first) {
        return false;
    }

    // Lock files appear and disappear around every Git write; the real change
    // arrives with the file they guard.
    !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".lock"))
}

fn watch_error(error: notify::Error) -> CommandError {
    CommandError::new(
        "watch_start_failed",
        format!("无法监听仓库文件变化：{error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_dir() -> PathBuf {
        PathBuf::from("/repo/.git")
    }

    #[test]
    fn worktree_paths_are_relevant() {
        assert!(is_relevant_change(
            Path::new("/repo/src/main.rs"),
            &git_dir()
        ));
        assert!(is_relevant_change(Path::new("/repo/README.md"), &git_dir()));
    }

    #[test]
    fn paths_outside_the_git_directory_are_relevant() {
        assert!(is_relevant_change(
            Path::new("/other/worktree/file.txt"),
            &git_dir()
        ));
    }

    #[test]
    fn git_state_files_are_relevant() {
        for path in [
            "/repo/.git/index",
            "/repo/.git/HEAD",
            "/repo/.git/packed-refs",
            "/repo/.git/refs/heads/main",
            "/repo/.git/MERGE_HEAD",
            "/repo/.git/MERGE_MSG",
            "/repo/.git/REBASE_HEAD",
            "/repo/.git/CHERRY_PICK_HEAD",
            "/repo/.git/REVERT_HEAD",
            "/repo/.git/sequencer/todo",
        ] {
            assert!(is_relevant_change(Path::new(path), &git_dir()), "{path}");
        }
    }

    #[test]
    fn noisy_git_subtrees_are_ignored() {
        for path in [
            "/repo/.git/objects/ab/cdef",
            "/repo/.git/objects/pack/pack-1.pack",
            "/repo/.git/logs/HEAD",
            "/repo/.git/lfs/tmp/object",
            "/repo/.git/modules/sub/index",
        ] {
            assert!(!is_relevant_change(Path::new(path), &git_dir()), "{path}");
        }
    }

    #[test]
    fn git_plumbing_files_are_ignored() {
        assert!(!is_relevant_change(
            Path::new("/repo/.git/FETCH_HEAD"),
            &git_dir()
        ));
        assert!(!is_relevant_change(
            Path::new("/repo/.git/COMMIT_EDITMSG"),
            &git_dir()
        ));
    }

    #[test]
    fn lock_files_are_ignored() {
        assert!(!is_relevant_change(
            Path::new("/repo/.git/index.lock"),
            &git_dir()
        ));
        assert!(!is_relevant_change(
            Path::new("/repo/.git/refs/heads/main.lock"),
            &git_dir()
        ));
    }

    #[test]
    fn the_git_directory_itself_is_ignored() {
        assert!(!is_relevant_change(Path::new("/repo/.git"), &git_dir()));
    }

    #[test]
    fn worktree_lock_files_stay_relevant() {
        // Only Git-internal lock churn is filtered; a tracked `*.lock` file in
        // the worktree is a real change.
        assert!(is_relevant_change(
            Path::new("/repo/pnpm-lock.yaml.lock"),
            &git_dir()
        ));
    }
}
