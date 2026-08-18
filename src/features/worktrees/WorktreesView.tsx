import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../../app/Dialog";
import { ThemedSelect } from "../../app/ThemedSelect";
import {
  desktopApi,
  type Project,
  type RepositoryWorktrees,
  type WorktreeInfo,
} from "../../platform/desktop";
import { shortCommitOid } from "../history/history";

const LOCK_REASON_MAX_LENGTH = 256;

interface WorktreesViewProps {
  project: Project;
  onError: (message: string) => void;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "工作树操作失败，请稍后重试";
}

function worktreeTitle(worktree: WorktreeInfo) {
  if (worktree.bare) return "Bare repository";
  if (worktree.detached) return "Detached HEAD";
  return worktree.branch ?? "未命名分支";
}

function readOnlyReason(worktree: WorktreeInfo) {
  if (worktree.isMain) return "主工作树由仓库直接管理，不能在此锁定或解锁。";
  if (worktree.bare) return "当前版本不管理 bare worktree。";
  if (worktree.prunable) {
    return worktree.prunableReason
      ? `记录已失效：${worktree.prunableReason}`
      : "记录已失效，请先使用系统 Git 修复或清理。";
  }
  return null;
}

export function WorktreesView({ project, onError }: WorktreesViewProps) {
  const [snapshot, setSnapshot] = useState<RepositoryWorktrees | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [selectedBranchFullName, setSelectedBranchFullName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pruneConfirmation, setPruneConfirmation] = useState<{
    count: number;
    expectedToken: string;
  } | null>(null);
  const loadRequest = useRef(0);
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;

  const loadWorktrees = useCallback(async (repositoryPath: string) => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await desktopApi.repository.worktrees(repositoryPath);
      if (loadRequest.current !== requestId) return;
      setSnapshot(next);
    } catch (cause) {
      if (loadRequest.current !== requestId) return;
      setSnapshot(null);
      setLoadError(errorMessage(cause));
    } finally {
      if (loadRequest.current === requestId) setLoading(false);
    }
  }, []);

  const refreshAfterFailure = useCallback(async (repositoryPath: string) => {
    try {
      const next = await desktopApi.repository.worktrees(repositoryPath);
      if (activeRepositoryPath.current === repositoryPath) setSnapshot(next);
    } catch {
      // Preserve the original mutation error; the explicit refresh remains available.
    }
  }, []);

  useEffect(() => {
    setSnapshot(null);
    setReasons({});
    setSelectedBranchFullName("");
    setBusyPath(null);
    setNotice(null);
    setPruneConfirmation(null);
    void loadWorktrees(project.path);
    return () => {
      ++loadRequest.current;
    };
  }, [loadWorktrees, project.path]);

  async function createLinkedWorktree() {
    const candidate =
      snapshot?.createCandidates.find((item) => item.branchFullName === selectedBranchFullName) ??
      snapshot?.createCandidates[0];
    if (!candidate || busyPath || loading) return;

    const repositoryPath = project.path;
    setBusyPath(`create:${candidate.branchFullName}`);
    setNotice(null);
    try {
      const next = await desktopApi.repository.createLinkedWorktree(repositoryPath, {
        branchFullName: candidate.branchFullName,
        expectedToken: candidate.token,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      setSnapshot(next);
      setSelectedBranchFullName(next.createCandidates[0]?.branchFullName ?? "");
      setNotice(`已为 ${candidate.branch} 创建关联工作树`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyPath(null);
    }
  }

  async function lock(worktree: WorktreeInfo) {
    if (busyPath || worktree.locked || readOnlyReason(worktree)) return;
    const repositoryPath = project.path;
    setBusyPath(worktree.path);
    setNotice(null);
    try {
      const next = await desktopApi.repository.lockWorktree(repositoryPath, {
        worktreePath: worktree.path,
        expectedToken: worktree.token,
        reason: reasons[worktree.path]?.trim() || null,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      setSnapshot(next);
      setReasons((current) => ({ ...current, [worktree.path]: "" }));
      setNotice(`已锁定 ${worktree.branch ?? worktree.path}`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyPath(null);
    }
  }

  async function unlock(worktree: WorktreeInfo) {
    if (busyPath || !worktree.locked || readOnlyReason(worktree)) return;
    const repositoryPath = project.path;
    setBusyPath(worktree.path);
    setNotice(null);
    try {
      const next = await desktopApi.repository.unlockWorktree(repositoryPath, {
        worktreePath: worktree.path,
        expectedToken: worktree.token,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      setSnapshot(next);
      setNotice(`已解锁 ${worktree.branch ?? worktree.path}`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyPath(null);
    }
  }

  function requestPrune() {
    const current = snapshot;
    if (!current || busyPath || !current.worktrees.some((worktree) => worktree.prunable)) return;
    setPruneConfirmation({
      count: current.worktrees.filter((worktree) => worktree.prunable).length,
      expectedToken: current.pruneToken,
    });
  }

  async function confirmPrune() {
    const confirmation = pruneConfirmation;
    if (!confirmation || busyPath) return;
    const repositoryPath = project.path;
    setBusyPath("prune");
    setNotice(null);
    try {
      const next = await desktopApi.repository.pruneWorktrees(repositoryPath, {
        expectedToken: confirmation.expectedToken,
      });
      if (activeRepositoryPath.current !== repositoryPath) return;
      setSnapshot(next);
      setPruneConfirmation(null);
      setNotice(`已清理 ${confirmation.count} 条失效 worktree 记录`);
    } catch (cause) {
      if (activeRepositoryPath.current !== repositoryPath) return;
      setPruneConfirmation(null);
      await refreshAfterFailure(repositoryPath);
      onError(errorMessage(cause));
    } finally {
      if (activeRepositoryPath.current === repositoryPath) setBusyPath(null);
    }
  }

  const linkedCount = snapshot?.worktrees.filter((worktree) => !worktree.isMain).length ?? 0;
  const selectedCandidate =
    snapshot?.createCandidates.find(
      (candidate) => candidate.branchFullName === selectedBranchFullName,
    ) ??
    snapshot?.createCandidates[0] ??
    null;
  const creating = selectedCandidate
    ? busyPath === `create:${selectedCandidate.branchFullName}`
    : false;

  return (
    <section className="worktrees-view" aria-label="Git 工作树">
      <header className="worktrees-header">
        <div>
          <p className="eyebrow">LINKED WORKTREES</p>
          <h3>工作树</h3>
          <p>读取 Git 的权威清单，并只允许安全锁定、解锁或清理失效记录。</p>
        </div>
        <div className="worktrees-header-actions">
          <span className="count-badge">{linkedCount} 个关联</span>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={loading || busyPath !== null}
            onClick={() => void loadWorktrees(project.path)}
          >
            {loading ? "读取中…" : "刷新"}
          </button>
          {snapshot?.worktrees.some((worktree) => worktree.prunable) ? (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={loading || busyPath !== null}
              onClick={requestPrune}
            >
              {busyPath === "prune" ? "清理中…" : "清理失效记录"}
            </button>
          ) : null}
        </div>
      </header>

      <p className="worktrees-safety-note">
        创建时只能选择 Rust 权威读取且尚未检出的本地分支，目标目录由 Rust 在主仓库同级的
        <code>.git-knot-worktrees</code> 受控目录中推导。不会接受任意路径、远端 ref、revision 或 Git
        参数；移动和删除仍未开放。清理仅针对 Git 已标记为失效的管理记录，不会删除有效工作树文件。
      </p>

      {snapshot && !loadError ? (
        <section className="worktree-create-panel" aria-label="创建关联工作树">
          <div>
            <strong>创建关联工作树</strong>
            <p>选择一个尚未在其他工作树中检出的本地分支。</p>
          </div>
          {selectedCandidate ? (
            <>
              <label>
                <span>本地分支</span>
                <ThemedSelect
                  ariaLabel="本地分支"
                  value={selectedCandidate.branchFullName}
                  disabled={loading || busyPath !== null}
                  onChange={setSelectedBranchFullName}
                  options={snapshot.createCandidates.map((candidate) => ({
                    label: candidate.branch,
                    value: candidate.branchFullName,
                  }))}
                />
              </label>
              <div className="worktree-create-target">
                <span>Rust 推导目录</span>
                <code title={selectedCandidate.targetPath}>{selectedCandidate.targetPath}</code>
                <small>HEAD {shortCommitOid(selectedCandidate.headOid)}</small>
              </div>
              <button
                className="primary-button"
                type="button"
                disabled={loading || busyPath !== null}
                onClick={() => void createLinkedWorktree()}
              >
                {creating ? "创建中…" : "创建"}
              </button>
            </>
          ) : (
            <p className="worktree-create-empty">
              没有可创建的本地分支；已检出的分支不会出现在这里。
            </p>
          )}
        </section>
      ) : null}

      {pruneConfirmation ? (
        <Dialog
          open
          className="confirmation-dialog"
          role="alertdialog"
          ariaLabelledBy="worktree-prune-dialog-title"
          ariaDescribedBy="worktree-prune-dialog-description"
          busy={busyPath === "prune"}
          onClose={() => setPruneConfirmation(null)}
        >
          <p className="eyebrow danger">WORKTREE MAINTENANCE</p>
          <h2 id="worktree-prune-dialog-title">清理失效工作树记录？</h2>
          <p id="worktree-prune-dialog-description">
            将从 Git 管理数据中清理 {pruneConfirmation.count} 条已确认失效的 worktree
            记录。此操作不会删除有效工作树目录或其中的文件。
          </p>
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busyPath === "prune"}
              autoFocus
              onClick={() => setPruneConfirmation(null)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busyPath === "prune"}
              onClick={() => void confirmPrune()}
            >
              {busyPath === "prune" ? "清理中…" : "确认清理"}
            </button>
          </div>
        </Dialog>
      ) : null}

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
            onClick={() => void loadWorktrees(project.path)}
          >
            重试
          </button>
        </div>
      ) : loading && !snapshot ? (
        <div className="panel-message">正在读取工作树清单…</div>
      ) : snapshot?.worktrees.length ? (
        <div className="worktree-list">
          {snapshot.worktrees.map((worktree) => {
            const readOnly = readOnlyReason(worktree);
            const busy = busyPath === worktree.path;
            const reason = reasons[worktree.path] ?? "";
            return (
              <article
                className={`worktree-card${worktree.locked ? " locked" : ""}${worktree.prunable ? " prunable" : ""}`}
                key={worktree.path}
              >
                <div className="worktree-card-main">
                  <div className="worktree-title-line">
                    <strong>{worktreeTitle(worktree)}</strong>
                    <span className={`worktree-kind-badge${worktree.isMain ? " main" : ""}`}>
                      {worktree.isMain ? "主工作树" : "关联工作树"}
                    </span>
                    {worktree.locked ? <span className="worktree-lock-badge">已锁定</span> : null}
                    {worktree.prunable ? (
                      <span className="worktree-warning-badge">失效记录</span>
                    ) : null}
                  </div>
                  <code className="worktree-path" title={worktree.path}>
                    {worktree.path}
                  </code>
                  <div className="worktree-meta">
                    <span>
                      HEAD <code>{shortCommitOid(worktree.headOid)}</code>
                    </span>
                    <span>
                      {worktree.detached ? "分离 HEAD" : (worktree.branchFullName ?? "无分支引用")}
                    </span>
                  </div>
                  {worktree.locked ? (
                    <p className="worktree-lock-reason">
                      {worktree.lockReason
                        ? `锁定原因：${worktree.lockReason}`
                        : "已锁定，未填写原因。"}
                    </p>
                  ) : null}
                  {readOnly ? <p className="worktree-readonly-note">{readOnly}</p> : null}
                </div>

                {!readOnly && !worktree.locked ? (
                  <div className="worktree-action-panel">
                    <label>
                      <span>可选锁定原因</span>
                      <input
                        type="text"
                        value={reason}
                        maxLength={LOCK_REASON_MAX_LENGTH}
                        disabled={busyPath !== null}
                        placeholder="例如：保留发布验证现场"
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [worktree.path]: event.target.value,
                          }))
                        }
                      />
                      <small>
                        {[...reason].length} / {LOCK_REASON_MAX_LENGTH}
                      </small>
                    </label>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busyPath !== null}
                      onClick={() => void lock(worktree)}
                    >
                      {busy ? "锁定中…" : "锁定"}
                    </button>
                  </div>
                ) : !readOnly && worktree.locked ? (
                  <div className="worktree-action-panel unlock">
                    <p>解锁后 Git 可以移动或删除此关联工作树。</p>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busyPath !== null}
                      onClick={() => void unlock(worktree)}
                    >
                      {busy ? "解锁中…" : "解锁"}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel-message">Git 未返回任何工作树记录。</div>
      )}
    </section>
  );
}
