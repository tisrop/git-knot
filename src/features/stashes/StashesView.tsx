import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "../../app/Dialog";
import {
  desktopApi,
  type Project,
  type RepositoryStashes,
  type RepositoryStatus,
  type StashInfo,
} from "../../platform/desktop";
import { formatCommitDate, shortCommitOid } from "../history/history";

const STASH_MESSAGE_MAX_LENGTH = 500;

type Confirmation = { kind: "pop"; stash: StashInfo } | { kind: "drop"; stash: StashInfo };

interface StashesViewProps {
  project: Project;
  onStatusChange: (status: RepositoryStatus) => void;
  onError: (message: string) => void;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "储藏操作失败，请稍后重试";
}

function hasConflicts(status: RepositoryStatus | null) {
  return status?.changes.some((change) => change.kind === "unmerged") ?? false;
}

export function StashesView({ project, onStatusChange, onError }: StashesViewProps) {
  const [repositoryStashes, setRepositoryStashes] = useState<RepositoryStashes | null>(null);
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const loadRequest = useRef(0);
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;

  const loadSnapshot = useCallback(
    async (repositoryPath: string) => {
      const requestId = ++loadRequest.current;
      setLoading(true);
      setLoadError(null);
      setNotice(null);
      try {
        const [nextStashes, nextStatus] = await Promise.all([
          desktopApi.repository.stashes(repositoryPath),
          desktopApi.repository.status(repositoryPath),
        ]);
        if (loadRequest.current !== requestId) return;
        setRepositoryStashes(nextStashes);
        setStatus(nextStatus);
        onStatusChange(nextStatus);
      } catch (cause) {
        if (loadRequest.current === requestId) {
          setRepositoryStashes(null);
          setStatus(null);
          setLoadError(errorMessage(cause));
        }
      } finally {
        if (loadRequest.current === requestId) setLoading(false);
      }
    },
    [onStatusChange],
  );

  const refreshAfterFailure = useCallback(
    async (repositoryPath: string) => {
      try {
        const [nextStashes, nextStatus] = await Promise.all([
          desktopApi.repository.stashes(repositoryPath),
          desktopApi.repository.status(repositoryPath),
        ]);
        if (activeRepositoryPath.current !== repositoryPath) return;
        setRepositoryStashes(nextStashes);
        setStatus(nextStatus);
        onStatusChange(nextStatus);
      } catch {
        // Preserve the original mutation error. A manual refresh remains available.
      }
    },
    [onStatusChange],
  );

  useEffect(() => {
    setMessage("");
    setIncludeUntracked(true);
    setKeepIndex(false);
    setRestoreIndex(false);
    setBusyAction(null);
    setConfirmation(null);
    void loadSnapshot(project.path);
  }, [loadSnapshot, project.path]);

  function applyResult(result: { stashes: RepositoryStashes; status: RepositoryStatus }) {
    setRepositoryStashes(result.stashes);
    setStatus(result.status);
    onStatusChange(result.status);
  }

  async function createStash(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyAction || loading || hasConflicts(status)) return;
    const repositoryPath = project.path;
    setBusyAction("create");
    setNotice(null);
    try {
      const result = await desktopApi.repository.createStash(repositoryPath, {
        message: message.trim() || null,
        includeUntracked,
        keepIndex,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      applyResult(result);
      setMessage("");
      setNotice("已创建本地储藏；远端仓库不会收到任何更改");
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  async function applyStash(stash: StashInfo) {
    if (busyAction || loading || hasConflicts(status)) return;
    const repositoryPath = project.path;
    setBusyAction(`apply:${stash.oid}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.applyStash(
        repositoryPath,
        stash.oid,
        restoreIndex,
      );
      if (activeRepositoryPath.current !== repositoryPath) return;
      applyResult(result);
      setNotice(`已应用 ${stash.selector}；储藏条目仍然保留`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  async function confirmMutation() {
    if (!confirmation || busyAction || loading) return;
    const repositoryPath = project.path;
    const { kind, stash } = confirmation;
    setBusyAction(`${kind}:${stash.oid}`);
    setNotice(null);
    try {
      const result =
        kind === "pop"
          ? await desktopApi.repository.popStash(repositoryPath, stash.oid, restoreIndex)
          : await desktopApi.repository.dropStash(repositoryPath, stash.oid);
      if (activeRepositoryPath.current !== repositoryPath) return;
      applyResult(result);
      setConfirmation(null);
      setNotice(
        kind === "pop"
          ? `已弹出 ${stash.selector} 并删除对应储藏条目`
          : `已删除 ${stash.selector}；工作区内容未改变`,
      );
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      setConfirmation(null);
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  const busy = busyAction !== null;
  const conflicts = hasConflicts(status);
  const trackedChanges =
    status?.changes.filter((change) => change.kind !== "untracked").length ?? 0;
  const untrackedChanges =
    status?.changes.filter((change) => change.kind === "untracked").length ?? 0;
  const stashableChanges = trackedChanges + (includeUntracked ? untrackedChanges : 0);

  return (
    <div className="stashes-layout">
      <section className="stash-create-panel" aria-label="创建本地储藏">
        <header className="refs-panel-header">
          <div>
            <p className="eyebrow">CREATE STASH</p>
            <h3>保存当前工作</h3>
          </div>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={loading || busy}
            onClick={() => void loadSnapshot(project.path)}
          >
            {loading ? "读取中…" : "刷新"}
          </button>
        </header>

        <form className="stash-create-form" onSubmit={createStash}>
          <label>
            储藏说明（可选）
            <input
              type="text"
              value={message}
              maxLength={STASH_MESSAGE_MAX_LENGTH}
              disabled={busy}
              placeholder="例如：切换任务前保存表单重构"
              onChange={(event) => setMessage(event.target.value)}
            />
            <small>
              {[...message].length} / {STASH_MESSAGE_MAX_LENGTH} 字符
            </small>
          </label>

          <label className="stash-option-toggle">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={busy}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            <span>
              <strong>包含未跟踪文件</strong>
              <small>等同于 Git 的 --include-untracked；不会包含 ignored 文件。</small>
            </span>
          </label>

          <label className="stash-option-toggle">
            <input
              type="checkbox"
              checked={keepIndex}
              disabled={busy}
              onChange={(event) => setKeepIndex(event.target.checked)}
            />
            <span>
              <strong>保留暂存区</strong>
              <small>创建储藏后继续保留当前已暂存内容。</small>
            </span>
          </label>

          <div className="stash-change-summary" aria-live="polite">
            <span>
              已跟踪更改 <strong>{trackedChanges}</strong>
            </span>
            <span>
              未跟踪文件 <strong>{untrackedChanges}</strong>
            </span>
          </div>

          {conflicts ? (
            <p className="stash-warning" role="alert">
              仓库存在未解决冲突。请先在工作区解决冲突，再创建或恢复储藏。
            </p>
          ) : (
            <p className="stash-form-note">
              储藏只保存在本地 reflog；不会上传到 GitHub，也不会修改远端分支。
            </p>
          )}

          <button
            className="primary-button"
            type="submit"
            disabled={busy || loading || conflicts || stashableChanges === 0}
          >
            {busyAction === "create" ? "正在创建…" : "创建储藏"}
          </button>
        </form>
      </section>

      <section className="stash-list-panel" aria-label="本地储藏列表">
        <header className="refs-panel-header">
          <div>
            <p className="eyebrow">LOCAL STASHES</p>
            <h3>本地储藏</h3>
          </div>
          <span className="count-badge">{repositoryStashes?.stashes.length ?? 0}</span>
        </header>

        <label className="stash-restore-option">
          <input
            type="checkbox"
            checked={restoreIndex}
            disabled={busy}
            onChange={(event) => setRestoreIndex(event.target.checked)}
          />
          <span>
            <strong>恢复暂存区状态</strong>
            <small>应用或弹出时使用 --index；恢复失败时储藏会保留。</small>
          </span>
        </label>

        <p className="stash-safety-note">
          操作时只提交先前读取到的精确 stash OID。Rust 会在仓库写队列内重新解析当前 selector，拒绝
          HEAD、stash@&#123;n&#125; 或任意 revision。
        </p>

        {notice ? (
          <p className="inline-success" role="status">
            {notice}
          </p>
        ) : null}
        {loadError ? (
          <div className="panel-message error" role="alert">
            <p>{loadError}</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void loadSnapshot(project.path)}
            >
              重试
            </button>
          </div>
        ) : loading && !repositoryStashes ? (
          <div className="panel-message">正在读取本地储藏…</div>
        ) : repositoryStashes?.stashes.length ? (
          <div className="stash-list">
            {repositoryStashes.stashes.map((stash) => (
              <article className="stash-row" key={`${stash.oid}:${stash.selector}`}>
                <div className="stash-row-copy">
                  <div>
                    <strong>{stash.selector}</strong>
                    <code>{shortCommitOid(stash.oid)}</code>
                  </div>
                  <p>{stash.subject || "无说明储藏"}</p>
                  <time dateTime={stash.createdAt}>{formatCommitDate(stash.createdAt)}</time>
                </div>
                <div className="stash-row-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busy || loading || conflicts}
                    onClick={() => void applyStash(stash)}
                  >
                    {busyAction === `apply:${stash.oid}` ? "应用中…" : "应用"}
                  </button>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busy || loading || conflicts}
                    onClick={() => setConfirmation({ kind: "pop", stash })}
                  >
                    弹出
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busy || loading}
                    onClick={() => setConfirmation({ kind: "drop", stash })}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="panel-message">当前仓库没有本地储藏。</div>
        )}
      </section>

      {confirmation ? (
        <Dialog
          open
          className="confirmation-dialog"
          ariaLabelledBy="stash-confirm-title"
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          <p className="eyebrow danger">CONFIRM LOCAL ACTION</p>
          <h2 id="stash-confirm-title">
            {confirmation.kind === "pop" ? "弹出并删除这个储藏？" : "永久删除这个储藏？"}
          </h2>
          <p>
            {confirmation.kind === "pop"
              ? "Git 会先把内容写入当前工作区；成功后删除本地储藏条目。若产生冲突，条目仍会保留。"
              : "只删除本地 reflog 中的储藏条目，不改变当前工作区。删除后无法由本应用撤销。"}
          </p>
          <code>
            {confirmation.stash.selector} · {shortCommitOid(confirmation.stash.oid)}
          </code>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void confirmMutation()}
            >
              {busy ? "处理中…" : confirmation.kind === "pop" ? "确认弹出" : "确认删除"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
