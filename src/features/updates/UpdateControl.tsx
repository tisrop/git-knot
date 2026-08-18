import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../../app/Dialog";
import { ArrowClockwise, DownloadSimple, Power, X } from "@phosphor-icons/react";
import {
  desktopApi,
  type UpdateCheckResult,
  type UpdateProgressEvent,
} from "../../platform/desktop";
import { formatUpdateBytes, updateProgressPercent } from "./progress";

const LAST_UPDATE_CHECK_KEY = "git-knot.update.last-check";
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "更新操作失败，请稍后重试";
}

function shouldCheckInBackground() {
  const previous = Number(window.localStorage.getItem(LAST_UPDATE_CHECK_KEY));
  return !Number.isFinite(previous) || Date.now() - previous >= AUTO_CHECK_INTERVAL_MS;
}

export function UpdateControl() {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRequestId = useRef<string | null>(null);

  const progressPercent = useMemo(() => updateProgressPercent(progress), [progress]);

  async function checkForUpdate(background = false) {
    if (checking || installing || installed) return;
    setChecking(true);
    if (!background) setError(null);
    try {
      const next = await desktopApi.updates.check();
      setResult(next);
      setInstalled(false);
      if (!background) setError(null);
      window.localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(Date.now()));
    } catch (cause) {
      if (!background) setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!shouldCheckInBackground()) return;
    const timeout = window.setTimeout(() => void checkForUpdate(true), 1200);
    return () => window.clearTimeout(timeout);
    // Background update checks only run once for this mounted application shell.
  }, []);

  async function openDialog() {
    setOpen(true);
    if (!result && !checking) await checkForUpdate();
  }

  async function installUpdate() {
    const version = result?.version;
    if (!result?.available || !version || installing || installed) return;

    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setInstalling(true);
    setProgress({
      requestId,
      downloaded: 0,
      total: null,
      phase: "downloading",
    });
    setError(null);

    let stopListening = () => {};
    try {
      stopListening = await desktopApi.updates.subscribeProgress((event) => {
        if (event.requestId === activeRequestId.current) setProgress(event);
      });
      await desktopApi.updates.downloadAndInstall(requestId, version);
      setInstalled(true);
      setProgress(null);
    } catch (cause) {
      setError(errorMessage(cause));
      setProgress(null);
    } finally {
      stopListening();
      activeRequestId.current = null;
      setInstalling(false);
    }
  }

  async function restartApplication() {
    if (!installed || restarting) return;
    setRestarting(true);
    setError(null);
    try {
      await desktopApi.updates.restart();
    } catch (cause) {
      setError(errorMessage(cause));
      setRestarting(false);
    }
  }

  const buttonLabel = result?.available ? `发现新版本 v${result.version}` : "关于与应用更新";

  return (
    <>
      <button
        className={`icon-button sidebar-update-button${result?.available ? " update-available" : ""}`}
        type="button"
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => void openDialog()}
      >
        <DownloadSimple size={14} weight={result?.available ? "fill" : "bold"} aria-hidden="true" />
        {result?.available ? <span className="update-available-dot" aria-hidden="true" /> : null}
      </button>

      <Dialog
        open={open}
        className="confirmation-dialog update-dialog"
        ariaLabelledBy="update-dialog-title"
        ariaDescribedBy="update-dialog-description"
        busy={installing || restarting}
        onClose={() => setOpen(false)}
      >
        <header className="update-dialog-header">
          <div>
            <p className="eyebrow">GITHUB RELEASES</p>
            <h2 id="update-dialog-title">关于与应用更新</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            disabled={installing || restarting}
            aria-label="关闭更新窗口"
            title="关闭"
            onClick={() => setOpen(false)}
          >
            <X size={15} weight="bold" aria-hidden="true" />
          </button>
        </header>

        <p id="update-dialog-description">
          git-knot 只从官方 GitHub Release 下载经过签名验证的更新包。
        </p>

        <div className="update-version-grid">
          <div>
            <span>当前版本</span>
            <strong>v{result?.currentVersion ?? "0.1.0"}</strong>
          </div>
          <div>
            <span>最新版本</span>
            <strong>
              {checking
                ? "检查中…"
                : result?.available
                  ? `v${result.version}`
                  : result
                    ? "已是最新"
                    : "—"}
            </strong>
          </div>
        </div>

        {result?.available ? (
          <section className="update-release-card">
            <header>
              <strong>v{result.version}</strong>
              {result.publishedAt ? (
                <time dateTime={result.publishedAt}>
                  {new Date(result.publishedAt).toLocaleString("zh-CN")}
                </time>
              ) : null}
            </header>
            <pre>{result.notes?.trim() || "该版本没有提供更新说明。"}</pre>
          </section>
        ) : result && !checking ? (
          <p className="panel-message success">当前已经是最新版本。</p>
        ) : null}

        {progress ? (
          <section className="update-progress" aria-live="polite">
            <div>
              <strong>{progress.phase === "installing" ? "正在安装更新…" : "正在下载更新…"}</strong>
              <span>
                {progress.phase === "installing"
                  ? "签名验证已通过，正在写入安装包"
                  : progress.total
                    ? `${formatUpdateBytes(progress.downloaded)} / ${formatUpdateBytes(progress.total)}`
                    : formatUpdateBytes(progress.downloaded)}
              </span>
            </div>
            <progress max={100} value={progressPercent ?? undefined}>
              {progressPercent ?? 0}%
            </progress>
          </section>
        ) : null}

        {installed ? (
          <p className="panel-message success">更新已经安装完成。重启 git-knot 后将运行新版本。</p>
        ) : null}
        {error ? <p className="panel-message error-message">{error}</p> : null}

        <div className="confirmation-actions update-dialog-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={checking || installing || installed || restarting}
            onClick={() => void checkForUpdate()}
          >
            <ArrowClockwise size={14} aria-hidden="true" />
            {checking ? "检查中…" : "检查更新"}
          </button>
          {installed ? (
            <button
              className="primary-button"
              type="button"
              disabled={restarting}
              onClick={() => void restartApplication()}
            >
              <Power size={14} weight="bold" aria-hidden="true" />
              {restarting ? "正在重启…" : "重启完成更新"}
            </button>
          ) : result?.available ? (
            <button
              className="primary-button"
              type="button"
              disabled={checking || installing}
              onClick={() => void installUpdate()}
            >
              <DownloadSimple size={14} weight="bold" aria-hidden="true" />
              {installing ? "正在安装…" : `下载并安装 v${result.version}`}
            </button>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
