import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { GitOperationEvent, Project, RepositoryStatus } from "../../platform/desktop";
import { HistoryView } from "../history/HistoryView";
import { WorkspaceView } from "../workspace/WorkspaceView";

interface RepositoryWorkbenchViewProps {
  project: Project;
  status: RepositoryStatus | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onStatusChange: (status: RepositoryStatus) => void;
  onError: (message: string) => void;
  gitOperations: GitOperationEvent[];
  onOperationStarted: (operation: GitOperationEvent) => void;
  /** Bumped when the repository's Git directory changed on disk, so history
   * reloads in place without resetting the user's filters or scroll. */
  historyRefreshSignal?: number;
}

type DiffSource = "worktree" | "history";

const MIN_CHANGES_HEIGHT = 190;
const MIN_HISTORY_HEIGHT = 160;
const DIVIDER_HEIGHT = 8;

function clampSourceHeight(value: number, containerHeight: number) {
  return Math.max(
    MIN_CHANGES_HEIGHT,
    Math.min(value, containerHeight - MIN_HISTORY_HEIGHT - DIVIDER_HEIGHT),
  );
}

export function RepositoryWorkbenchView({
  project,
  status,
  refreshing,
  onRefresh,
  onStatusChange,
  onError,
  gitOperations,
  onOperationStarted,
  historyRefreshSignal = 0,
}: RepositoryWorkbenchViewProps) {
  const [diffSource, setDiffSource] = useState<DiffSource>("worktree");
  const [sourcePaneHeight, setSourcePaneHeight] = useState<number | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setDiffSource("worktree");
    setSourcePaneHeight(null);
    setHistoryCollapsed(false);
  }, [project.path]);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  function currentSourceHeight() {
    return (
      containerRef.current?.querySelector<HTMLElement>(".scm-panel")?.getBoundingClientRect()
        .height ?? MIN_CHANGES_HEIGHT
    );
  }

  function beginResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();

    const container = containerRef.current;
    if (!container) return;
    resizeCleanupRef.current?.();

    const startY = event.clientY;
    const startHeight = currentSourceHeight();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture?.(pointerId);
    document.body.classList.add("workbench-resizing");

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const containerHeight = container.getBoundingClientRect().height;
      setSourcePaneHeight(
        clampSourceHeight(startHeight + moveEvent.clientY - startY, containerHeight),
      );
    };

    const finishResize = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("workbench-resizing");
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = finishResize;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const containerHeight = containerRef.current?.getBoundingClientRect().height;
    if (!containerHeight) return;

    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setSourcePaneHeight(
        clampSourceHeight(
          currentSourceHeight() + (event.key === "ArrowUp" ? -step : step),
          containerHeight,
        ),
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setSourcePaneHeight(MIN_CHANGES_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      setSourcePaneHeight(containerHeight - MIN_HISTORY_HEIGHT - DIVIDER_HEIGHT);
    }
  }

  const workbenchStyle = {
    "--workbench-source-height": sourcePaneHeight ? `${sourcePaneHeight}px` : undefined,
  } as CSSProperties;

  return (
    <div
      className={`repository-workbench${historyCollapsed ? " history-collapsed" : ""}`}
      ref={containerRef}
      style={workbenchStyle}
    >
      <WorkspaceView
        embedded
        diffPanelVisible={diffSource === "worktree"}
        project={project}
        status={status}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onStatusChange={onStatusChange}
        onError={onError}
        onDiffFocus={() => setDiffSource("worktree")}
        onHistoryChange={() => setHistoryRefreshToken((current) => current + 1)}
        gitOperations={gitOperations}
        onOperationStarted={onOperationStarted}
      />

      <div
        className="workbench-source-divider"
        role="separator"
        aria-label="调整更改与提交历史区域高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_CHANGES_HEIGHT}
        aria-valuenow={Math.round(sourcePaneHeight ?? currentSourceHeight())}
        tabIndex={0}
        onDoubleClick={() => setSourcePaneHeight(null)}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={beginResize}
      />

      <HistoryView
        embedded
        collapsed={historyCollapsed}
        diffPanelVisible={diffSource === "history"}
        project={project}
        refreshToken={historyRefreshToken}
        silentRefreshToken={historyRefreshSignal}
        onDiffFocus={() => setDiffSource("history")}
        onStatusChange={onStatusChange}
        gitOperations={gitOperations}
        onOperationStarted={onOperationStarted}
        onCollapsedChange={setHistoryCollapsed}
      />
    </div>
  );
}
