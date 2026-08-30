import type { GitOperationEvent, GitOperationKind } from "../../platform/desktop";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_RETAINED_OPERATIONS = 128;

const OPERATION_STATE_RANK: Record<GitOperationEvent["state"], number> = {
  queued: 0,
  running: 1,
  progress: 2,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
  timed_out: 3,
};

export function isTerminalGitOperation(operation: GitOperationEvent) {
  return TERMINAL_STATES.has(operation.state);
}

export function isActiveGitOperation(operation: GitOperationEvent) {
  return !isTerminalGitOperation(operation);
}

export function upsertGitOperation(
  operations: GitOperationEvent[],
  event: GitOperationEvent,
): GitOperationEvent[] {
  const existingIndex = operations.findIndex(
    (operation) => operation.operationId === event.operationId,
  );
  const next = [...operations];
  if (existingIndex >= 0) {
    const existing = next[existingIndex];
    // A terminal state is final: Rust emits exactly one per operation, so a
    // second one can only be a duplicate or out-of-order delivery. Letting it
    // through would let a stale "failed" overwrite a recorded "succeeded" and
    // surface an error banner for an operation that worked.
    if (isTerminalGitOperation(existing)) return next;
    if (OPERATION_STATE_RANK[event.state] >= OPERATION_STATE_RANK[existing.state]) {
      next[existingIndex] = event;
    }
  } else {
    next.push(event);
  }
  return next.slice(-MAX_RETAINED_OPERATIONS);
}

export function latestRepositoryOperation(
  operations: GitOperationEvent[],
  repositoryPath: string,
  kinds: ReadonlySet<GitOperationKind>,
) {
  let latestTerminal: GitOperationEvent | null = null;
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation.repositoryPath !== repositoryPath || !kinds.has(operation.kind)) continue;
    if (isActiveGitOperation(operation)) return operation;
    latestTerminal ??= operation;
  }
  return latestTerminal;
}
