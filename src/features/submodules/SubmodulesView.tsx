import { useCallback, useEffect, useRef, useState } from "react";
import {
  desktopApi,
  type Project,
  type RepositorySubmodules,
  type SubmoduleInfo,
} from "../../platform/desktop";

interface SubmodulesViewProps {
  project: Project;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "子模块读取失败，请稍后重试";
}

const stateLabels: Record<SubmoduleInfo["state"], string> = {
  clean: "干净",
  modified: "已修改",
  uninitialized: "未初始化",
  conflicted: "有冲突",
  unsafe: "需检查",
};

function shortOid(oid: string | null) {
  return oid ? oid.slice(0, 10) : "—";
}

export function SubmodulesView({ project }: SubmodulesViewProps) {
  const [snapshot, setSnapshot] = useState<RepositorySubmodules | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (path: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await desktopApi.repository.submodules(path);
      if (requestId.current === id) setSnapshot(next);
    } catch (cause) {
      if (requestId.current !== id) return;
      setSnapshot(null);
      setLoadError(errorMessage(cause));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSnapshot(null);
    void load(project.path);
    return () => {
      ++requestId.current;
    };
  }, [load, project.path]);

  const submodules = snapshot?.submodules ?? [];
  const cleanCount = submodules.filter((item) => item.state === "clean").length;
  const attentionCount = submodules.length - cleanCount;

  return (
    <section className="submodules-view" aria-label="Git 子模块">
      <header className="submodules-header">
        <div>
          <p className="eyebrow">READ-ONLY INVENTORY</p>
          <h3>子模块</h3>
          <p>只读取当前 index 中的 gitlink、.gitmodules 配置和工作区状态。</p>
        </div>
        <div className="submodules-header-actions">
          <span className="count-badge">{submodules.length} 个</span>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={loading}
            onClick={() => void load(project.path)}
          >
            {loading ? "读取中…" : "刷新"}
          </button>
        </div>
      </header>

      <p className="submodules-safety-note">
        当前版本不执行 init、update、sync、add、remove
        或递归网络操作；不会因为打开此页面修改仓库或下载对象。
      </p>

      {loadError ? (
        <div className="panel-message error" role="alert">
          <strong>无法读取子模块清单</strong>
          <p>{loadError}</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void load(project.path)}
          >
            重试
          </button>
        </div>
      ) : loading && !snapshot ? (
        <div className="panel-message">正在读取 Git 子模块清单…</div>
      ) : submodules.length === 0 ? (
        <div className="submodules-empty">
          <strong>没有已记录的子模块</strong>
          <p>
            {snapshot?.gitmodulesPresent
              ? ".gitmodules 存在，但当前 index 没有可展示的 gitlink。"
              : "当前仓库没有 .gitmodules 或 gitlink。"}
          </p>
        </div>
      ) : (
        <div className="submodules-content">
          <div className="submodules-summary" aria-live="polite">
            <span>
              清单 <strong>{submodules.length}</strong>
            </span>
            <span>
              干净 <strong>{cleanCount}</strong>
            </span>
            <span>
              需要关注 <strong>{attentionCount}</strong>
            </span>
          </div>
          <div className="submodule-list">
            {submodules.map((submodule) => (
              <SubmoduleCard key={submodule.path} submodule={submodule} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SubmoduleCard({ submodule }: { submodule: SubmoduleInfo }) {
  return (
    <article className={`submodule-card ${submodule.state}`}>
      <div className="submodule-card-main">
        <div className="submodule-title-line">
          <strong>{submodule.path}</strong>
          <span className={`submodule-state ${submodule.state}`}>
            {stateLabels[submodule.state]}
          </span>
        </div>
        <div className="submodule-meta">
          <span>{submodule.name ?? "未配置名称"}</span>
          <span>
            目标 <code>{shortOid(submodule.expectedOid)}</code>
          </span>
          {submodule.branch ? (
            <span>
              分支 <code>{submodule.branch}</code>
            </span>
          ) : null}
        </div>
        {submodule.url ? <code className="submodule-url">{submodule.url}</code> : null}
        {submodule.stateDetail ? <p className="submodule-detail">{submodule.stateDetail}</p> : null}
        {submodule.conflictOids.length > 0 ? (
          <p className="submodule-detail conflict-detail">
            冲突 stage：{submodule.conflictOids.map((oid) => shortOid(oid)).join("、")}
          </p>
        ) : null}
      </div>
      <div className="submodule-card-side">
        <span className="submodule-readonly-badge">只读</span>
        {!submodule.configured ? <p>缺少 .gitmodules 配置</p> : null}
        {submodule.state === "uninitialized" ? <p>工作区目录尚未初始化</p> : null}
        {submodule.state === "modified" ? <p>子模块 HEAD 与 gitlink 不一致或工作区有变化</p> : null}
        {submodule.state === "conflicted" ? <p>请使用系统 Git 检查冲突，应用不会自动解决</p> : null}
      </div>
    </article>
  );
}
