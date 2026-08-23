import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  Check,
  Copy,
  FileText,
  Minus,
  Plus,
  X,
} from "@phosphor-icons/react";
import {
  desktopApi,
  type AmendCommitPreview,
  type ConflictDetails,
  type ConflictResolutionChoice,
  type GitOperationEvent,
  type MergeRecoveryPreview,
  type Project,
  type RepositoryStatus,
  type ResetCommitMode,
  type ResetCommitPreview,
  type WorktreeDiff,
} from "../../platform/desktop";
import { Dialog } from "../../app/Dialog";
import { FileTypeBadge } from "../../app/FileTypeBadge";
import { UnifiedDiffView } from "../diff/UnifiedDiffView";
import { ImageDiffView } from "../diff/ImageDiffView";
import { parseUnifiedDiff } from "../history/history";
import { isActiveGitOperation } from "../operations/gitOperations";
import { summarizeRepositoryStatus } from "../repository/status";
import {
  groupWorkspaceChanges,
  pathspecsForChange,
  workspaceEntryKey,
  workspaceMutationBlocked,
  workspaceStatusLabel,
  type WorkspaceEntry,
} from "./workspace";

interface WorkspaceViewProps {
  project: Project;
  status: RepositoryStatus | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onStatusChange: (status: RepositoryStatus) => void;
  onError: (message: string) => void;
  embedded?: boolean;
  diffPanelVisible?: boolean;
  onDiffFocus?: () => void;
  onHistoryChange?: () => void;
  gitOperations: GitOperationEvent[];
  onOperationStarted: (operation: GitOperationEvent) => void;
}

interface DiffTarget {
  path: string;
  staged: boolean;
}

interface PendingConflictResolution {
  details: ConflictDetails;
  choice: ConflictResolutionChoice;
}

type MergeRecoveryAction = "continue" | "abort";
type CommitFollowUp = "none" | "push" | "sync";
type AmendIntent = "submit" | "edit-message";

interface PendingUndoCommit {
  mode: Extract<ResetCommitMode, "soft" | "mixed">;
  preview: ResetCommitPreview;
  message: string;
}

const COMMIT_REMOTE_OPERATION_KINDS = new Set<GitOperationEvent["kind"]>(["pull", "push", "sync"]);

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "Git 操作失败，请稍后重试";
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("无法写入剪贴板");
}

function targetKey(target: DiffTarget) {
  return `${target.staged ? "staged" : "unstaged"}:${target.path}`;
}

function shortOid(oid: string) {
  return oid.slice(0, 8);
}

function splitCommitMessage(message: string) {
  const normalized = message.replace(/\r\n/g, "\n").trim();
  const [subject = "", ...bodyLines] = normalized.split("\n");
  return {
    subject: subject.trim(),
    body: bodyLines.join("\n").trim(),
  };
}

function joinCommitMessage(subject: string, body: string) {
  const normalizedSubject = subject.trim();
  const normalizedBody = body.trim();
  return normalizedBody ? `${normalizedSubject}\n\n${normalizedBody}` : normalizedSubject;
}

function WorkspaceSection({
  title,
  entries,
  selected,
  busy,
  actionLabel,
  emptyText,
  onSelect,
  onAction,
  onActionAll,
  actionDisabled = false,
  actionGlyph,
  dangerActionLabel,
  onDangerAction,
  dangerActionAllLabel,
  onDangerActionAll,
}: {
  title: string;
  entries: WorkspaceEntry[];
  selected: DiffTarget | null;
  busy: boolean;
  actionLabel: string;
  emptyText: string;
  onSelect: (entry: WorkspaceEntry) => void;
  onAction: (entry: WorkspaceEntry) => void;
  onActionAll?: () => void;
  actionDisabled?: boolean;
  actionGlyph?: ReactNode;
  dangerActionLabel?: string;
  onDangerAction?: (entry: WorkspaceEntry) => void;
  dangerActionAllLabel?: string;
  onDangerActionAll?: () => void;
}) {
  const hasHeaderActions = entries.length > 0 && Boolean(onActionAll || onDangerActionAll);

  return (
    <section className="scm-section">
      <header>
        <strong>
          {title} <span>{entries.length}</span>
        </strong>
        {hasHeaderActions ? (
          <div className="scm-section-actions">
            {onActionAll ? (
              <button type="button" disabled={busy || actionDisabled} onClick={onActionAll}>
                {actionLabel}全部
              </button>
            ) : null}
            {onDangerActionAll && dangerActionAllLabel ? (
              <button
                className="scm-section-danger-action"
                type="button"
                disabled={busy}
                onClick={onDangerActionAll}
              >
                {dangerActionAllLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {entries.length === 0 ? <p>{emptyText}</p> : null}
      {entries.map((entry) => {
        const key = workspaceEntryKey(entry);
        const isSelected = selected ? key === targetKey(selected) : false;
        const pathParts = entry.change.path.split(/[\\/]/).filter(Boolean);
        const fileName = pathParts.at(-1) ?? entry.change.path;
        const directory = pathParts.slice(0, -1).join("/");
        const changeType = workspaceStatusLabel(entry.change, entry.staged);
        return (
          <div
            className={`scm-row${isSelected ? " selected" : ""}${onDangerAction ? " has-danger-action" : ""}`}
            key={key}
          >
            <button
              className="scm-file-button"
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(entry)}
            >
              <FileTypeBadge path={entry.change.path} className="scm-file-type" />
              <span className="scm-path">
                <strong title={entry.change.path}>{fileName}</strong>
                {directory ? <small title={entry.change.path}>{directory}</small> : null}
                {entry.change.originalPath ? (
                  <small>原路径：{entry.change.originalPath}</small>
                ) : null}
              </span>
            </button>
            <div className="scm-row-trailing">
              <div className="scm-row-actions">
                <button
                  className="scm-action"
                  type="button"
                  title={`${actionLabel}：${entry.change.path}`}
                  aria-label={`${actionLabel}：${entry.change.path}`}
                  disabled={busy || actionDisabled}
                  onClick={() => onAction(entry)}
                >
                  {actionGlyph ??
                    (entry.staged ? (
                      <Minus size={14} weight="bold" />
                    ) : (
                      <Plus size={14} weight="bold" />
                    ))}
                </button>
                {onDangerAction && dangerActionLabel ? (
                  <button
                    className="scm-action scm-danger-action"
                    type="button"
                    title={`${dangerActionLabel}：${entry.change.path}`}
                    aria-label={`${dangerActionLabel}：${entry.change.path}`}
                    disabled={busy}
                    onClick={() => onDangerAction(entry)}
                  >
                    <ArrowCounterClockwise size={14} weight="bold" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <span
                className="scm-change-type"
                data-change-kind={entry.change.kind}
                data-change-type={changeType}
                title={`变更类型：${changeType}`}
              >
                {changeType}
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function WorkspaceView({
  project,
  status,
  refreshing,
  onRefresh,
  onStatusChange,
  onError,
  embedded = false,
  diffPanelVisible = true,
  onDiffFocus,
  onHistoryChange,
  gitOperations,
  onOperationStarted,
}: WorkspaceViewProps) {
  const groups = useMemo(() => groupWorkspaceChanges(status), [status]);
  const summary = useMemo(() => (status ? summarizeRepositoryStatus(status) : null), [status]);
  const allEntries = useMemo(
    () => [...groups.unstaged, ...groups.staged, ...groups.conflicted],
    [groups],
  );
  const [selected, setSelected] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [conflictDetails, setConflictDetails] = useState<ConflictDetails | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<WorkspaceEntry[]>([]);
  const [pendingConflictResolution, setPendingConflictResolution] =
    useState<PendingConflictResolution | null>(null);
  const [mergeRecovery, setMergeRecovery] = useState<MergeRecoveryPreview | null>(null);
  const [loadingMergeRecovery, setLoadingMergeRecovery] = useState(false);
  const [mergeRecoveryError, setMergeRecoveryError] = useState<string | null>(null);
  const [pendingMergeRecoveryAction, setPendingMergeRecoveryAction] =
    useState<MergeRecoveryAction | null>(null);
  const [amendPreview, setAmendPreview] = useState<AmendCommitPreview | null>(null);
  const [loadingAmendPreview, setLoadingAmendPreview] = useState(false);
  const [amendPreviewError, setAmendPreviewError] = useState<string | null>(null);
  const [pendingAmendConfirmation, setPendingAmendConfirmation] = useState(false);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [commitMenuPosition, setCommitMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [pendingUndoCommit, setPendingUndoCommit] = useState<PendingUndoCommit | null>(null);
  const diffRequest = useRef(0);
  const mergeRecoveryRequest = useRef(0);
  const amendPreviewRequest = useRef(0);
  const resetPreviewRequest = useRef(0);
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;
  const commitActionsRef = useRef<HTMLDivElement | null>(null);
  const commitMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const commitMenuRef = useRef<HTMLDivElement | null>(null);
  const worktreeFileDiff = useMemo(() => parseUnifiedDiff(diff?.patch ?? ""), [diff?.patch]);

  useEffect(() => {
    ++diffRequest.current;
    setSelected(null);
    setDiff(null);
    setConflictDetails(null);
    setDiffError(null);
    setNotice(null);
    setPendingDiscard([]);
    setPendingConflictResolution(null);
    ++mergeRecoveryRequest.current;
    setMergeRecovery(null);
    setLoadingMergeRecovery(false);
    setMergeRecoveryError(null);
    setPendingMergeRecoveryAction(null);
    ++amendPreviewRequest.current;
    setAmendPreview(null);
    setLoadingAmendPreview(false);
    setAmendPreviewError(null);
    setPendingAmendConfirmation(false);
    setBusyAction(null);
    setCommitMenuOpen(false);
    setCommitMenuPosition(null);
    ++resetPreviewRequest.current;
    setPendingUndoCommit(null);
    setCommitMessage("");
  }, [project.path]);

  useEffect(() => {
    if (!commitMenuOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      commitMenuRef.current
        ?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!commitActionsRef.current?.contains(target) && !commitMenuRef.current?.contains(target)) {
        setCommitMenuOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCommitMenuOpen(false);
      window.requestAnimationFrame(() => commitMenuButtonRef.current?.focus());
    };
    const closeOnViewportChange = () => setCommitMenuOpen(false);
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [commitMenuOpen]);

  useLayoutEffect(() => {
    if (!commitMenuOpen || !commitMenuRef.current || !commitMenuButtonRef.current) return;
    const buttonRect = commitMenuButtonRef.current.getBoundingClientRect();
    const menuRect = commitMenuRef.current.getBoundingClientRect();
    const viewportPadding = 8;
    const nextLeft = Math.max(
      viewportPadding,
      Math.min(
        buttonRect.right - menuRect.width,
        window.innerWidth - menuRect.width - viewportPadding,
      ),
    );
    const opensAbove =
      buttonRect.bottom + menuRect.height + 4 > window.innerHeight - viewportPadding;
    const nextTop = opensAbove
      ? Math.max(viewportPadding, buttonRect.top - menuRect.height - 4)
      : buttonRect.bottom + 4;
    setCommitMenuPosition((current) =>
      current && Math.abs(current.left - nextLeft) < 1 && Math.abs(current.top - nextTop) < 1
        ? current
        : { left: nextLeft, top: nextTop },
    );
  }, [commitMenuOpen]);

  useEffect(() => {
    if (!status) {
      ++mergeRecoveryRequest.current;
      setMergeRecovery(null);
      setLoadingMergeRecovery(false);
      return;
    }

    const requestId = ++mergeRecoveryRequest.current;
    setLoadingMergeRecovery(true);
    setMergeRecoveryError(null);
    void desktopApi.repository
      .previewMergeRecovery(project.path)
      .then((preview) => {
        if (mergeRecoveryRequest.current === requestId) setMergeRecovery(preview);
      })
      .catch((cause) => {
        if (mergeRecoveryRequest.current === requestId) {
          setMergeRecovery(null);
          setMergeRecoveryError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (mergeRecoveryRequest.current === requestId) setLoadingMergeRecovery(false);
      });
  }, [project.path, status]);

  useEffect(() => {
    if (selected && allEntries.some((entry) => workspaceEntryKey(entry) === targetKey(selected))) {
      return;
    }
    const fallback = groups.unstaged[0] ?? groups.staged[0] ?? groups.conflicted[0] ?? null;
    setSelected(fallback ? { path: fallback.change.path, staged: fallback.staged } : null);
  }, [allEntries, groups, selected]);

  const selectedIsConflict = Boolean(
    selected &&
    groups.conflicted.some(
      (entry) => entry.change.path === selected.path && entry.staged === selected.staged,
    ),
  );
  const selectedEntry = selected
    ? (allEntries.find((entry) => workspaceEntryKey(entry) === targetKey(selected)) ?? null)
    : null;
  const selectedFileName = selected?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const selectedFileAbsolutePath = selected
    ? `${project.path.replace(/[\\/]$/, "")}/${selected.path}`
    : "";
  const remoteOperationBusy = gitOperations.some(
    (operation) =>
      operation.repositoryPath === project.path &&
      COMMIT_REMOTE_OPERATION_KINDS.has(operation.kind) &&
      isActiveGitOperation(operation),
  );

  useEffect(() => {
    if (!selected || !status) {
      ++diffRequest.current;
      setDiff(null);
      setConflictDetails(null);
      setLoadingDiff(false);
      return;
    }

    const requestId = ++diffRequest.current;
    setLoadingDiff(true);
    setDiffError(null);
    setDiff(null);
    setConflictDetails(null);
    const request = selectedIsConflict
      ? desktopApi.repository.conflictDetails(project.path, selected.path)
      : desktopApi.repository.worktreeDiff(project.path, selected.path, selected.staged);
    void request
      .then((preview) => {
        if (diffRequest.current !== requestId) return;
        if (selectedIsConflict) setConflictDetails(preview as ConflictDetails);
        else setDiff(preview as WorktreeDiff);
      })
      .catch((cause) => {
        if (diffRequest.current === requestId) setDiffError(errorMessage(cause));
      })
      .finally(() => {
        if (diffRequest.current === requestId) setLoadingDiff(false);
      });
  }, [project.path, selected, selectedIsConflict, status]);

  function mutationBlocked() {
    return remoteOperationBusy || workspaceMutationBlocked(refreshing, busyAction);
  }

  async function mutate(label: string, operation: () => Promise<{ status: RepositoryStatus }>) {
    if (mutationBlocked()) return false;
    setBusyAction(label);
    setNotice(null);
    try {
      const result = await operation();
      onStatusChange(result.status);
      return true;
    } catch (cause) {
      onError(errorMessage(cause));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  function selectEntry(entry: WorkspaceEntry) {
    onDiffFocus?.();
    setSelected({ path: entry.change.path, staged: entry.staged });
  }

  function stageEntry(entry: WorkspaceEntry) {
    void mutate("stage", () =>
      desktopApi.repository.stage(project.path, pathspecsForChange(entry.change)),
    );
  }

  function unstageEntry(entry: WorkspaceEntry) {
    void mutate("unstage", () =>
      desktopApi.repository.unstage(project.path, pathspecsForChange(entry.change)),
    );
  }

  function requestDiscard(entries: WorkspaceEntry[]) {
    if (entries.length > 256) {
      onError("每次最多放弃 256 个文件，请先缩小更改范围");
      return;
    }
    setPendingDiscard(entries);
  }

  async function confirmDiscard() {
    if (pendingDiscard.length === 0) return;
    const filePaths = pendingDiscard.map((entry) => entry.change.path);
    const discarded = await mutate("discard", () =>
      desktopApi.repository.discardFiles(project.path, filePaths),
    );
    setPendingDiscard([]);
    if (discarded) {
      setNotice(
        filePaths.length === 1
          ? `已放弃 ${filePaths[0]} 的未暂存更改`
          : `已放弃 ${filePaths.length} 个文件的未暂存更改`,
      );
    } else {
      await onRefresh();
    }
  }

  function requestConflictResolution(choice: ConflictResolutionChoice) {
    if (!conflictDetails?.resolvable) return;
    setPendingConflictResolution({ details: conflictDetails, choice });
  }

  async function confirmConflictResolution() {
    if (!pendingConflictResolution || mutationBlocked()) return;
    const { details, choice } = pendingConflictResolution;
    setBusyAction("resolve-conflict");
    setNotice(null);
    try {
      const result = await desktopApi.repository.resolveConflict(project.path, details.path, {
        choice,
        expectedToken: details.token,
      });
      onStatusChange(result.status);
      setPendingConflictResolution(null);
      setNotice(
        `已采用${choice === "current" ? "当前侧（Git stage 2）" : "传入侧（Git stage 3）"}解决 ${details.path}`,
      );
    } catch (cause) {
      setPendingConflictResolution(null);
      onError(errorMessage(cause));
      await onRefresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmMergeRecovery() {
    if (!pendingMergeRecoveryAction || !mergeRecovery || mutationBlocked()) return;
    const action = pendingMergeRecoveryAction;
    setBusyAction(action === "continue" ? "continue-merge" : "abort-merge");
    setNotice(null);
    try {
      const input = { expectedToken: mergeRecovery.token };
      const result =
        action === "continue"
          ? await desktopApi.repository.continueMergeRecovery(project.path, input)
          : await desktopApi.repository.abortMergeRecovery(project.path, input);
      onStatusChange(result.status);
      if (action === "continue") onHistoryChange?.();
      setMergeRecovery(null);
      setPendingMergeRecoveryAction(null);
      setNotice(action === "continue" ? "已完成当前合并" : "已终止当前合并并恢复 merge 前状态");
    } catch (cause) {
      setPendingMergeRecoveryAction(null);
      onError(errorMessage(cause));
      await onRefresh();
    } finally {
      setBusyAction(null);
    }
  }

  async function createNewCommit(followUp: CommitFollowUp) {
    const repositoryPath = project.path;
    const { subject, body } = splitCommitMessage(commitMessage);
    if (
      mutationBlocked() ||
      mergeRecovery !== null ||
      groups.conflicted.length > 0 ||
      (groups.staged.length === 0 && groups.unstaged.length === 0) ||
      !subject.trim()
    )
      return;

    setBusyAction(followUp === "none" ? "commit" : `commit-${followUp}`);
    setNotice(null);
    try {
      if (groups.staged.length === 0) {
        const staged = await desktopApi.repository.stageAll(repositoryPath);
        if (activeRepositoryPath.current === repositoryPath) onStatusChange(staged.status);
      }
      const result = await desktopApi.repository.createCommit(repositoryPath, { subject, body });
      if (activeRepositoryPath.current === repositoryPath) {
        onStatusChange(result.status);
        onHistoryChange?.();
        setCommitMessage("");
      }
      const shortCommit = result.commit.oid.slice(0, 8);
      if (followUp === "none") {
        if (activeRepositoryPath.current === repositoryPath) {
          setNotice(`已创建提交 ${shortCommit}`);
        }
        return;
      }

      try {
        const started =
          followUp === "push"
            ? await desktopApi.repository.push(repositoryPath)
            : await desktopApi.repository.sync(repositoryPath);
        onOperationStarted({
          operationId: started.operationId,
          repositoryPath,
          kind: followUp,
          state: "queued",
          phase: "queued",
          percent: null,
          message: followUp === "push" ? "正在等待推送当前分支" : "正在等待同步当前分支",
          remoteTagDeletePreview: null,
        });
        if (activeRepositoryPath.current === repositoryPath) {
          setNotice(
            followUp === "push"
              ? `已创建提交 ${shortCommit}，正在推送`
              : `已创建提交 ${shortCommit}，正在同步`,
          );
        }
      } catch (cause) {
        if (activeRepositoryPath.current === repositoryPath) {
          onError(
            `已创建提交 ${shortCommit}，但${followUp === "push" ? "推送" : "同步"}未能启动：${errorMessage(cause)}`,
          );
        }
      }
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  async function submitCommit(event: FormEvent) {
    event.preventDefault();
    if (!amendPreview) {
      await createNewCommit("none");
      return;
    }

    const { subject } = splitCommitMessage(commitMessage);
    if (mutationBlocked() || mergeRecovery !== null || groups.conflicted.length > 0 || !subject) {
      return;
    }
    const repositoryPath = project.path;
    const requestId = ++amendPreviewRequest.current;
    setBusyAction("preview-amend");
    setNotice(null);
    setAmendPreviewError(null);
    try {
      const refreshed = await desktopApi.repository.previewAmendCommit(repositoryPath);
      if (amendPreviewRequest.current !== requestId) return;
      setAmendPreview(refreshed);
      if (!refreshed.canAmend) {
        setAmendPreviewError("当前 HEAD 已被本地已知的远端引用或标签引用，不能安全修改。");
        return;
      }
      setPendingAmendConfirmation(true);
    } catch (cause) {
      if (amendPreviewRequest.current === requestId) setAmendPreviewError(errorMessage(cause));
    } finally {
      if (amendPreviewRequest.current === requestId) setBusyAction(null);
    }
  }

  async function beginAmend(intent: AmendIntent = "edit-message") {
    if (
      mutationBlocked() ||
      mergeRecovery !== null ||
      groups.conflicted.length > 0 ||
      !status?.branch.oid
    )
      return;
    const repositoryPath = project.path;
    const requestId = ++amendPreviewRequest.current;
    const currentDraft = commitMessage;
    setLoadingAmendPreview(true);
    setBusyAction("preview-amend");
    setAmendPreviewError(null);
    setNotice(null);
    try {
      let preview = await desktopApi.repository.previewAmendCommit(repositoryPath);
      if (amendPreviewRequest.current !== requestId) return;
      if (!preview.canAmend) {
        setAmendPreview(preview);
        setAmendPreviewError("当前 HEAD 已被本地已知的远端引用或标签引用，不能安全修改。");
        return;
      }
      if (intent === "submit" && groups.staged.length === 0 && groups.unstaged.length > 0) {
        const staged = await desktopApi.repository.stageAll(repositoryPath);
        if (amendPreviewRequest.current !== requestId) return;
        onStatusChange(staged.status);
        preview = await desktopApi.repository.previewAmendCommit(repositoryPath);
        if (amendPreviewRequest.current !== requestId) return;
      }
      setAmendPreview(preview);
      if (intent === "edit-message" || !currentDraft.trim()) {
        setCommitMessage(joinCommitMessage(preview.currentSubject, preview.currentBody));
      }
      if (intent === "submit") {
        if (!preview.canAmend) {
          setAmendPreviewError("当前 HEAD 已被本地已知的远端引用或标签引用，不能安全修改。");
          return;
        }
        setPendingAmendConfirmation(true);
      }
    } catch (cause) {
      if (amendPreviewRequest.current === requestId) {
        setAmendPreview(null);
        setAmendPreviewError(errorMessage(cause));
      }
    } finally {
      if (amendPreviewRequest.current === requestId) {
        setLoadingAmendPreview(false);
        setBusyAction(null);
      }
    }
  }

  function cancelAmend() {
    ++amendPreviewRequest.current;
    setAmendPreview(null);
    setLoadingAmendPreview(false);
    setAmendPreviewError(null);
    setPendingAmendConfirmation(false);
    setCommitMessage("");
  }

  async function confirmAmend() {
    if (!amendPreview || !pendingAmendConfirmation || mutationBlocked()) return;
    const repositoryPath = project.path;
    const requestId = amendPreviewRequest.current;
    const { subject, body } = splitCommitMessage(commitMessage);
    if (!subject) return;
    setBusyAction("amend");
    setNotice(null);
    try {
      const result = await desktopApi.repository.amendCommit(repositoryPath, {
        subject,
        body,
        expectedToken: amendPreview.token,
      });
      if (
        activeRepositoryPath.current !== repositoryPath ||
        amendPreviewRequest.current !== requestId
      )
        return;
      onStatusChange(result.status);
      onHistoryChange?.();
      setPendingAmendConfirmation(false);
      setAmendPreview(null);
      setAmendPreviewError(null);
      setCommitMessage("");
      setNotice(`已将 ${shortOid(result.previousOid)} 替换为 ${shortOid(result.commit.oid)}`);
    } catch (cause) {
      if (
        activeRepositoryPath.current !== repositoryPath ||
        amendPreviewRequest.current !== requestId
      )
        return;
      setPendingAmendConfirmation(false);
      onError(errorMessage(cause));
      await onRefresh();
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  function toggleCommitMenu() {
    if (commitMenuOpen) {
      setCommitMenuOpen(false);
      return;
    }
    const rect = commitMenuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      const estimatedWidth = 218;
      setCommitMenuPosition({
        left: Math.max(
          8,
          Math.min(rect.right - estimatedWidth, window.innerWidth - estimatedWidth - 8),
        ),
        top: rect.bottom + 4,
      });
    }
    setCommitMenuOpen(true);
  }

  function handleCommitMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setCommitMenuOpen(false);
      window.requestAnimationFrame(() => commitMenuButtonRef.current?.focus());
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  async function beginUndoLastCommit(mode: PendingUndoCommit["mode"]) {
    const repositoryPath = project.path;
    const selectedOid = status?.branch.oid;
    if (mutationBlocked() || !selectedOid || mergeRecovery !== null) return;
    if (status.changes.length > 0) {
      onError("撤销上次提交前必须保持工作区干净");
      return;
    }

    const requestId = ++resetPreviewRequest.current;
    setBusyAction("preview-reset");
    setNotice(null);
    try {
      const [preview, details] = await Promise.all([
        desktopApi.repository.previewResetCommit(repositoryPath, selectedOid, mode),
        desktopApi.repository.commit(repositoryPath, selectedOid),
      ]);
      if (resetPreviewRequest.current !== requestId) return;
      setPendingUndoCommit({
        mode,
        preview,
        message: joinCommitMessage(details.commit.subject, details.body),
      });
    } catch (cause) {
      if (resetPreviewRequest.current === requestId) onError(errorMessage(cause));
    } finally {
      if (resetPreviewRequest.current === requestId) setBusyAction(null);
    }
  }

  async function confirmUndoLastCommit() {
    if (!pendingUndoCommit || mutationBlocked()) return;
    const repositoryPath = project.path;
    const requestId = resetPreviewRequest.current;
    const { mode, preview, message } = pendingUndoCommit;
    setBusyAction("reset-commit");
    setNotice(null);
    try {
      const result = await desktopApi.repository.resetCommit(repositoryPath, {
        selectedOid: preview.selectedOid,
        mode,
        expectedToken: preview.token,
      });
      if (
        activeRepositoryPath.current !== repositoryPath ||
        resetPreviewRequest.current !== requestId
      )
        return;
      onStatusChange(result.status);
      onHistoryChange?.();
      setPendingUndoCommit(null);
      setCommitMessage(message);
      setNotice(
        mode === "soft" ? "已撤销上次提交，更改保留在暂存区" : "已撤销上次提交，更改已取消暂存",
      );
    } catch (cause) {
      if (
        activeRepositoryPath.current !== repositoryPath ||
        resetPreviewRequest.current !== requestId
      )
        return;
      setPendingUndoCommit(null);
      onError(errorMessage(cause));
      await onRefresh();
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  const busy = remoteOperationBusy || workspaceMutationBlocked(refreshing, busyAction);
  const commitSubject = splitCommitMessage(commitMessage).subject;
  const hasCommitChanges = groups.staged.length > 0 || groups.unstaged.length > 0;
  const commitDisabled =
    busy ||
    mergeRecovery !== null ||
    groups.conflicted.length > 0 ||
    !hasCommitChanges ||
    !commitSubject;
  const amendFormDisabled =
    busy ||
    mergeRecovery !== null ||
    groups.conflicted.length > 0 ||
    !commitSubject ||
    !amendPreview?.canAmend;
  const remoteCommitDisabled = commitDisabled || !status?.branch.upstream;
  const amendDisabled =
    busy || mergeRecovery !== null || groups.conflicted.length > 0 || !status?.branch.oid;
  const amendSubmitDisabled = amendDisabled;
  const undoDisabled =
    busy || mergeRecovery !== null || !status?.branch.oid || (status?.changes.length ?? 0) > 0;
  const commitMenuDisabled = commitDisabled && amendDisabled && undoDisabled;

  function handleCommitMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className={`workspace-layout${embedded ? " embedded" : ""}`}>
      <aside className="scm-panel" aria-label="源代码管理">
        <header className="scm-panel-header">
          <div className="workbench-panel-title">
            <CaretDown size={14} weight="bold" aria-hidden="true" />
            <h3>更改</h3>
            <span>{status?.changes.length ?? 0}</span>
          </div>
          <button
            className="icon-button scm-refresh-button"
            type="button"
            disabled={refreshing || busy}
            onClick={() => void onRefresh()}
            aria-label={refreshing ? "正在刷新仓库状态" : "刷新仓库状态"}
            title="刷新仓库状态"
          >
            <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
          </button>
        </header>

        <div className="scm-panel-body">
          <div className="workspace-summary" aria-label="仓库状态摘要">
            <span>
              暂存 <strong>{summary?.staged ?? "—"}</strong>
            </span>
            <span>
              未暂存 <strong>{summary?.unstaged ?? "—"}</strong>
            </span>
            <span>
              未跟踪 <strong>{summary?.untracked ?? "—"}</strong>
            </span>
            <span className={summary?.conflicted ? "danger" : ""}>
              冲突 <strong>{summary?.conflicted ?? "—"}</strong>
            </span>
          </div>

          {mergeRecovery ? (
            <section className="merge-recovery-card" aria-label="当前合并恢复状态">
              <header>
                <div>
                  <p className="eyebrow danger">MERGE IN PROGRESS</p>
                  <strong>合并进行中</strong>
                </div>
                {loadingMergeRecovery ? <span>刷新中…</span> : null}
              </header>
              <dl>
                <div>
                  <dt>当前分支</dt>
                  <dd>{mergeRecovery.currentBranch ?? "Detached HEAD"}</dd>
                </div>
                <div>
                  <dt>HEAD</dt>
                  <dd title={mergeRecovery.headOid}>{shortOid(mergeRecovery.headOid)}</dd>
                </div>
                <div>
                  <dt>MERGE_HEAD</dt>
                  <dd title={mergeRecovery.mergeHeadOid}>{shortOid(mergeRecovery.mergeHeadOid)}</dd>
                </div>
                <div>
                  <dt>未解决冲突</dt>
                  <dd>{mergeRecovery.unresolvedConflictCount}</dd>
                </div>
              </dl>
              {mergeRecovery.unresolvedConflictCount > 0 ? (
                <p>请先逐个采用冲突版本。普通暂存与提交不能绕过专用冲突流程。</p>
              ) : mergeRecovery.hasUnstagedChanges ? (
                <p>仍有未暂存或未跟踪更改。处理并暂存需要进入 merge commit 的内容后才能继续。</p>
              ) : (
                <p>合并已可继续。当前 index 中的全部暂存内容都会进入 merge commit。</p>
              )}
              <div className="merge-recovery-actions">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={busy || !mergeRecovery.canContinue || loadingMergeRecovery}
                  onClick={() => setPendingMergeRecoveryAction("continue")}
                >
                  {busyAction === "continue-merge" ? "继续中…" : "继续合并"}
                </button>
                <button
                  className="danger-button compact-button"
                  type="button"
                  disabled={busy || loadingMergeRecovery}
                  onClick={() => setPendingMergeRecoveryAction("abort")}
                >
                  {busyAction === "abort-merge" ? "终止中…" : "终止合并"}
                </button>
              </div>
            </section>
          ) : mergeRecoveryError ? (
            <p className="merge-recovery-error">无法读取合并恢复状态：{mergeRecoveryError}</p>
          ) : null}

          <form className="commit-form" onSubmit={submitCommit}>
            {amendPreview ? (
              <div className="commit-form-header">
                <label htmlFor="commit-message">修改 Commit Message</label>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={busy}
                  onClick={cancelAmend}
                >
                  取消 Amend
                </button>
              </div>
            ) : null}
            {amendPreview ? (
              <section className="amend-preview-card" aria-label="安全修改提交预览">
                <div className="amend-preview-title">
                  <div>
                    <p className="eyebrow">AMEND HEAD</p>
                    <strong>{amendPreview.currentBranch}</strong>
                  </div>
                  <code title={amendPreview.headOid}>{shortOid(amendPreview.headOid)}</code>
                </div>
                <dl>
                  <div>
                    <dt>最近预览的暂存文件</dt>
                    <dd>{amendPreview.stagedChangeCount}</dd>
                  </div>
                  <div>
                    <dt>执行方式</dt>
                    <dd>
                      {amendPreview.stagedChangeCount === 0 ? "仅修改信息" : "信息与暂存内容"}
                    </dd>
                  </div>
                </dl>
                {amendPreview.blockingRefs.length > 0 ? (
                  <div className="amend-blocking-refs">
                    <strong>检测到阻止修改的引用</strong>
                    {amendPreview.blockingRefs.map((reference) => (
                      <code key={reference}>{reference}</code>
                    ))}
                  </div>
                ) : (
                  <p>
                    提交前会重新校验 HEAD、分支、提交元数据与完整 index。0
                    个暂存文件时只修改提交信息。
                  </p>
                )}
                <p>
                  Amend 会重写 commit OID；不会执行 commit
                  hooks、编辑器或本次提交签名。未暂存与未跟踪内容不会进入新提交。
                </p>
              </section>
            ) : null}
            {amendPreviewError ? (
              <p className="amend-preview-error">无法安全修改提交：{amendPreviewError}</p>
            ) : null}
            <textarea
              id="commit-message"
              className="commit-message-input"
              value={commitMessage}
              maxLength={65_536}
              rows={2}
              aria-label="Commit Message"
              placeholder={`消息（⌘/Ctrl + Enter）在“${status?.branch.head ?? "当前分支"}”提交`}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={handleCommitMessageKeyDown}
            />
            <div className="commit-submit-row" ref={commitActionsRef}>
              <button
                className="primary-button commit-button"
                type="submit"
                disabled={amendPreview ? amendFormDisabled : commitDisabled}
              >
                <Check size={14} weight="bold" aria-hidden="true" />
                {busyAction === "commit"
                  ? "提交中…"
                  : busyAction === "preview-amend"
                    ? "重新校验中…"
                    : amendPreview
                      ? amendPreview.stagedChangeCount === 0
                        ? "预览并修改提交信息"
                        : `预览并修改提交（${groups.staged.length} 个暂存文件）`
                      : "提交"}
              </button>
              {!amendPreview ? (
                <button
                  ref={commitMenuButtonRef}
                  className="primary-button commit-menu-button"
                  type="button"
                  disabled={commitMenuDisabled || loadingAmendPreview}
                  aria-label="更多提交操作"
                  aria-haspopup="menu"
                  aria-expanded={commitMenuOpen}
                  aria-controls={commitMenuOpen ? "commit-action-menu" : undefined}
                  title="更多提交操作"
                  onClick={toggleCommitMenu}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown") return;
                    event.preventDefault();
                    if (!commitMenuOpen) toggleCommitMenu();
                  }}
                >
                  <CaretDown size={13} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {groups.conflicted.length > 0 ? (
              <p className="operation-warning">先解决全部冲突，才能暂存、取消暂存或提交。</p>
            ) : null}
            {notice ? <p className="operation-notice">{notice}</p> : null}
          </form>

          {commitMenuOpen && commitMenuPosition
            ? createPortal(
                <div
                  id="commit-action-menu"
                  ref={commitMenuRef}
                  className="commit-menu-popover"
                  role="menu"
                  aria-label="提交操作"
                  style={{ left: commitMenuPosition.left, top: commitMenuPosition.top }}
                  onKeyDown={handleCommitMenuKeyDown}
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={commitDisabled}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void createNewCommit("none");
                    }}
                  >
                    提交
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={amendSubmitDisabled}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void beginAmend("submit");
                    }}
                  >
                    提交(修改)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={remoteCommitDisabled}
                    title={!status?.branch.upstream ? "当前分支没有远端上游" : undefined}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void createNewCommit("push");
                    }}
                  >
                    提交和推送
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={remoteCommitDisabled}
                    title={!status?.branch.upstream ? "当前分支没有远端上游" : undefined}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void createNewCommit("sync");
                    }}
                  >
                    提交和同步
                  </button>
                  <div className="commit-menu-separator" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={amendDisabled}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void beginAmend("edit-message");
                    }}
                  >
                    修改上次提交信息
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={undoDisabled}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void beginUndoLastCommit("soft");
                    }}
                  >
                    撤销上次提交，保留更改
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={undoDisabled}
                    onClick={() => {
                      setCommitMenuOpen(false);
                      void beginUndoLastCommit("mixed");
                    }}
                  >
                    撤销上次提交，取消暂存
                  </button>
                </div>,
                document.body,
              )
            : null}

          {refreshing && !status ? <p className="panel-message">正在读取仓库状态…</p> : null}
          {status && status.changes.length === 0 ? (
            <p className="panel-message success">工作区干净，没有未提交变更。</p>
          ) : null}

          <div className="scm-sections">
            <WorkspaceSection
              title="暂存的更改"
              entries={groups.staged}
              selected={selected}
              busy={busy}
              actionLabel="取消暂存"
              emptyText="没有已暂存改动。"
              onSelect={selectEntry}
              onAction={unstageEntry}
              actionDisabled={groups.conflicted.length > 0}
              onActionAll={() =>
                void mutate("unstage-all", () => desktopApi.repository.unstageAll(project.path))
              }
            />
            <WorkspaceSection
              title="更改"
              entries={groups.unstaged}
              selected={selected}
              busy={busy}
              actionLabel="暂存"
              emptyText="没有未暂存改动。"
              onSelect={selectEntry}
              onAction={stageEntry}
              actionDisabled={groups.conflicted.length > 0}
              onActionAll={() =>
                void mutate("stage-all", () => desktopApi.repository.stageAll(project.path))
              }
              dangerActionLabel="放弃更改"
              onDangerAction={(entry) => requestDiscard([entry])}
              dangerActionAllLabel="放弃全部"
              onDangerActionAll={() => requestDiscard(groups.unstaged)}
            />
            {groups.conflicted.length > 0 ? (
              <WorkspaceSection
                title="冲突"
                entries={groups.conflicted}
                selected={selected}
                busy={busy}
                actionLabel="查看"
                actionGlyph={<ArrowRight size={14} weight="bold" />}
                emptyText="没有冲突文件。"
                onSelect={selectEntry}
                onAction={selectEntry}
              />
            ) : null}
          </div>
        </div>
      </aside>

      <section
        className={`worktree-diff-panel${diffPanelVisible ? " workbench-diff-visible" : ""}`}
        aria-label="工作区差异"
        aria-hidden={embedded && !diffPanelVisible ? true : undefined}
      >
        <header className="editor-file-tab-row">
          <div className="editor-file-tab">
            <FileText size={14} aria-hidden="true" />
            <strong title={selected?.path}>{selectedFileName ?? "选择文件"}</strong>
            {selected ? (
              <small>
                {selectedIsConflict
                  ? "冲突"
                  : selected.staged
                    ? "已暂存"
                    : selectedEntry
                      ? workspaceStatusLabel(selectedEntry.change, false)
                      : "修改"}
              </small>
            ) : null}
          </div>
          <div className="editor-file-actions">
            <button
              className="icon-button"
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                void copyText(selectedFileAbsolutePath).catch((cause) =>
                  onError(errorMessage(cause)),
                );
              }}
              aria-label="复制文件绝对路径"
              title="复制文件绝对路径"
            >
              <Copy size={14} aria-hidden="true" />
            </button>
            <button
              className="icon-button scm-refresh-button"
              type="button"
              disabled={refreshing || busy}
              onClick={() => void onRefresh()}
              aria-label="刷新文件差异"
              title="刷新文件差异"
            >
              <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={!selected}
              onClick={() => setSelected(null)}
              aria-label="关闭文件 Diff"
              title="关闭文件 Diff"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="editor-file-breadcrumb">
          <span>{selected?.staged ? "已暂存的更改" : "更改"}</span>
          <span title={selected?.path}>{selected?.path ?? "选择文件查看差异"}</span>
        </div>

        {loadingDiff ? (
          <p className="panel-message">
            {selectedIsConflict ? "正在读取冲突版本…" : "正在读取文件差异…"}
          </p>
        ) : null}
        {diffError ? <p className="panel-message error-message">{diffError}</p> : null}
        {!selected && !refreshing ? (
          <p className="panel-message">工作区没有可预览的文件。</p>
        ) : null}
        {conflictDetails ? (
          <div className="conflict-resolution-panel">
            <p className="conflict-side-warning">
              “当前侧”对应 Git index stage 2，“传入侧”对应 stage 3。rebase
              等流程中，两侧含义可能与分支名称直觉不同。
            </p>
            {conflictDetails.unsupportedReason ? (
              <p className="panel-message error-message">{conflictDetails.unsupportedReason}</p>
            ) : null}
            <div className="conflict-side-grid">
              {[
                {
                  choice: "current" as const,
                  title: "当前侧（Git stage 2）",
                  side: conflictDetails.current,
                },
                {
                  choice: "incoming" as const,
                  title: "传入侧（Git stage 3）",
                  side: conflictDetails.incoming,
                },
              ].map(({ choice, title, side }) => (
                <section className="conflict-side" key={choice}>
                  <header>
                    <div>
                      <strong>{title}</strong>
                      <span>{side.exists ? "文件存在" : "此侧删除文件"}</span>
                    </div>
                    <button
                      className={
                        side.exists
                          ? "secondary-button compact-button"
                          : "danger-button compact-button"
                      }
                      type="button"
                      disabled={busy || !conflictDetails.resolvable}
                      onClick={() => requestConflictResolution(choice)}
                    >
                      采用此版本
                    </button>
                  </header>
                  {side.content !== null ? (
                    <pre tabIndex={0}>{side.content}</pre>
                  ) : !side.exists ? (
                    <p>采用此侧会删除工作区中的该文件，并将删除结果标记为已解决。</p>
                  ) : conflictDetails.contentTruncated ? (
                    <p>内容超过 1 MiB，不在界面中预览；仍可在确认后采用该版本。</p>
                  ) : conflictDetails.isBinary ? (
                    <p>该冲突包含二进制或非 UTF-8 内容，无法显示文本预览。</p>
                  ) : (
                    <p>{conflictDetails.unsupportedReason ?? "该版本没有可显示的文本内容。"}</p>
                  )}
                </section>
              ))}
            </div>
          </div>
        ) : null}
        {diff ? (
          <div className="worktree-patch">
            {diff.patchTruncated ? <p>内容超过 2 MiB，已截断</p> : null}
            {diff.image ? (
              <ImageDiffView diff={diff.image} />
            ) : diff.patch ? (
              <UnifiedDiffView diff={worktreeFileDiff} />
            ) : (
              <p className="panel-message">该文件没有可显示的文本差异。</p>
            )}
          </div>
        ) : null}
      </section>

      {pendingConflictResolution ? (
        <Dialog
          open
          className="confirmation-dialog"
          role="alertdialog"
          ariaLabelledBy="conflict-dialog-title"
          ariaDescribedBy="conflict-dialog-description"
          busy={busy}
          onClose={() => setPendingConflictResolution(null)}
        >
          <p className="eyebrow danger">DESTRUCTIVE ACTION</p>
          <h2 id="conflict-dialog-title">采用所选冲突版本</h2>
          <p id="conflict-dialog-description">
            此操作会覆盖当前工作区文件，并使用
            {pendingConflictResolution.choice === "current"
              ? "当前侧（Git stage 2）"
              : "传入侧（Git stage 3）"}
            标记冲突已解决。rebase 等流程中的两侧语义可能与分支名称直觉不同。
            {!pendingConflictResolution.details[pendingConflictResolution.choice].exists
              ? " 所选侧不存在文件，因此目标文件会被删除。"
              : ""}
          </p>
          <code>{pendingConflictResolution.details.path}</code>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => setPendingConflictResolution(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmConflictResolution()}
            >
              {busyAction === "resolve-conflict" ? "正在解决…" : "确认采用"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {pendingMergeRecoveryAction && mergeRecovery ? (
        <Dialog
          open
          className="confirmation-dialog merge-recovery-dialog"
          role="alertdialog"
          ariaLabelledBy="merge-recovery-dialog-title"
          ariaDescribedBy="merge-recovery-dialog-description"
          busy={busy}
          onClose={() => setPendingMergeRecoveryAction(null)}
        >
          <p className={`eyebrow${pendingMergeRecoveryAction === "abort" ? " danger" : ""}`}>
            {pendingMergeRecoveryAction === "abort" ? "DESTRUCTIVE ACTION" : "MERGE RECOVERY"}
          </p>
          <h2 id="merge-recovery-dialog-title">
            {pendingMergeRecoveryAction === "continue" ? "继续当前合并" : "终止当前合并"}
          </h2>
          <p id="merge-recovery-dialog-description">
            {pendingMergeRecoveryAction === "continue"
              ? "应用会重新校验 HEAD、MERGE_HEAD、index、工作区和合并消息，然后以关闭编辑器与提交签名交互的方式执行 git merge --continue。当前全部暂存内容都会进入 merge commit。"
              : "应用会重新校验当前合并快照，再执行 git merge --abort，尝试恢复 merge 开始前的 tracked 状态。merge 期间产生的本地更改可能丢失；未跟踪文件不保证会被删除。"}
          </p>
          <dl className="merge-preview-grid">
            <div>
              <dt>当前分支</dt>
              <dd>{mergeRecovery.currentBranch ?? "Detached HEAD"}</dd>
            </div>
            <div>
              <dt>合并目标</dt>
              <dd title={mergeRecovery.mergeHeadOid}>{shortOid(mergeRecovery.mergeHeadOid)}</dd>
            </div>
          </dl>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => setPendingMergeRecoveryAction(null)}
            >
              取消
            </button>
            <button
              className={
                pendingMergeRecoveryAction === "abort" ? "danger-button" : "primary-button"
              }
              type="button"
              disabled={
                busy || (pendingMergeRecoveryAction === "continue" && !mergeRecovery.canContinue)
              }
              onClick={() => void confirmMergeRecovery()}
            >
              {busyAction === "continue-merge"
                ? "继续中…"
                : busyAction === "abort-merge"
                  ? "终止中…"
                  : pendingMergeRecoveryAction === "continue"
                    ? "确认继续"
                    : "确认终止"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {pendingAmendConfirmation && amendPreview ? (
        <Dialog
          open
          className="confirmation-dialog amend-dialog"
          role="alertdialog"
          ariaLabelledBy="amend-dialog-title"
          ariaDescribedBy="amend-dialog-description"
          busy={busy}
          onClose={() => setPendingAmendConfirmation(false)}
        >
          <p className="eyebrow danger">HISTORY REWRITE</p>
          <h2 id="amend-dialog-title">确认修改当前 HEAD 提交</h2>
          <p id="amend-dialog-description">
            当前 HEAD 会被一个新 commit 替换，原 author 与 parents 保留，committer 与 commit OID
            会更新。 index 中全部暂存内容会进入新提交；未暂存和未跟踪内容不会进入。
          </p>
          <dl className="merge-preview-grid">
            <div>
              <dt>当前分支</dt>
              <dd>{amendPreview.currentBranch}</dd>
            </div>
            <div>
              <dt>将被替换的 HEAD</dt>
              <dd title={amendPreview.headOid}>{shortOid(amendPreview.headOid)}</dd>
            </div>
            <div>
              <dt>暂存文件</dt>
              <dd>{amendPreview.stagedChangeCount}</dd>
            </div>
            <div>
              <dt>提交 hooks</dt>
              <dd>不执行</dd>
            </div>
          </dl>
          <p className="amend-dialog-note">
            应用已阻止本地已知远端引用或标签包含当前 HEAD 的情况，但无法证明尚未 fetch
            的服务器状态。 Detached HEAD 与进行中的 merge、rebase、cherry-pick 或 revert 不允许
            Amend。
          </p>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => setPendingAmendConfirmation(false)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmAmend()}
            >
              {busyAction === "amend" ? "修改中…" : "确认修改提交"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {pendingUndoCommit ? (
        <Dialog
          open
          className="confirmation-dialog commit-undo-dialog"
          role="alertdialog"
          ariaLabelledBy="undo-commit-dialog-title"
          ariaDescribedBy="undo-commit-dialog-description"
          busy={busy}
          returnFocusElement={commitMenuButtonRef.current}
          onClose={() => setPendingUndoCommit(null)}
        >
          <p className="eyebrow danger">HISTORY REWRITE</p>
          <h2 id="undo-commit-dialog-title">确认撤销上次提交</h2>
          <p id="undo-commit-dialog-description">
            当前分支会移动到上次提交的父提交。提交内容不会丢失，
            {pendingUndoCommit.mode === "soft"
              ? "全部更改将保留在暂存区。"
              : "全部更改将保留在工作区并取消暂存。"}
          </p>
          <dl className="merge-preview-grid">
            <div>
              <dt>当前分支</dt>
              <dd>{pendingUndoCommit.preview.currentBranch}</dd>
            </div>
            <div>
              <dt>将撤销的提交</dt>
              <dd title={pendingUndoCommit.preview.selectedOid}>
                {shortOid(pendingUndoCommit.preview.selectedOid)}
              </dd>
            </div>
            <div>
              <dt>分支将移动到</dt>
              <dd title={pendingUndoCommit.preview.targetOid}>
                {shortOid(pendingUndoCommit.preview.targetOid)}
              </dd>
            </div>
            <div>
              <dt>更改状态</dt>
              <dd>{pendingUndoCommit.mode === "soft" ? "保留暂存" : "取消暂存"}</dd>
            </div>
          </dl>
          <p className="commit-undo-subject" title={pendingUndoCommit.preview.selectedSubject}>
            {pendingUndoCommit.preview.selectedSubject || "无标题提交"}
          </p>
          <p className="amend-dialog-note">
            执行前会再次校验当前 HEAD、分支和工作区状态。成功后，原 Commit Message 会恢复到输入框。
          </p>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => setPendingUndoCommit(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmUndoLastCommit()}
            >
              {busyAction === "reset-commit"
                ? "撤销中…"
                : pendingUndoCommit.mode === "soft"
                  ? "撤销并保留暂存"
                  : "撤销并取消暂存"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {pendingDiscard.length > 0 ? (
        <Dialog
          open
          className="confirmation-dialog"
          role="alertdialog"
          ariaLabelledBy="discard-dialog-title"
          ariaDescribedBy="discard-dialog-description"
          busy={busy}
          onClose={() => setPendingDiscard([])}
        >
          <p className="eyebrow danger">DESTRUCTIVE ACTION</p>
          <h2 id="discard-dialog-title">
            {pendingDiscard.length === 1
              ? "放弃文件更改"
              : `放弃 ${pendingDiscard.length} 个文件的更改`}
          </h2>
          <p id="discard-dialog-description">
            该操作无法从 Git
            恢复未提交内容。只会放弃工作区中的未暂存更改；同一文件已有的暂存内容会保留。批量执行前会重新校验完整文件列表，失败后将刷新实际状态。
          </p>
          <div className="discard-file-list" aria-label="将放弃更改的文件">
            {pendingDiscard.slice(0, 8).map((entry) => (
              <code key={entry.change.path}>{entry.change.path}</code>
            ))}
            {pendingDiscard.length > 8 ? <p>以及另外 {pendingDiscard.length - 8} 个文件</p> : null}
          </div>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              autoFocus
              onClick={() => setPendingDiscard([])}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmDiscard()}
            >
              {busyAction === "discard" ? "正在放弃…" : "确认放弃"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
