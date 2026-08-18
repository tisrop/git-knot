import { describe, expect, it } from "vitest";
import type { GitOperationEvent } from "../../platform/desktop";
import {
  isActiveGitOperation,
  isTerminalGitOperation,
  latestRepositoryOperation,
  upsertGitOperation,
} from "./gitOperations";

function operation(
  operationId: string,
  repositoryPath: string,
  kind: GitOperationEvent["kind"],
  state: GitOperationEvent["state"],
): GitOperationEvent {
  return {
    operationId,
    repositoryPath,
    kind,
    state,
    phase: state,
    percent: null,
    message: `${kind}:${state}`,
    remoteTagDeletePreview: null,
  };
}

describe("git operation registry", () => {
  it("updates one operation by operationId without losing repository identity", () => {
    const queued = operation("op-1", "/repo-a", "fetch", "queued");
    const running = { ...queued, state: "running" as const, percent: 40 };

    expect(upsertGitOperation(upsertGitOperation([], queued), running)).toEqual([running]);
  });

  it("does not let a late synthetic queued event overwrite progress", () => {
    const progress = operation("op-1", "/repo-a", "fetch", "progress");
    const queued = operation("op-1", "/repo-a", "fetch", "queued");

    expect(upsertGitOperation([progress], queued)).toEqual([progress]);
  });

  it("selects the latest matching operation by repository and kind", () => {
    const operations = [
      operation("op-1", "/repo-a", "fetch", "succeeded"),
      operation("op-2", "/repo-b", "fetch", "running"),
      operation("op-3", "/repo-a", "tag_push", "running"),
      operation("op-4", "/repo-a", "pull", "progress"),
    ];

    expect(
      latestRepositoryOperation(operations, "/repo-a", new Set(["fetch", "pull", "push"])),
    ).toMatchObject({ operationId: "op-4" });
    expect(
      latestRepositoryOperation(
        operations,
        "/repo-a",
        new Set(["tag_push", "tag_delete_preview", "tag_delete"]),
      ),
    ).toMatchObject({ operationId: "op-3" });
  });

  it("prioritizes a still-active operation over a newer terminal event", () => {
    const operations = [
      operation("op-1", "/repo-a", "fetch", "progress"),
      operation("op-2", "/repo-a", "pull", "failed"),
    ];

    expect(
      latestRepositoryOperation(operations, "/repo-a", new Set(["fetch", "pull", "push"])),
    ).toMatchObject({ operationId: "op-1" });
  });

  it("distinguishes active and terminal states", () => {
    expect(isActiveGitOperation(operation("op-1", "/repo", "push", "progress"))).toBe(true);
    expect(isTerminalGitOperation(operation("op-1", "/repo", "push", "failed"))).toBe(true);
  });
});
