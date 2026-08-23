import { useState, type FormEvent } from "react";
import { Dialog } from "../../app/Dialog";
import { ThemedSelect } from "../../app/ThemedSelect";
import type { BranchInfo, PublishBranchInput } from "../../platform/desktop";

interface PublishBranchDialogProps {
  branch: BranchInfo;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPublish: (input: PublishBranchInput) => void;
  remoteNames: string[];
  returnFocusElement?: HTMLElement | null;
}

export function PublishBranchDialog({
  branch,
  busy,
  error,
  onClose,
  onPublish,
  remoteNames,
  returnFocusElement = null,
}: PublishBranchDialogProps) {
  const [remoteName, setRemoteName] = useState(remoteNames[0] ?? "");
  const [remoteBranchName, setRemoteBranchName] = useState(branch.name);
  const canPublish = Boolean(remoteName && remoteBranchName.trim());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canPublish) return;
    onPublish({
      localFullName: branch.fullName,
      remoteName,
      remoteBranchName: remoteBranchName.trim(),
      expectedLocalOid: branch.oid,
    });
  }

  return (
    <Dialog
      open
      as="form"
      className="confirmation-dialog publish-branch-dialog"
      ariaLabelledBy="publish-branch-dialog-title"
      ariaDescribedBy="publish-branch-dialog-description"
      busy={busy}
      returnFocusElement={returnFocusElement}
      closeOnBackdrop
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="eyebrow">PUBLISH BRANCH</p>
      <h2 id="publish-branch-dialog-title">发布当前分支</h2>
      <p id="publish-branch-dialog-description">
        在远端创建新分支，并将它设置为 <strong>{branch.name}</strong> 的上游。
      </p>
      <div className="publish-branch-target">
        <label>
          <span>目标远端</span>
          <ThemedSelect
            ariaLabel="选择目标远端"
            disabled={busy}
            value={remoteName}
            options={remoteNames.map((name) => ({ label: name, value: name }))}
            onChange={setRemoteName}
          />
        </label>
        <label>
          <span>新建远端分支</span>
          <input
            data-dialog-initial-focus="true"
            value={remoteBranchName}
            maxLength={255}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setRemoteBranchName(event.target.value)}
          />
        </label>
      </div>
      <dl className="publish-branch-summary">
        <div>
          <dt>本地分支</dt>
          <dd>{branch.name}</dd>
        </div>
        <div>
          <dt>发布到</dt>
          <dd>
            {remoteName && remoteBranchName.trim()
              ? `${remoteName}/${remoteBranchName.trim()}`
              : "-"}
          </dd>
        </div>
      </dl>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirmation-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary-button" type="submit" disabled={busy || !canPublish}>
          {busy ? "发布中…" : "创建并推送"}
        </button>
      </div>
    </Dialog>
  );
}
