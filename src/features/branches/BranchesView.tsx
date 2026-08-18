import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { Dialog } from "../../app/Dialog";
import {
  desktopApi,
  type BranchInfo,
  type GitOperationEvent,
  type LocalMergePreview,
  type LocalMergeStrategy,
  type Project,
  type RemoteDeletePreview,
  type RemoteEditPreview,
  type RepositoryRefs,
  type RepositoryStatus,
} from "../../platform/desktop";
import {
  branchDivergenceLabel,
  canSubmitRemoteCreate,
  canSubmitRemoteUpdate,
  groupBranches,
  isCurrentRepositoryRequest,
} from "./branches";
import {
  isActiveGitOperation,
  isTerminalGitOperation,
  latestRepositoryOperation,
} from "../operations/gitOperations";

const BRANCH_OPERATION_KINDS = new Set<GitOperationEvent["kind"]>(["fetch", "pull", "push"]);

interface BranchesViewProps {
  project: Project;
  onStatusChange: (status: RepositoryStatus) => void;
  onError: (message: string) => void;
  gitOperations: GitOperationEvent[];
  onOperationStarted: (operation: GitOperationEvent) => void;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "分支操作失败，请稍后重试";
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return null;
}

function BranchRow({
  branch,
  busy,
  onSwitch,
  onPull,
  pullLabel,
  onPush,
  pushLabel,
  onTrack,
  trackLabel,
  trackDisabled,
  onMerge,
  mergeLabel,
  onDelete,
  deleteLabel,
}: {
  branch: BranchInfo;
  busy: boolean;
  onSwitch?: (branch: BranchInfo) => void;
  onPull?: () => void;
  pullLabel?: string;
  onPush?: () => void;
  pushLabel?: string;
  onTrack?: () => void;
  trackLabel?: string;
  trackDisabled?: boolean;
  onMerge?: () => void;
  mergeLabel?: string;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  const divergence = branchDivergenceLabel(branch);
  return (
    <article className={`branch-row${branch.current ? " current" : ""}`}>
      <div className="branch-row-copy">
        <div>
          <strong>{branch.name}</strong>
          {branch.current ? <span className="current-branch-badge">当前</span> : null}
        </div>
        <small>
          {branch.upstream
            ? `上游 ${branch.upstream}`
            : branch.kind === "local"
              ? "未设置上游"
              : "远端引用"}
          {divergence ? ` · ${divergence}` : ""}
        </small>
      </div>
      <code>{branch.oid.slice(0, 8)}</code>
      {onSwitch || onPull || onPush || onTrack || onMerge || onDelete ? (
        <div className="branch-row-actions">
          {onPull ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={busy || !branch.upstream || branch.upstreamMissing}
              title="只接受可直接快进的上游更新，不会自动 merge 或 rebase"
              onClick={onPull}
            >
              {pullLabel ?? "Pull"}
            </button>
          ) : null}
          {onPush ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={busy || !branch.upstream || branch.upstreamMissing || branch.ahead <= 0}
              title="只推送当前分支到已配置的上游，不支持 force push 或创建远端分支"
              onClick={onPush}
            >
              {pushLabel ?? "Push"}
            </button>
          ) : null}
          {onSwitch ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={busy || branch.current}
              onClick={() => onSwitch(branch)}
            >
              {branch.current ? "已检出" : "切换"}
            </button>
          ) : null}
          {onTrack ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={busy || trackDisabled}
              title={trackDisabled ? "同名本地分支已存在" : "创建本地分支并设置该远端分支为上游"}
              onClick={onTrack}
            >
              {trackLabel ?? (trackDisabled ? "已有本地分支" : "创建跟踪分支")}
            </button>
          ) : null}
          {onMerge ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={busy || branch.current}
              title="先预览提交关系，再把该本地分支合并到当前分支"
              onClick={onMerge}
            >
              {mergeLabel ?? "合并到当前"}
            </button>
          ) : null}
          {onDelete ? (
            <button
              className="danger-button compact-button"
              type="button"
              disabled={busy}
              title="只删除本地分支，不会删除远端分支"
              onClick={onDelete}
            >
              {deleteLabel ?? "删除"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function BranchesView({
  project,
  onStatusChange,
  onError,
  gitOperations,
  onOperationStarted,
}: BranchesViewProps) {
  const [refs, setRefs] = useState<RepositoryRefs | null>(null);
  const [query, setQuery] = useState("");
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    branch: BranchInfo;
    allowUnmerged: boolean;
  } | null>(null);
  const [mergeConfirmation, setMergeConfirmation] = useState<{
    preview: LocalMergePreview;
    strategy: LocalMergeStrategy;
  } | null>(null);
  const [remoteForm, setRemoteForm] = useState<
    | {
        mode: "create";
        name: string;
        fetchUrl: string;
        pushUrl: string;
      }
    | {
        mode: "edit";
        preview: RemoteEditPreview;
        fetchUrl: string;
        pushUrl: string;
        resetPushUrl: boolean;
      }
    | null
  >(null);
  const [remoteDeletePreview, setRemoteDeletePreview] = useState<RemoteDeletePreview | null>(null);
  const request = useRef(0);
  const handledTerminalOperations = useRef(new Set<string>());
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;
  const groups = useMemo(() => groupBranches(refs, query), [query, refs]);
  const localBranchNames = useMemo(
    () =>
      new Set(
        (refs?.branches ?? [])
          .filter((branch) => branch.kind === "local")
          .map((branch) => branch.name),
      ),
    [refs],
  );

  const gitOperation = useMemo(
    () => latestRepositoryOperation(gitOperations, project.path, BRANCH_OPERATION_KINDS),
    [gitOperations, project.path],
  );
  const operationRunning = gitOperation !== null && isActiveGitOperation(gitOperation);

  const loadRefs = useCallback(async () => {
    const repositoryPath = project.path;
    const requestId = ++request.current;
    setLoading(true);
    try {
      const [nextRefs, status] = await Promise.all([
        desktopApi.repository.refs(repositoryPath),
        desktopApi.repository.status(repositoryPath),
      ]);
      if (activeRepositoryPath.current !== repositoryPath || request.current !== requestId) return;
      setRefs(nextRefs);
      onStatusChange(status);
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath && request.current === requestId) {
        onError(errorMessage(cause));
      }
    } finally {
      if (activeRepositoryPath.current === repositoryPath && request.current === requestId) {
        setLoading(false);
      }
    }
  }, [onError, onStatusChange, project.path]);

  useEffect(() => {
    setRefs(null);
    setQuery("");
    setBranchName("");
    setBusyAction(null);
    setNotice(null);
    setDeleteConfirmation(null);
    setMergeConfirmation(null);
    setRemoteForm(null);
    setRemoteDeletePreview(null);
    void loadRefs();
    return () => {
      ++request.current;
    };
  }, [loadRefs]);

  useEffect(() => {
    if (!gitOperation || !isTerminalGitOperation(gitOperation)) return;
    if (handledTerminalOperations.current.has(gitOperation.operationId)) return;
    handledTerminalOperations.current.add(gitOperation.operationId);

    setBusyAction((current) =>
      current === "pull" || current === "push" || current?.startsWith("fetch:") ? null : current,
    );
    if (gitOperation.state === "succeeded") {
      setNotice(gitOperation.message);
    } else if (gitOperation.state === "failed" || gitOperation.state === "timed_out") {
      onError(gitOperation.message);
    } else if (gitOperation.state === "cancelled") {
      setNotice(gitOperation.message);
    }
    void loadRefs();
  }, [gitOperation, loadRefs, onError]);

  async function switchBranch(branch: BranchInfo) {
    if (busyAction || loading || branch.current) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`switch:${branch.fullName}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.switchBranch(repositoryPath, branch.fullName);
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setNotice(`已切换到 ${branch.name}`);
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function trackBranch(branch: BranchInfo) {
    if (busyAction || loading || branch.kind !== "remote") return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`track:${branch.fullName}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.createTrackingBranch(
        repositoryPath,
        branch.fullName,
      );
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      const localName = branch.name.slice(branch.name.indexOf("/") + 1);
      setNotice(`已创建并切换到 ${localName}，上游为 ${branch.name}`);
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function createBranch(event: FormEvent) {
    event.preventDefault();
    const name = branchName.trim();
    if (busyAction || loading || !name) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction("create");
    setNotice(null);
    try {
      const result = await desktopApi.repository.createBranch(repositoryPath, name);
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setBranchName("");
      setNotice(`已创建并切换到 ${name}`);
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function confirmDeleteBranch() {
    if (busyAction || loading || !deleteConfirmation) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    const { branch, allowUnmerged } = deleteConfirmation;
    setBusyAction(`delete:${branch.fullName}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.deleteBranch(
        repositoryPath,
        branch.fullName,
        allowUnmerged,
      );
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setDeleteConfirmation(null);
      setNotice(`已删除本地分支 ${branch.name}`);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      if (!allowUnmerged && errorCode(cause) === "local_branch_not_merged") {
        setDeleteConfirmation({ branch, allowUnmerged: true });
      } else {
        setDeleteConfirmation(null);
        onError(errorMessage(cause));
      }
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function previewLocalMerge(branch: BranchInfo) {
    if (busyAction || loading || branch.current || branch.kind !== "local") return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`merge-preview:${branch.fullName}`);
    setNotice(null);
    try {
      const preview = await desktopApi.repository.previewLocalMerge(
        repositoryPath,
        branch.fullName,
      );
      if (!isCurrentRequest()) return;
      if (preview.mode === "up_to_date") {
        setNotice(`${preview.currentBranch} 已包含 ${preview.targetBranch} 的全部提交`);
        return;
      }
      setMergeConfirmation({
        preview,
        strategy: preview.mode === "fast_forward" ? "fast_forward_only" : "create_merge_commit",
      });
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function confirmLocalMerge() {
    if (busyAction || loading || !mergeConfirmation) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    const { preview, strategy } = mergeConfirmation;
    setBusyAction(`merge:${preview.targetFullName}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.mergeLocalBranch(
        repositoryPath,
        preview.targetFullName,
        strategy,
      );
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setMergeConfirmation(null);
      setNotice(`已将 ${preview.targetBranch} 合并到 ${preview.currentBranch}`);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setMergeConfirmation(null);
      onError(errorMessage(cause));
      setBusyAction(null);
      await loadRefs();
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function fetchRemote(remoteName: string) {
    if (busyAction || loading) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`fetch:${remoteName}`);
    setNotice(null);
    try {
      const started = await desktopApi.repository.fetch(repositoryPath, remoteName);
      if (!isCurrentRequest()) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "fetch",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待获取远端 ${remoteName}`,
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setBusyAction(null);
      onError(errorMessage(cause));
    }
  }

  async function pullCurrentBranch() {
    if (busyAction || loading) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction("pull");
    setNotice(null);
    try {
      const started = await desktopApi.repository.pull(repositoryPath);
      if (!isCurrentRequest()) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "pull",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待安全 Pull",
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setBusyAction(null);
      onError(errorMessage(cause));
    }
  }

  async function pushCurrentBranch() {
    if (busyAction || loading) return;
    const current = refs?.branches.find((branch) => branch.current && branch.kind === "local");
    if (!current || !current.upstream || current.upstreamMissing || current.ahead <= 0) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction("push");
    setNotice(null);
    try {
      const started = await desktopApi.repository.push(repositoryPath);
      if (!isCurrentRequest()) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "push",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待 Push",
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setBusyAction(null);
      onError(errorMessage(cause));
    }
  }

  async function openRemoteEdit(name: string) {
    if (busyAction || loading) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`remote-edit-preview:${name}`);
    setNotice(null);
    try {
      const preview = await desktopApi.repository.previewRemoteEdit(repositoryPath, name);
      if (!isCurrentRequest()) return;
      setRemoteForm({
        mode: "edit",
        preview,
        fetchUrl: "",
        pushUrl: "",
        resetPushUrl: false,
      });
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function submitRemoteForm(event: FormEvent) {
    event.preventDefault();
    if (!remoteForm || busyAction || loading) return;
    const submittable =
      remoteForm.mode === "create"
        ? canSubmitRemoteCreate(remoteForm.name, remoteForm.fetchUrl)
        : canSubmitRemoteUpdate(remoteForm.fetchUrl, remoteForm.pushUrl, remoteForm.resetPushUrl);
    if (!submittable) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    const action =
      remoteForm.mode === "create"
        ? "remote-create"
        : `remote-update:${remoteForm.preview.remote.name}`;
    setBusyAction(action);
    setNotice(null);
    try {
      const result =
        remoteForm.mode === "create"
          ? await desktopApi.repository.createRemote(repositoryPath, {
              name: remoteForm.name.trim(),
              fetchUrl: remoteForm.fetchUrl.trim(),
              pushUrl: remoteForm.pushUrl.trim() || null,
            })
          : await desktopApi.repository.updateRemote(repositoryPath, {
              name: remoteForm.preview.remote.name,
              expectedToken: remoteForm.preview.token,
              newFetchUrl: remoteForm.fetchUrl.trim() || null,
              newPushUrl: remoteForm.resetPushUrl ? null : remoteForm.pushUrl.trim() || null,
              resetPushUrl: remoteForm.resetPushUrl,
            });
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setNotice(
        remoteForm.mode === "create"
          ? `已创建远端 ${remoteForm.name.trim()}`
          : `已更新远端 ${remoteForm.preview.remote.name}`,
      );
      setRemoteForm(null);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      if (errorCode(cause) === "remote_snapshot_changed") {
        setRemoteForm(null);
        setBusyAction(null);
        onError(errorMessage(cause));
        void loadRefs();
        return;
      }
      onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function previewRemoteDelete(name: string) {
    if (busyAction || loading) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    setBusyAction(`remote-delete-preview:${name}`);
    setNotice(null);
    try {
      const preview = await desktopApi.repository.previewRemoteDelete(repositoryPath, name);
      if (isCurrentRequest()) setRemoteDeletePreview(preview);
    } catch (cause) {
      if (isCurrentRequest()) onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function confirmRemoteDelete() {
    if (remoteDeletePreview === null || busyAction || loading) return;
    const repositoryPath = project.path;
    const requestId = ++request.current;
    const isCurrentRequest = () =>
      isCurrentRepositoryRequest(
        activeRepositoryPath.current,
        repositoryPath,
        request.current,
        requestId,
      );
    const { remote, token } = remoteDeletePreview;
    setBusyAction(`remote-delete:${remote.name}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.deleteRemote(repositoryPath, {
        name: remote.name,
        expectedToken: token,
      });
      if (!isCurrentRequest()) return;
      setRefs(result.refs);
      onStatusChange(result.status);
      setRemoteDeletePreview(null);
      setNotice(`已删除远端 ${remote.name}`);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setRemoteDeletePreview(null);
      if (errorCode(cause) === "remote_snapshot_changed") {
        setBusyAction(null);
        onError(errorMessage(cause));
        await loadRefs();
        return;
      }
      onError(errorMessage(cause));
    } finally {
      if (isCurrentRequest()) setBusyAction(null);
    }
  }

  async function cancelOperation() {
    if (!gitOperation) return;
    const repositoryPath = project.path;
    const operationId = gitOperation.operationId;
    try {
      const accepted = await desktopApi.gitOperations.cancel(operationId);
      if (activeRepositoryPath.current !== repositoryPath) return;
      if (!accepted) setNotice("该 Git 操作已经结束。");
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) onError(errorMessage(cause));
    }
  }

  const busy = busyAction !== null || operationRunning;
  const hasLocalBranch = Boolean(refs?.branches.some((branch) => branch.kind === "local"));
  const remoteFormSubmittable = remoteForm
    ? remoteForm.mode === "create"
      ? canSubmitRemoteCreate(remoteForm.name, remoteForm.fetchUrl)
      : canSubmitRemoteUpdate(remoteForm.fetchUrl, remoteForm.pushUrl, remoteForm.resetPushUrl)
    : false;

  return (
    <div className="refs-layout">
      <section className="branches-panel" aria-label="分支">
        <header className="refs-panel-header">
          <div>
            <p className="eyebrow">BRANCHES</p>
            <h3>分支</h3>
          </div>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={loading || busy}
            onClick={() => void loadRefs()}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </header>

        <form className="branch-create-form" onSubmit={createBranch}>
          <label htmlFor="new-branch-name">从当前提交创建分支</label>
          <div>
            <input
              id="new-branch-name"
              value={branchName}
              maxLength={255}
              placeholder="feature/my-branch"
              disabled={busy || !hasLocalBranch}
              onChange={(event) => setBranchName(event.target.value)}
            />
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !hasLocalBranch || !branchName.trim()}
            >
              {busyAction === "create" ? "创建中…" : "创建并切换"}
            </button>
          </div>
          {!hasLocalBranch && !loading ? <small>首次提交后才能从当前提交创建新分支。</small> : null}
          <small>未提交更改会保留；若切换可能覆盖文件，Git 会拒绝操作。</small>
          {notice ? <p className="operation-notice">{notice}</p> : null}
        </form>

        <div className="branch-filter">
          <label htmlFor="branch-search">筛选分支</label>
          <div className="search-field-control">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              id="branch-search"
              type="search"
              value={query}
              placeholder="输入分支名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        <section className="branch-group">
          <header>
            本地分支 <span>{groups.local.length}</span>
          </header>
          {groups.local.map((branch) => (
            <BranchRow
              key={branch.fullName}
              branch={branch}
              busy={busy || loading}
              onSwitch={(target) => void switchBranch(target)}
              onPull={branch.current ? () => void pullCurrentBranch() : undefined}
              pullLabel={busyAction === "pull" ? "Pull 中…" : "Pull"}
              onPush={branch.current ? () => void pushCurrentBranch() : undefined}
              pushLabel={busyAction === "push" ? "Push 中…" : "Push"}
              onDelete={
                branch.current
                  ? undefined
                  : () => setDeleteConfirmation({ branch, allowUnmerged: false })
              }
              onMerge={branch.current ? undefined : () => void previewLocalMerge(branch)}
              mergeLabel={
                busyAction === `merge-preview:${branch.fullName}`
                  ? "预览中…"
                  : busyAction === `merge:${branch.fullName}`
                    ? "合并中…"
                    : undefined
              }
              deleteLabel={busyAction === `delete:${branch.fullName}` ? "删除中…" : undefined}
            />
          ))}
          {!loading && groups.local.length === 0 ? <p>没有匹配的本地分支。</p> : null}
        </section>

        <section className="branch-group">
          <header>
            远端分支 <span>{groups.remote.length}</span>
          </header>
          {groups.remote.map((branch) => {
            const localName = branch.name.slice(branch.name.indexOf("/") + 1);
            const localExists = localBranchNames.has(localName);
            return (
              <BranchRow
                key={branch.fullName}
                branch={branch}
                busy={busy || loading}
                onTrack={() => void trackBranch(branch)}
                trackDisabled={localExists}
                trackLabel={busyAction === `track:${branch.fullName}` ? "创建中…" : undefined}
              />
            );
          })}
          {!loading && groups.remote.length === 0 ? <p>没有匹配的远端分支。</p> : null}
        </section>
      </section>

      <aside className="remotes-panel" aria-label="远端仓库">
        <header className="refs-panel-header">
          <div>
            <p className="eyebrow">REMOTES</p>
            <h3>远端</h3>
          </div>
          <button
            className="primary-button compact-button"
            type="button"
            disabled={loading || busy}
            onClick={() => setRemoteForm({ mode: "create", name: "", fetchUrl: "", pushUrl: "" })}
          >
            添加
          </button>
        </header>
        <p className="remote-safety-note">
          地址已由 Rust 去除 URL 凭据、查询参数和片段后再返回界面；编辑时留空表示保持原值。
        </p>
        {operationRunning && gitOperation ? (
          <section className="git-operation-card" aria-live="polite">
            <div>
              <strong>{gitOperation.message}</strong>
              <small>
                {gitOperation.percent === null
                  ? "Git 长任务运行中"
                  : `进度 ${gitOperation.percent}%`}
              </small>
            </div>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => void cancelOperation()}
            >
              取消
            </button>
            <progress max={100} value={gitOperation.percent ?? undefined} />
          </section>
        ) : null}
        <div className="remote-list">
          {refs?.remotes.map((remote) => (
            <article className="remote-card" key={remote.name}>
              <header>
                <strong>{remote.name}</strong>
                <div className="remote-card-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void fetchRemote(remote.name)}
                  >
                    {busyAction === `fetch:${remote.name}` ? "获取中…" : "Fetch"}
                  </button>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void openRemoteEdit(remote.name)}
                  >
                    {busyAction === `remote-edit-preview:${remote.name}` ? "读取中…" : "编辑"}
                  </button>
                  <button
                    className="danger-button compact-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void previewRemoteDelete(remote.name)}
                  >
                    {busyAction === `remote-delete-preview:${remote.name}` ? "检查中…" : "删除"}
                  </button>
                </div>
              </header>
              <dl>
                <div>
                  <dt>Fetch</dt>
                  <dd>
                    <code>{remote.fetchUrl}</code>
                  </dd>
                </div>
                <div>
                  <dt>Push</dt>
                  <dd>
                    <code>{remote.pushUrl}</code>
                    <small>{remote.pushUrlOverridden ? "独立 Push 地址" : "跟随 Fetch 地址"}</small>
                  </dd>
                </div>
              </dl>
            </article>
          ))}
          {!loading && refs?.remotes.length === 0 ? (
            <p className="panel-message">该仓库尚未配置远端。</p>
          ) : null}
        </div>
        <p className="remote-roadmap-note">
          远端增删改由 Rust 校验并进入仓库写队列；Fetch、仅快进 Pull 和当前分支 Push
          均可取消且带硬超时。不支持 Gitee、force push、远端分支创建或自动 merge/rebase。
        </p>
      </aside>
      {remoteForm ? (
        <Dialog
          open
          className="confirmation-dialog remote-dialog"
          ariaLabelledBy="remote-form-title"
          busy={busy}
          onClose={() => setRemoteForm(null)}
        >
          <p className="eyebrow">{remoteForm.mode === "create" ? "ADD REMOTE" : "EDIT REMOTE"}</p>
          <h2 id="remote-form-title">
            {remoteForm.mode === "create"
              ? "添加远端"
              : `编辑远端 ${remoteForm.preview.remote.name}`}
          </h2>
          <p>
            HTTPS 地址不能包含用户名、密码或令牌；不支持 Gitee。Rust
            只把脱敏后的地址返回界面，因此编辑时不会预填当前真实 URL，留空表示保持原值。
          </p>
          {remoteForm.mode === "edit" ? (
            <dl className="remote-current-values">
              <div>
                <dt>当前 Fetch（已脱敏）</dt>
                <dd>
                  <code>{remoteForm.preview.remote.fetchUrl}</code>
                </dd>
              </div>
              <div>
                <dt>当前 Push（已脱敏）</dt>
                <dd>
                  <code>{remoteForm.preview.remote.pushUrl}</code>
                  <small>
                    {remoteForm.preview.remote.pushUrlOverridden
                      ? "当前使用独立 Push 地址"
                      : "当前跟随 Fetch 地址"}
                  </small>
                </dd>
              </div>
            </dl>
          ) : null}
          <form className="remote-form" onSubmit={submitRemoteForm}>
            <label className="remote-field">
              <span>Remote 名称</span>
              <input
                autoFocus={remoteForm.mode === "create"}
                value={
                  remoteForm.mode === "create" ? remoteForm.name : remoteForm.preview.remote.name
                }
                maxLength={255}
                placeholder="origin"
                disabled={busy || remoteForm.mode === "edit"}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setRemoteForm((current) =>
                    current?.mode === "create" ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </label>
            <label className="remote-field">
              <span>
                {remoteForm.mode === "create" ? "Fetch URL" : "新的 Fetch URL（留空保持）"}
              </span>
              <input
                autoFocus={remoteForm.mode === "edit"}
                value={remoteForm.fetchUrl}
                maxLength={4096}
                placeholder="https://github.com/owner/repository.git"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setRemoteForm((current) =>
                    current ? { ...current, fetchUrl: event.target.value } : current,
                  )
                }
              />
            </label>
            <label className="remote-field">
              <span>
                {remoteForm.mode === "create"
                  ? "独立 Push URL（可选）"
                  : "新的独立 Push URL（留空保持）"}
              </span>
              <input
                value={remoteForm.pushUrl}
                maxLength={4096}
                placeholder="默认跟随 Fetch URL"
                disabled={busy || (remoteForm.mode === "edit" && remoteForm.resetPushUrl)}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setRemoteForm((current) =>
                    current ? { ...current, pushUrl: event.target.value } : current,
                  )
                }
              />
            </label>
            {remoteForm.mode === "edit" && remoteForm.preview.remote.pushUrlOverridden ? (
              <label className="remote-reset-option">
                <input
                  type="checkbox"
                  checked={remoteForm.resetPushUrl}
                  disabled={busy}
                  onChange={(event) =>
                    setRemoteForm((current) =>
                      current?.mode === "edit"
                        ? { ...current, resetPushUrl: event.target.checked, pushUrl: "" }
                        : current,
                    )
                  }
                />
                <span>
                  <strong>改为跟随 Fetch 地址</strong>
                  <small>移除独立 Push URL；若同时填写新的 Fetch URL，Push 将跟随新地址。</small>
                </span>
              </label>
            ) : null}
            <div className="confirmation-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setRemoteForm(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={busy || !remoteFormSubmittable}
              >
                {busy
                  ? remoteForm.mode === "create"
                    ? "添加中…"
                    : "保存中…"
                  : remoteForm.mode === "create"
                    ? "添加远端"
                    : "保存更改"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {remoteDeletePreview ? (
        <Dialog
          open
          className="confirmation-dialog remote-dialog"
          ariaLabelledBy="delete-remote-title"
          busy={busy}
          onClose={() => setRemoteDeletePreview(null)}
        >
          <p className="eyebrow danger">DELETE REMOTE</p>
          <h2 id="delete-remote-title">删除远端 {remoteDeletePreview.remote.name}？</h2>
          <p>
            此操作会删除该 Remote 的配置和远端跟踪引用，不会删除远端服务器上的仓库或分支。Rust
            会在执行前校验预览快照，配置已变化时将拒绝删除。
          </p>
          <dl className="remote-current-values">
            <div>
              <dt>Fetch（已脱敏）</dt>
              <dd>
                <code>{remoteDeletePreview.remote.fetchUrl}</code>
              </dd>
            </div>
            <div>
              <dt>Push（已脱敏）</dt>
              <dd>
                <code>{remoteDeletePreview.remote.pushUrl}</code>
              </dd>
            </div>
          </dl>
          <section className="remote-affected-branches" aria-label="受影响的本地分支">
            <strong>本地分支上游影响</strong>
            {remoteDeletePreview.affectedBranches.length > 0 ? (
              <>
                <p>删除后将清除以下本地分支的 upstream 配置：</p>
                <ul>
                  {remoteDeletePreview.affectedBranches.map((branch) => (
                    <li key={branch}>{branch}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>没有本地分支使用该 Remote 作为 upstream。</p>
            )}
          </section>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setRemoteDeletePreview(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmRemoteDelete()}
            >
              {busy ? "删除中…" : "删除远端"}
            </button>
          </div>
        </Dialog>
      ) : null}
      {deleteConfirmation ? (
        <Dialog
          open
          className="confirmation-dialog"
          ariaLabelledBy="delete-branch-title"
          busy={busy}
          onClose={() => setDeleteConfirmation(null)}
        >
          <p className="eyebrow danger">
            {deleteConfirmation.allowUnmerged ? "UNMERGED BRANCH" : "DELETE LOCAL BRANCH"}
          </p>
          <h2 id="delete-branch-title">
            {deleteConfirmation.allowUnmerged ? "确认删除尚未合并的分支？" : "删除本地分支？"}
          </h2>
          <p>
            {deleteConfirmation.allowUnmerged
              ? "该分支包含尚未合并到当前分支的提交。删除后将无法再通过这个本地分支引用恢复，请确认这些提交不再需要。"
              : "此操作只删除本地分支，不会删除远端分支。应用会先尝试 Git 的安全删除；若分支尚未合并，会要求你再次确认。"}
          </p>
          <code>{deleteConfirmation.branch.fullName}</code>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setDeleteConfirmation(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmDeleteBranch()}
            >
              {busy ? "删除中…" : deleteConfirmation.allowUnmerged ? "仍然删除" : "删除本地分支"}
            </button>
          </div>
        </Dialog>
      ) : null}
      {mergeConfirmation ? (
        <Dialog
          open
          className="confirmation-dialog merge-dialog"
          ariaLabelledBy="merge-branch-title"
          busy={busy}
          onClose={() => setMergeConfirmation(null)}
        >
          <p className="eyebrow">LOCAL MERGE</p>
          <h2 id="merge-branch-title">合并到当前分支？</h2>
          <p>
            执行时 Rust
            会在仓库写锁内重新读取分支和提交关系。工作区必须保持干净；若产生冲突，应用会尝试自动执行{" "}
            <code className="inline-code">git merge --abort</code>。
          </p>
          <dl className="merge-preview-grid">
            <div>
              <dt>当前分支</dt>
              <dd>{mergeConfirmation.preview.currentBranch}</dd>
            </div>
            <div>
              <dt>来源分支</dt>
              <dd>{mergeConfirmation.preview.targetBranch}</dd>
            </div>
            <div>
              <dt>当前独有</dt>
              <dd>{mergeConfirmation.preview.ahead} 个提交</dd>
            </div>
            <div>
              <dt>来源独有</dt>
              <dd>{mergeConfirmation.preview.behind} 个提交</dd>
            </div>
          </dl>
          {mergeConfirmation.preview.mode === "fast_forward" ? (
            <fieldset className="merge-strategy-options">
              <legend>合并方式</legend>
              <label>
                <input
                  type="radio"
                  name="local-merge-strategy"
                  value="fast_forward_only"
                  checked={mergeConfirmation.strategy === "fast_forward_only"}
                  disabled={busy}
                  onChange={() =>
                    setMergeConfirmation((current) =>
                      current ? { ...current, strategy: "fast_forward_only" } : current,
                    )
                  }
                />
                <span>
                  <strong>仅快进</strong>
                  <small>不创建额外提交，当前分支直接前移到来源提交。</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="local-merge-strategy"
                  value="create_merge_commit"
                  checked={mergeConfirmation.strategy === "create_merge_commit"}
                  disabled={busy}
                  onChange={() =>
                    setMergeConfirmation((current) =>
                      current ? { ...current, strategy: "create_merge_commit" } : current,
                    )
                  }
                />
                <span>
                  <strong>创建合并提交</strong>
                  <small>即使可以快进，也保留一条明确的分支合并记录。</small>
                </span>
              </label>
            </fieldset>
          ) : (
            <p className="merge-strategy-note">两个分支已经分叉，本次必须创建合并提交。</p>
          )}
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setMergeConfirmation(null)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmLocalMerge()}
            >
              {busy ? "合并中…" : "确认合并"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
