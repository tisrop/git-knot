import { useMemo, useState, type FormEvent } from "react";
import { Dialog } from "../../app/Dialog";
import { ThemedSelect } from "../../app/ThemedSelect";
import type { BranchInfo, PushBranchTargetInput, RepositoryRefs } from "../../platform/desktop";
import { currentUpstreamTarget, remoteBranchTargets } from "./pushTarget";

type TargetMode = "existing" | "new";

interface PushBranchTargetDialogProps {
  branch: BranchInfo;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPush: (input: PushBranchTargetInput) => void;
  refs: RepositoryRefs;
  returnFocusElement?: HTMLElement | null;
}

export function PushBranchTargetDialog({
  branch,
  busy,
  error,
  onClose,
  onPush,
  refs,
  returnFocusElement = null,
}: PushBranchTargetDialogProps) {
  const targets = useMemo(() => remoteBranchTargets(refs), [refs]);
  const upstreamTarget = useMemo(() => currentUpstreamTarget(branch, targets), [branch, targets]);
  const [mode, setMode] = useState<TargetMode>(upstreamTarget ? "existing" : "new");
  const [remoteName, setRemoteName] = useState(
    upstreamTarget?.remoteName ?? refs.remotes[0]?.name ?? "",
  );
  const initialExisting =
    upstreamTarget ?? targets.find((target) => target.remoteName === remoteName) ?? null;
  const [existingFullName, setExistingFullName] = useState(initialExisting?.fullName ?? "");
  const [newBranchName, setNewBranchName] = useState(branch.name);
  const remoteTargets = targets.filter((target) => target.remoteName === remoteName);
  const selectedExisting =
    remoteTargets.find((target) => target.fullName === existingFullName) ?? null;
  const canPush =
    mode === "existing" ? selectedExisting !== null : Boolean(remoteName && newBranchName.trim());

  function changeRemote(nextRemoteName: string) {
    setRemoteName(nextRemoteName);
    setExistingFullName(
      targets.find((target) => target.remoteName === nextRemoteName)?.fullName ?? "",
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canPush) return;
    const target = mode === "existing" ? selectedExisting : null;
    onPush({
      localFullName: branch.fullName,
      remoteName,
      remoteBranchName: target?.branchName ?? newBranchName.trim(),
      expectedLocalOid: branch.oid,
      expectedRemoteOid: target?.oid ?? null,
    });
  }

  return (
    <Dialog
      open
      as="form"
      className="confirmation-dialog push-target-dialog"
      ariaLabelledBy="push-target-dialog-title"
      ariaDescribedBy="push-target-dialog-description"
      busy={busy}
      returnFocusElement={returnFocusElement}
      closeOnBackdrop
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="eyebrow">COMMIT AND PUSH</p>
      <h2 id="push-target-dialog-title">选择推送目标</h2>
      <p id="push-target-dialog-description">
        提交后将 <strong>{branch.name}</strong> 推送到所选目标，并设置为当前分支的上游。
      </p>

      <div className="push-target-mode" role="group" aria-label="远端分支目标类型">
        <button
          type="button"
          className={mode === "existing" ? "selected" : ""}
          aria-pressed={mode === "existing"}
          disabled={busy || targets.length === 0}
          onClick={() => {
            setMode("existing");
            if (!existingFullName) {
              const firstTarget =
                targets.find((target) => target.remoteName === remoteName) ?? targets[0];
              if (firstTarget) {
                setRemoteName(firstTarget.remoteName);
                setExistingFullName(firstTarget.fullName);
              }
            }
          }}
        >
          现有分支
        </button>
        <button
          type="button"
          className={mode === "new" ? "selected" : ""}
          aria-pressed={mode === "new"}
          disabled={busy}
          onClick={() => setMode("new")}
        >
          新建分支
        </button>
      </div>

      <div className="push-target-fields">
        <label>
          <span>目标远端</span>
          <ThemedSelect
            ariaLabel="选择目标远端"
            disabled={busy}
            value={remoteName}
            options={refs.remotes.map((remote) => ({ label: remote.name, value: remote.name }))}
            onChange={changeRemote}
          />
        </label>
        {mode === "existing" ? (
          <label>
            <span>远端分支</span>
            <ThemedSelect
              ariaLabel="选择现有远端分支"
              disabled={busy || remoteTargets.length === 0}
              value={selectedExisting?.fullName ?? ""}
              options={remoteTargets.map((target) => ({
                label: target.branchName,
                value: target.fullName,
              }))}
              onChange={setExistingFullName}
            />
          </label>
        ) : (
          <label>
            <span>新分支名称</span>
            <input
              data-dialog-initial-focus="true"
              value={newBranchName}
              maxLength={255}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
          </label>
        )}
      </div>

      <dl className="publish-branch-summary">
        <div>
          <dt>本地分支</dt>
          <dd>{branch.name}</dd>
        </div>
        <div>
          <dt>推送到</dt>
          <dd>
            {remoteName && (selectedExisting || newBranchName.trim())
              ? `${remoteName}/${selectedExisting?.branchName ?? newBranchName.trim()}`
              : "-"}
          </dd>
        </div>
      </dl>
      <p className="push-target-safety">
        {mode === "existing"
          ? "仅允许快进更新；远端分支变化后会停止推送。"
          : "仅创建不存在的远端分支，不会覆盖同名分支。"}
      </p>
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirmation-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary-button" type="submit" disabled={busy || !canPush}>
          {busy ? "提交并推送中…" : "提交并推送"}
        </button>
      </div>
    </Dialog>
  );
}
