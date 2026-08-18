import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "../../app/Dialog";
import { ThemedSelect } from "../../app/ThemedSelect";
import {
  desktopApi,
  type CommitSummary,
  type GitOperationEvent,
  type Project,
  type RemoteInfo,
  type RemoteTagDeletePreview,
  type RepositoryTags,
  type TagInfo,
} from "../../platform/desktop";
import { formatCommitDate, shortCommitOid } from "../history/history";
import {
  isActiveGitOperation,
  isTerminalGitOperation,
  latestRepositoryOperation,
} from "../operations/gitOperations";

const TAG_TARGET_HISTORY_LIMIT = 200;
const TAG_MESSAGE_MAX_LENGTH = 64 * 1024;
const TAG_OPERATION_KINDS = new Set<GitOperationEvent["kind"]>([
  "tag_push",
  "tag_delete_preview",
  "tag_delete",
]);

interface TagsViewProps {
  project: Project;
  onError: (message: string) => void;
  gitOperations: GitOperationEvent[];
  onOperationStarted: (operation: GitOperationEvent) => void;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "标签操作失败，请稍后重试";
}

export function TagsView({ project, onError, gitOperations, onOperationStarted }: TagsViewProps) {
  const [repositoryTags, setRepositoryTags] = useState<RepositoryTags | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [selectedRemoteName, setSelectedRemoteName] = useState("");
  const [tagName, setTagName] = useState("");
  const [targetOid, setTargetOid] = useState("");
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<TagInfo | null>(null);
  const [remoteDeletePreview, setRemoteDeletePreview] = useState<RemoteTagDeletePreview | null>(
    null,
  );
  const loadRequest = useRef(0);
  const handledTerminalOperations = useRef(new Set<string>());
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;

  const gitOperation = latestRepositoryOperation(gitOperations, project.path, TAG_OPERATION_KINDS);
  const operationRunning = gitOperation !== null && isActiveGitOperation(gitOperation);

  const loadTagsAndTargets = useCallback(async (repositoryPath: string) => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    try {
      const [nextTags, nextCommits, nextRefs] = await Promise.all([
        desktopApi.repository.tags(repositoryPath),
        desktopApi.repository.history(repositoryPath, {
          offset: 0,
          limit: TAG_TARGET_HISTORY_LIMIT,
          refFullName: null,
          search: "",
          author: "",
          after: null,
          before: null,
          filePath: null,
        }),
        desktopApi.repository.refs(repositoryPath),
      ]);
      if (loadRequest.current !== requestId) return;
      setRepositoryTags(nextTags);
      setCommits(nextCommits.commits);
      setRemotes(nextRefs.remotes);
      setSelectedRemoteName((current) =>
        nextRefs.remotes.some((remote) => remote.name === current)
          ? current
          : (nextRefs.remotes[0]?.name ?? ""),
      );
      setTargetOid((current) =>
        nextCommits.commits.some((commit) => commit.oid === current)
          ? current
          : (nextCommits.commits[0]?.oid ?? ""),
      );
    } catch (cause) {
      if (loadRequest.current === requestId) {
        setRepositoryTags(null);
        setCommits([]);
        setRemotes([]);
        setSelectedRemoteName("");
        setTargetOid("");
        setLoadError(errorMessage(cause));
      }
    } finally {
      if (loadRequest.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setTagName("");
    setAnnotated(false);
    setMessage("");
    setNotice(null);
    setDeleteConfirmation(null);
    setRemoteDeletePreview(null);
    setBusyAction(null);
    void loadTagsAndTargets(project.path);
    return () => {
      ++loadRequest.current;
    };
  }, [loadTagsAndTargets, project.path]);

  useEffect(() => {
    if (!gitOperation || !isTerminalGitOperation(gitOperation)) return;
    if (handledTerminalOperations.current.has(gitOperation.operationId)) return;
    handledTerminalOperations.current.add(gitOperation.operationId);

    setBusyAction(null);
    if (gitOperation.state === "succeeded") {
      if (gitOperation.kind === "tag_delete_preview") {
        if (gitOperation.remoteTagDeletePreview) {
          setRemoteDeletePreview(gitOperation.remoteTagDeletePreview);
        } else {
          onError("远端标签预览缺少确认信息，请重新读取");
        }
      } else {
        if (gitOperation.kind === "tag_delete") setRemoteDeletePreview(null);
        setNotice(gitOperation.message);
      }
    } else if (gitOperation.state === "cancelled") {
      setNotice(gitOperation.message);
    } else {
      if (gitOperation.kind === "tag_delete") setRemoteDeletePreview(null);
      onError(gitOperation.message);
    }
  }, [gitOperation, onError]);

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repositoryPath = project.path;
    const name = tagName.trim();
    const annotation = message.trim();
    if (busyAction || !name || !targetOid || (annotated && !annotation)) return;

    setBusyAction("create");
    setNotice(null);
    try {
      const result = await desktopApi.repository.createTag(
        repositoryPath,
        name,
        targetOid,
        annotated ? annotation : null,
      );
      if (activeRepositoryPath.current !== repositoryPath) return;
      setRepositoryTags(result.tags);
      setTagName("");
      setMessage("");
      setNotice(`已创建本地${annotated ? "附注" : "轻量"}标签 ${name}`);
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  async function deleteTag() {
    if (busyAction || loading || !deleteConfirmation) return;
    const repositoryPath = project.path;
    const tag = deleteConfirmation;
    setBusyAction(`delete:${tag.fullName}`);
    setNotice(null);
    try {
      const result = await desktopApi.repository.deleteTag(repositoryPath, tag.fullName);
      if (activeRepositoryPath.current !== repositoryPath) return;
      setRepositoryTags(result.tags);
      setDeleteConfirmation(null);
      setNotice(`已删除本地标签 ${tag.name}`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      setDeleteConfirmation(null);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyAction(null);
    }
  }

  async function publishTag(tag: TagInfo) {
    if (busyAction || loading || !selectedRemoteName) return;
    const repositoryPath = project.path;
    setBusyAction(`tag-push:${tag.fullName}`);
    setNotice(null);
    try {
      const started = await desktopApi.repository.pushTag(repositoryPath, {
        remoteName: selectedRemoteName,
        fullName: tag.fullName,
        expectedLocalOid: tag.oid,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "tag_push",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待发布标签 ${tag.name}`,
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) {
        setBusyAction(null);
        onError(errorMessage(cause));
      }
    }
  }

  async function previewRemoteTagDelete(tag: TagInfo) {
    if (busyAction || loading || !selectedRemoteName) return;
    const repositoryPath = project.path;
    setBusyAction(`tag-delete-preview:${tag.fullName}`);
    setNotice(null);
    setRemoteDeletePreview(null);
    try {
      const started = await desktopApi.repository.previewRemoteTagDelete(repositoryPath, {
        remoteName: selectedRemoteName,
        fullName: tag.fullName,
        expectedLocalOid: tag.oid,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "tag_delete_preview",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待读取远端标签 ${tag.name}`,
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) {
        setBusyAction(null);
        onError(errorMessage(cause));
      }
    }
  }

  async function confirmRemoteTagDelete() {
    if (busyAction || !remoteDeletePreview) return;
    const repositoryPath = project.path;
    const preview = remoteDeletePreview;
    setBusyAction(`tag-delete:${preview.fullName}`);
    setNotice(null);
    try {
      const started = await desktopApi.repository.deleteRemoteTag(repositoryPath, {
        remoteName: preview.remoteName,
        fullName: preview.fullName,
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.remoteOid,
        expectedToken: preview.token,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath,
        kind: "tag_delete",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待删除远端标签 ${preview.name}`,
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      if (activeRepositoryPath.current === repositoryPath) {
        setBusyAction(null);
        setRemoteDeletePreview(null);
        onError(errorMessage(cause));
      }
    }
  }

  async function cancelOperation() {
    if (!gitOperation || isTerminalGitOperation(gitOperation)) return;
    try {
      await desktopApi.gitOperations.cancel(gitOperation.operationId);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }

  const busy = busyAction !== null || operationRunning;
  const createDisabled =
    busy || loading || !tagName.trim() || !targetOid || (annotated && !message.trim());

  return (
    <div className="tags-layout">
      <section className="tag-create-panel" aria-label="创建本地标签">
        <header className="refs-panel-header">
          <div>
            <p className="eyebrow">CREATE TAG</p>
            <h3>创建本地标签</h3>
          </div>
        </header>

        <form className="tag-create-form" onSubmit={(event) => void createTag(event)}>
          <label>
            标签名
            <input
              type="text"
              value={tagName}
              maxLength={255}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 v1.0.0"
              onChange={(event) => setTagName(event.target.value)}
            />
          </label>

          <label>
            目标提交
            <ThemedSelect
              ariaLabel="目标提交"
              value={targetOid}
              disabled={busy || loading || commits.length === 0}
              onChange={setTargetOid}
              options={commits.map((commit) => ({
                label: `${shortCommitOid(commit.oid)} · ${commit.subject || "无标题提交"}`,
                value: commit.oid,
              }))}
            />
          </label>

          <label className="tag-annotation-toggle">
            <input
              type="checkbox"
              checked={annotated}
              disabled={busy}
              onChange={(event) => setAnnotated(event.target.checked)}
            />
            <span>
              <strong>创建附注标签</strong>
              <small>记录独立说明和创建时间；当前不创建签名标签。</small>
            </span>
          </label>

          {annotated ? (
            <label>
              标签说明
              <textarea
                value={message}
                maxLength={TAG_MESSAGE_MAX_LENGTH}
                disabled={busy}
                rows={6}
                placeholder="说明本次发布或里程碑"
                onChange={(event) => setMessage(event.target.value)}
              />
              <small>{message.length.toLocaleString("zh-CN")} / 65,536 字符</small>
            </label>
          ) : null}

          {commits.length === 0 && !loading ? (
            <p className="tag-form-note">仓库还没有可用于创建标签的提交。</p>
          ) : (
            <p className="tag-form-note">
              目标只能从最近读取的提交中选择；Rust 会再次确认精确提交 OID。
            </p>
          )}

          <button className="primary-button" type="submit" disabled={createDisabled}>
            {busyAction === "create" ? "创建中…" : "创建本地标签"}
          </button>
        </form>
      </section>

      <section className="tag-list-panel" aria-label="本地与远端标签操作">
        <header className="refs-panel-header tag-list-header">
          <div>
            <p className="eyebrow">TAGS</p>
            <h3>标签</h3>
          </div>
          <div className="tag-list-header-actions">
            <label>
              <span>目标远端</span>
              <ThemedSelect
                ariaLabel="目标远端"
                className="tag-remote-select"
                value={selectedRemoteName}
                disabled={loading || busy || remotes.length === 0}
                onChange={setSelectedRemoteName}
                options={
                  remotes.length === 0
                    ? [{ label: "没有远端", value: "" }]
                    : remotes.map((remote) => ({ label: remote.name, value: remote.name }))
                }
              />
            </label>
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={loading || busy}
              onClick={() => void loadTagsAndTargets(project.path)}
            >
              {loading ? "读取中…" : "刷新"}
            </button>
          </div>
        </header>

        <p className="tag-safety-note">
          发布只会创建一个同名远端标签，不会覆盖不同
          OID；删除远端标签前会读取并再次确认，且不会删除本地标签或提交。
        </p>
        {operationRunning ? (
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
        {notice ? <p className="panel-message success">{notice}</p> : null}
        {loadError ? <p className="panel-message error-message">{loadError}</p> : null}
        {!loadError && !loading && repositoryTags?.tags.length === 0 ? (
          <p className="panel-message">该仓库还没有本地标签。</p>
        ) : null}

        <div className="tag-list">
          {repositoryTags?.tags.map((tag) => (
            <article className="tag-row" key={tag.fullName}>
              <div className="tag-row-copy">
                <div>
                  <strong>{tag.name}</strong>
                  <span className={`tag-kind-badge${tag.annotated ? " annotated" : ""}`}>
                    {tag.annotated ? "附注" : "轻量"}
                  </span>
                </div>
                <small>{tag.subject || "无说明"}</small>
                {tag.taggerDate ? <time>{formatCommitDate(tag.taggerDate)}</time> : null}
              </div>
              <code title={tag.targetOid}>{shortCommitOid(tag.targetOid)}</code>
              <div className="tag-row-actions">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={busy || loading || !selectedRemoteName}
                  title="只创建该远端上的同名标签；若已存在不同 OID，会安全停止"
                  onClick={() => void publishTag(tag)}
                >
                  {busyAction === `tag-push:${tag.fullName}` ? "发布中…" : "发布"}
                </button>
                <button
                  className="danger-button compact-button"
                  type="button"
                  disabled={busy || loading || !selectedRemoteName}
                  title="先读取远端标签的精确 OID，再进入删除确认"
                  onClick={() => void previewRemoteTagDelete(tag)}
                >
                  {busyAction === `tag-delete-preview:${tag.fullName}` ? "读取中…" : "删除远端"}
                </button>
                <button
                  className="danger-button compact-button"
                  type="button"
                  disabled={busy || loading}
                  title="只删除本地标签，不会删除任何远端标签"
                  onClick={() => setDeleteConfirmation(tag)}
                >
                  {busyAction === `delete:${tag.fullName}` ? "删除中…" : "删除本地"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {deleteConfirmation ? (
        <Dialog
          open
          className="confirmation-dialog"
          ariaLabelledBy="delete-tag-title"
          busy={busy}
          onClose={() => setDeleteConfirmation(null)}
        >
          <p className="eyebrow danger">DELETE LOCAL TAG</p>
          <h2 id="delete-tag-title">删除本地标签？</h2>
          <p>
            此操作只删除本地标签引用，不会删除提交，也不会删除任何远端标签。远端若已有同名标签，将保持不变。
          </p>
          <code>{deleteConfirmation.fullName}</code>
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
              onClick={() => void deleteTag()}
            >
              {busy ? "删除中…" : "删除本地标签"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {remoteDeletePreview ? (
        <Dialog
          open
          className="confirmation-dialog remote-tag-delete-dialog"
          ariaLabelledBy="delete-remote-tag-title"
          busy={busy}
          onClose={() => setRemoteDeletePreview(null)}
        >
          <p className="eyebrow danger">DELETE REMOTE TAG</p>
          <h2 id="delete-remote-tag-title">删除远端标签？</h2>
          <p>
            只会删除指定远端上的这一条标签引用。本地标签和提交都会保留；如果远端标签在本次预览后发生变化，删除会安全停止。
          </p>
          <dl className="remote-tag-delete-details">
            <div>
              <dt>远端</dt>
              <dd>{remoteDeletePreview.remoteName}</dd>
            </div>
            <div>
              <dt>标签引用</dt>
              <dd>
                <code>{remoteDeletePreview.fullName}</code>
              </dd>
            </div>
            <div>
              <dt>远端 OID</dt>
              <dd>
                <code>{remoteDeletePreview.remoteOid}</code>
              </dd>
            </div>
          </dl>
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
              onClick={() => void confirmRemoteTagDelete()}
            >
              {busyAction === `tag-delete:${remoteDeletePreview.fullName}`
                ? "删除中…"
                : "删除远端标签"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
