import type { FormEvent } from "react";
import { Dialog } from "../../app/Dialog";
import type { GitOperationEvent } from "../../platform/desktop";

interface CloneRepositoryDialogProps {
  open: boolean;
  remoteUrl: string;
  parentDirectory: string;
  operation: GitOperationEvent | null;
  error: string | null;
  starting: boolean;
  choosingDirectory: boolean;
  onRemoteUrlChange(value: string): void;
  onPickParentDirectory(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onCancelOperation(): void;
  onClose(): void;
}

function isActive(operation: GitOperationEvent | null) {
  return Boolean(operation && ["queued", "running", "progress"].includes(operation.state));
}

export function CloneRepositoryDialog({
  open,
  remoteUrl,
  parentDirectory,
  operation,
  error,
  starting,
  choosingDirectory,
  onRemoteUrlChange,
  onPickParentDirectory,
  onSubmit,
  onCancelOperation,
  onClose,
}: CloneRepositoryDialogProps) {
  const active = isActive(operation);
  const busy = starting || choosingDirectory || active;
  const terminalError =
    operation && ["failed", "cancelled", "timed_out"].includes(operation.state)
      ? operation.message
      : null;

  return (
    <Dialog
      open={open}
      as="form"
      className="confirmation-dialog clone-dialog"
      ariaLabelledBy="clone-dialog-title"
      ariaDescribedBy="clone-dialog-description"
      busy={busy}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <p className="eyebrow">GIT CLONE</p>
      <h2 id="clone-dialog-title">克隆远端仓库</h2>
      <p id="clone-dialog-description">
        仅接受 HTTPS、SSH 或 user@host:path 地址。目录名由 Rust 从地址推导，不接受自定义 Git 参数。
      </p>

      <label className="clone-field">
        <span>远端仓库地址</span>
        <input
          type="text"
          value={remoteUrl}
          onChange={(event) => onRemoteUrlChange(event.target.value)}
          placeholder="https://github.com/owner/repository.git"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          required
        />
      </label>

      <div className="clone-field">
        <span>保存到</span>
        <div className="clone-directory-row">
          <output title={parentDirectory || "尚未选择文件夹"}>
            {parentDirectory || "尚未选择文件夹"}
          </output>
          <button
            type="button"
            className="secondary-button"
            onClick={onPickParentDirectory}
            disabled={busy}
          >
            {choosingDirectory ? "选择中…" : "选择文件夹"}
          </button>
        </div>
      </div>

      {operation ? (
        <section className={`clone-progress ${terminalError ? "error" : ""}`} aria-live="polite">
          <div>
            <strong>{operation.message}</strong>
            <span>{operation.repositoryPath}</span>
          </div>
          {operation.percent !== null ? (
            <progress max={100} value={operation.percent}>
              {operation.percent}%
            </progress>
          ) : active ? (
            <progress max={100} />
          ) : null}
        </section>
      ) : error ? (
        <p className="clone-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="confirmation-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
          关闭
        </button>
        {active ? (
          <button type="button" className="danger-button" onClick={onCancelOperation}>
            取消克隆
          </button>
        ) : (
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !remoteUrl.trim() || !parentDirectory}
          >
            {starting ? "正在启动…" : "开始克隆"}
          </button>
        )}
      </div>
    </Dialog>
  );
}
