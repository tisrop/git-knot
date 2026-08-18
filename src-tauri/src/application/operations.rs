use crate::error::CommandError;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const MAX_ACTIVE_GIT_OPERATIONS: usize = 32;

type OperationMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Clone, Default)]
pub struct GitOperationManager {
    operations: OperationMap,
}

#[must_use = "注册对象必须存活到 Git 长任务结束，否则槽位会被提前释放"]
pub(crate) struct GitOperationRegistration {
    operation_id: String,
    cancellation: Arc<AtomicBool>,
    operations: OperationMap,
}

impl GitOperationManager {
    pub(crate) fn register(&self) -> Result<GitOperationRegistration, CommandError> {
        let operation_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| operation_state_error())?;
        if operations.len() >= MAX_ACTIVE_GIT_OPERATIONS {
            return Err(CommandError::new(
                "too_many_git_operations",
                "同时运行或排队的 Git 长任务过多，请等待现有任务结束",
            ));
        }
        operations.insert(operation_id.clone(), Arc::clone(&cancellation));
        drop(operations);

        Ok(GitOperationRegistration {
            operation_id,
            cancellation,
            operations: Arc::clone(&self.operations),
        })
    }

    pub fn cancel(&self, operation_id: &str) -> Result<bool, CommandError> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| operation_state_error())?;
        let Some(cancellation) = operations.get(operation_id) else {
            return Ok(false);
        };
        cancellation.store(true, Ordering::SeqCst);
        Ok(true)
    }

    /// Requests cancellation for every operation that is still registered.
    ///
    /// This is intentionally best-effort: it is used while the application is
    /// shutting down, so there is no useful error path for a poisoned mutex.
    pub fn cancel_all(&self) -> usize {
        let Ok(operations) = self.operations.lock() else {
            return 0;
        };
        for cancellation in operations.values() {
            cancellation.store(true, Ordering::SeqCst);
        }
        operations.len()
    }
}

impl GitOperationRegistration {
    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancellation)
    }
}

impl Drop for GitOperationRegistration {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(&self.operation_id);
        }
    }
}

fn operation_state_error() -> CommandError {
    CommandError::new("git_operation_state_failed", "Git 长任务状态不可用")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    #[test]
    fn registers_cancels_and_releases_operations_on_drop() {
        let manager = GitOperationManager::default();
        let operation = manager.register().unwrap();
        let operation_id = operation.operation_id().to_owned();
        let cancellation = operation.cancellation();

        assert!(manager.cancel(&operation_id).unwrap());
        assert!(cancellation.load(Ordering::SeqCst));

        drop(operation);
        assert!(!manager.cancel(&operation_id).unwrap());
    }

    #[test]
    fn cancels_all_registered_operations() {
        let manager = GitOperationManager::default();
        let first_operation = manager.register().unwrap();
        let second_operation = manager.register().unwrap();
        let first = first_operation.cancellation();
        let second = second_operation.cancellation();

        assert_eq!(manager.cancel_all(), 2);
        assert!(first.load(Ordering::SeqCst));
        assert!(second.load(Ordering::SeqCst));
    }

    #[test]
    fn panic_drops_registration_without_exhausting_operation_slots() {
        let manager = GitOperationManager::default();
        let result = catch_unwind(AssertUnwindSafe(|| {
            let _operation = manager.register().unwrap();
            panic!("simulated blocking task panic");
        }));
        assert!(result.is_err());

        let operations = (0..MAX_ACTIVE_GIT_OPERATIONS)
            .map(|_| manager.register())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(manager.cancel_all(), MAX_ACTIVE_GIT_OPERATIONS);
        assert_eq!(operations.len(), MAX_ACTIVE_GIT_OPERATIONS);
    }
}
