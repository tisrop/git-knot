import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  Check,
  Cloud,
  CloudArrowDown,
  CloudArrowUp,
  Copy,
  DotsThree,
  FileText,
  GitBranch,
  GitCommit,
  GitMerge,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Tag,
  TextT,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Dialog } from "../../app/Dialog";
import { UnifiedDiffView } from "../diff/UnifiedDiffView";
import { ImageDiffView } from "../diff/ImageDiffView";
import {
  desktopApi,
  type AmendCommitPreview,
  type CherryPickCommitPreview,
  type CommitDetails,
  type CommitSummary,
  type GitOperationEvent,
  type HistoryQuery,
  type ImageDiff,
  type LocalMergePreview,
  type LocalMergeStrategy,
  type Project,
  type RepositoryStatus,
  type ResetCommitMode,
  type ResetCommitPreview,
  type RevertCommitPreview,
} from "../../platform/desktop";
import {
  buildCommitGraphRows,
  buildCommitFileTreeEntries,
  commitFileStatusLabel,
  formatCommitDate,
  isCurrentRepositoryPath,
  appendUniqueCommitsWithLimit,
  LruCache,
  parseUnifiedDiff,
  patchForFile,
  shortCommitOid,
  type CommitGraphRowLayout,
  type CommitGraphSegment,
  type CommitGraphTone,
} from "./history";
import {
  isActiveGitOperation,
  isTerminalGitOperation,
  latestRepositoryOperation,
} from "../operations/gitOperations";

const HISTORY_PAGE_SIZE = 150;
const HISTORY_SOFT_LIMIT = 2_000;
const HOVER_DETAILS_CACHE_CAPACITY = 8;
const HISTORY_OPERATION_KINDS = new Set<GitOperationEvent["kind"]>([
  "fetch",
  "pull",
  "push",
  "sync",
]);

interface HistoryViewProps {
  project: Project;
  embedded?: boolean;
  collapsed?: boolean;
  diffPanelVisible?: boolean;
  onDiffFocus?: () => void;
  onStatusChange?: (status: RepositoryStatus) => void;
  refreshToken?: number;
  gitOperations: GitOperationEvent[];
  onOperationStarted: (operation: GitOperationEvent) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}

interface SelectedCommit {
  repositoryPath: string;
  oid: string;
}

interface HistoryFilters {
  search: string;
  author: string;
  after: string;
  before: string;
  filePath: string;
}

type HistoryRefKind = "local" | "remote" | "tag";

interface HistoryRefOption {
  ahead: number;
  behind: number;
  current: boolean;
  fullName: string;
  kind: HistoryRefKind;
  name: string;
  oid: string;
  upstream: string | null;
  upstreamMissing: boolean;
}

type HistoryLoadMode = "replace" | "append";
type HistoryFileViewMode = "list" | "tree";

interface HistoryMergeDialogState {
  preview: LocalMergePreview | null;
  query: string;
  strategy: LocalMergeStrategy;
}

interface CommitContextMenuState {
  commit: CommitSummary;
  x: number;
  y: number;
}

interface CommitHoverCardState {
  anchorTop: number;
  commit: CommitSummary;
  x: number;
  y: number;
}

type CommitActionDialog =
  | { kind: "branch"; commit: CommitSummary }
  | { kind: "amend"; commit: CommitSummary; preview: AmendCommitPreview }
  | { kind: "revert"; commit: CommitSummary; preview: RevertCommitPreview }
  | { kind: "cherryPick"; commit: CommitSummary; preview: CherryPickCommitPreview }
  | { kind: "reset"; commit: CommitSummary; preview: ResetCommitPreview };

const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  search: "",
  author: "",
  after: "",
  before: "",
  filePath: "",
};

function normalizeFilters(filters: HistoryFilters): HistoryFilters {
  return {
    search: filters.search.trim(),
    author: filters.author.trim(),
    after: filters.after.trim(),
    before: filters.before.trim(),
    filePath: filters.filePath.trim(),
  };
}

function absoluteRepositoryPath(repositoryPath: string, filePath: string) {
  const root = repositoryPath.replace(/[\\/]+$/, "");
  const relativePath = filePath.replace(/^[\\/]+/, "");
  if (!root) return `${repositoryPath}${relativePath}`;
  const separator = repositoryPath.includes("\\") && !repositoryPath.includes("/") ? "\\" : "/";
  return `${root}${separator}${relativePath}`;
}

function historyQuery(
  filters: HistoryFilters,
  offset: number,
  refFullName: string | null,
): HistoryQuery {
  return {
    offset,
    limit: HISTORY_PAGE_SIZE,
    refFullName,
    search: filters.search,
    author: filters.author,
    after: filters.after || null,
    before: filters.before || null,
    filePath: filters.filePath || null,
  };
}

function historyRefKindLabel(kind: HistoryRefKind) {
  if (kind === "local") return "本地分支";
  if (kind === "remote") return "远程分支";
  return "标签";
}

function historyRefsFromData(
  branches: Awaited<ReturnType<typeof desktopApi.repository.refs>>["branches"],
  tags: Awaited<ReturnType<typeof desktopApi.repository.tags>>["tags"],
): HistoryRefOption[] {
  return [
    ...branches.map((branch) => ({
      ahead: branch.ahead,
      behind: branch.behind,
      current: branch.current,
      fullName: branch.fullName,
      kind: branch.kind,
      name: branch.name,
      oid: branch.oid,
      upstream: branch.upstream,
      upstreamMissing: branch.upstreamMissing,
    })),
    ...tags.map((tag) => ({
      ahead: 0,
      behind: 0,
      current: false,
      fullName: tag.fullName,
      kind: "tag" as const,
      name: tag.name,
      oid: tag.targetOid,
      upstream: null,
      upstreamMissing: false,
    })),
  ];
}

function hasActiveFilters(filters: HistoryFilters) {
  return Object.values(filters).some(Boolean);
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "操作失败，请稍后重试";
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("无法写入剪贴板");
}

function resetModeLabel(mode: ResetCommitMode) {
  if (mode === "soft") return "保留更改并保持暂存";
  if (mode === "mixed") return "保留更改并取消暂存";
  return "丢弃已跟踪文件更改";
}

export function HistoryView({
  project,
  embedded = false,
  collapsed = false,
  diffPanelVisible = true,
  onDiffFocus,
  onStatusChange,
  refreshToken = 0,
  gitOperations,
  onOperationStarted,
  onCollapsedChange,
}: HistoryViewProps) {
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>({ ...EMPTY_HISTORY_FILTERS });
  const [activeFilters, setActiveFilters] = useState<HistoryFilters>({ ...EMPTY_HISTORY_FILTERS });
  const [selectedRefFullName, setSelectedRefFullName] = useState<string | null>(null);
  const [historyRefs, setHistoryRefs] = useState<HistoryRefOption[]>([]);
  const [remoteNames, setRemoteNames] = useState<string[]>([]);
  const [historyRefsError, setHistoryRefsError] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<SelectedCommit | null>(null);
  const [expandedCommitOid, setExpandedCommitOid] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [imageDiff, setImageDiff] = useState<ImageDiff | null>(null);
  const [loadingImageDiff, setLoadingImageDiff] = useState(false);
  const [imageDiffError, setImageDiffError] = useState<string | null>(null);
  const [historyLoadMode, setHistoryLoadMode] = useState<HistoryLoadMode | null>("replace");
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyLimitReached, setHistoryLimitReached] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [contextMenu, setContextMenu] = useState<CommitContextMenuState | null>(null);
  const [hoverCard, setHoverCard] = useState<CommitHoverCardState | null>(null);
  const [hoverDetails, setHoverDetails] = useState<CommitDetails | null>(null);
  const [hoverDetailsError, setHoverDetailsError] = useState<string | null>(null);
  const [loadingHoverDetails, setLoadingHoverDetails] = useState(false);
  const [actionDialog, setActionDialog] = useState<CommitActionDialog | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchOnly, setSearchOnly] = useState(false);
  const [refsMenuOpen, setRefsMenuOpen] = useState(false);
  const [refsQuery, setRefsQuery] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuPosition, setMoreMenuPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [fileViewMode, setFileViewMode] = useState<HistoryFileViewMode>("list");
  const [mergeDialog, setMergeDialog] = useState<HistoryMergeDialogState | null>(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [operationAction, setOperationAction] = useState<"fetch" | "pull" | "push" | null>(null);
  const [amendSubject, setAmendSubject] = useState("");
  const [amendBody, setAmendBody] = useState("");
  const [hardResetAcknowledged, setHardResetAcknowledged] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const hoverCardRef = useRef<HTMLElement | null>(null);
  const historyRequest = useRef(0);
  const historyRefsRequest = useRef(0);
  const activeRepositoryPath = useRef(project.path);
  activeRepositoryPath.current = project.path;
  const activeFiltersRef = useRef(activeFilters);
  activeFiltersRef.current = activeFilters;
  const selectedRefFullNameRef = useRef(selectedRefFullName);
  selectedRefFullNameRef.current = selectedRefFullName;
  const handledTerminalOperations = useRef(new Set<string>());
  const detailsRequest = useRef(0);
  const imageDiffRequest = useRef(0);
  const hoverTimer = useRef<number | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const hoverRequest = useRef(0);
  const hoverDetailsCache = useRef(
    new LruCache<string, CommitDetails>(HOVER_DETAILS_CACHE_CAPACITY),
  );
  const filterSearchInputRef = useRef<HTMLInputElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const moreMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const loadHistory = useCallback(
    async (
      repositoryPath: string,
      filters: HistoryFilters,
      mode: HistoryLoadMode,
      offset: number,
      refFullName: string | null,
    ) => {
      const requestId = ++historyRequest.current;
      if (mode === "replace") {
        ++detailsRequest.current;
        setCommits([]);
        setSelected(null);
        setExpandedCommitOid(null);
        setSelectedFilePath(null);
        setDetails(null);
        setImageDiff(null);
        setImageDiffError(null);
        setLoadingImageDiff(false);
        setDetailsError(null);
        setLoadingDetails(false);
        setHasMore(false);
        setHistoryLimitReached(false);
        setNextOffset(0);
      }
      setHistoryLoadMode(mode);
      setHistoryError(null);
      try {
        const page = await desktopApi.repository.history(
          repositoryPath,
          historyQuery(filters, offset, refFullName),
        );
        if (historyRequest.current !== requestId) return;
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
        if (mode === "replace") {
          setCommits(page.commits);
          if (page.commits[0]) {
            setSelected({ repositoryPath, oid: page.commits[0].oid });
            setExpandedCommitOid(null);
          } else {
            setSelected(null);
            setExpandedCommitOid(null);
          }
        } else {
          setCommits((current) => {
            const result = appendUniqueCommitsWithLimit(current, page.commits, HISTORY_SOFT_LIMIT);
            if (result.limitReached) {
              setHistoryLimitReached(true);
              setHasMore(false);
            }
            return result.commits;
          });
        }
      } catch (cause) {
        if (historyRequest.current === requestId) setHistoryError(errorMessage(cause));
      } finally {
        if (historyRequest.current === requestId) setHistoryLoadMode(null);
      }
    },
    [],
  );

  useEffect(() => {
    const emptyFilters = { ...EMPTY_HISTORY_FILTERS };
    const requestId = ++historyRefsRequest.current;
    setDraftFilters(emptyFilters);
    setActiveFilters(emptyFilters);
    setSelectedRefFullName(null);
    setHistoryRefs([]);
    setRemoteNames([]);
    setHistoryRefsError(null);
    setContextMenu(null);
    closeCommitHover();
    hoverDetailsCache.current.clear();
    setActionDialog(null);
    setActionBusy(false);
    setActionNotice(null);
    setActionError(null);
    setFiltersOpen(false);
    setSearchOnly(false);
    setRefsMenuOpen(false);
    setRefsQuery("");
    setMoreMenuOpen(false);
    setMoreMenuPosition(null);
    setMergeDialog(null);
    setNewBranchOpen(false);
    setNewBranchName("");
    setOperationAction(null);
    setHardResetAcknowledged(false);
    void loadHistory(project.path, emptyFilters, "replace", 0, null);
    void Promise.all([
      desktopApi.repository.refs(project.path),
      desktopApi.repository.tags(project.path),
    ])
      .then(([refs, tags]) => {
        if (historyRefsRequest.current !== requestId) return;
        setHistoryRefs(historyRefsFromData(refs.branches, tags.tags));
        setRemoteNames(refs.remotes.map((remote) => remote.name));
      })
      .catch((cause) => {
        if (historyRefsRequest.current === requestId) {
          setHistoryRefsError(errorMessage(cause));
        }
      });
  }, [loadHistory, project.path, refreshToken]);

  const fetchRemoteName =
    remoteNames[0] ?? historyRefs.find((ref) => ref.kind === "remote")?.name.split("/")[0] ?? null;
  const currentLocalBranch = historyRefs.find((ref) => ref.kind === "local" && ref.current);
  const currentUpstreamBranch = currentLocalBranch?.upstream
    ? historyRefs.find(
        (ref) =>
          ref.name === currentLocalBranch.upstream && ref.fullName !== currentLocalBranch.fullName,
      )
    : undefined;
  const operationEvent = useMemo(
    () => latestRepositoryOperation(gitOperations, project.path, HISTORY_OPERATION_KINDS),
    [gitOperations, project.path],
  );
  const operationInProgress = operationEvent !== null && isActiveGitOperation(operationEvent);
  const remoteOperationBusy = operationAction !== null || operationInProgress;

  useEffect(() => {
    if (!operationEvent || !isTerminalGitOperation(operationEvent)) return;
    const repositoryPath = operationEvent.repositoryPath;
    if (activeRepositoryPath.current !== repositoryPath) return;
    if (handledTerminalOperations.current.has(operationEvent.operationId)) return;
    handledTerminalOperations.current.add(operationEvent.operationId);

    setOperationAction(null);
    if (operationEvent.state === "succeeded") {
      setActionNotice(operationEvent.message);
      setActionError(null);
      void loadHistory(
        repositoryPath,
        activeFiltersRef.current,
        "replace",
        0,
        selectedRefFullNameRef.current,
      );
      void Promise.all([
        desktopApi.repository.refs(repositoryPath),
        desktopApi.repository.tags(repositoryPath),
      ])
        .then(([refs, tags]) => {
          if (activeRepositoryPath.current !== repositoryPath) return;
          setHistoryRefs(historyRefsFromData(refs.branches, tags.tags));
          setRemoteNames(refs.remotes.map((remote) => remote.name));
        })
        .catch((cause) => {
          if (activeRepositoryPath.current === repositoryPath) {
            setHistoryRefsError(errorMessage(cause));
          }
        });
    } else if (operationEvent.state === "cancelled") {
      setActionNotice(operationEvent.message);
    } else {
      setActionError(operationEvent.message);
    }
  }, [loadHistory, operationEvent]);

  useEffect(() => {
    if (!selected || selected.repositoryPath !== project.path) return;
    const requestId = ++detailsRequest.current;
    setLoadingDetails(true);
    setDetailsError(null);
    setDetails(null);
    void desktopApi.repository
      .commit(selected.repositoryPath, selected.oid)
      .then((nextDetails) => {
        if (detailsRequest.current !== requestId) return;
        hoverDetailsCache.current.set(`${selected.repositoryPath}:${selected.oid}`, nextDetails);
        setDetails(nextDetails);
        setSelectedFilePath(nextDetails.files[0]?.path ?? null);
      })
      .catch((cause) => {
        if (detailsRequest.current === requestId) setDetailsError(errorMessage(cause));
      })
      .finally(() => {
        if (detailsRequest.current === requestId) setLoadingDetails(false);
      });
  }, [project.path, selected]);

  useEffect(() => {
    setBranchName("");
  }, [project.path, selected?.oid]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFilters = normalizeFilters(draftFilters);
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    void loadHistory(project.path, nextFilters, "replace", 0, selectedRefFullName);
  }

  function clearFilters() {
    const emptyFilters = { ...EMPTY_HISTORY_FILTERS };
    setDraftFilters(emptyFilters);
    setActiveFilters(emptyFilters);
    void loadHistory(project.path, emptyFilters, "replace", 0, selectedRefFullName);
  }

  function showFilters(focusSearch = false) {
    setSearchOnly(focusSearch);
    setFiltersOpen(true);
    if (focusSearch) {
      window.requestAnimationFrame(() => filterSearchInputRef.current?.focus());
    }
  }

  function toggleMoreMenu() {
    setRefsMenuOpen(false);
    setMoreMenuOpen((current) => {
      const nextOpen = !current;
      if (!nextOpen) return false;

      const rect = moreMenuButtonRef.current?.getBoundingClientRect();
      if (rect) {
        const menuWidth = 208;
        const menuHeight = 278;
        const opensAbove = rect.bottom + menuHeight + 8 > window.innerHeight;
        setMoreMenuPosition({
          left: Math.max(8, Math.min(rect.left - 2, window.innerWidth - menuWidth - 8)),
          top: opensAbove ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4,
        });
      }
      return true;
    });
  }

  function changeHistoryRef(fullName: string) {
    const nextRef = fullName || null;
    setSelectedRefFullName(nextRef);
    void loadHistory(project.path, activeFilters, "replace", 0, nextRef);
  }

  async function runRemoteOperation(kind: "fetch" | "pull" | "push") {
    if (remoteOperationBusy) return;
    if (kind === "fetch" && !fetchRemoteName) {
      setActionError("当前仓库没有可抓取的远端");
      return;
    }

    setOperationAction(kind);
    setActionError(null);
    setActionNotice(null);
    try {
      const started =
        kind === "fetch"
          ? await desktopApi.repository.fetch(project.path, fetchRemoteName!)
          : kind === "pull"
            ? await desktopApi.repository.pull(project.path)
            : await desktopApi.repository.push(project.path);
      const message =
        kind === "fetch"
          ? `正在等待抓取 ${fetchRemoteName}`
          : kind === "pull"
            ? "正在等待拉取当前分支"
            : "正在等待推送当前分支";
      onOperationStarted({
        operationId: started.operationId,
        repositoryPath: project.path,
        kind,
        state: "queued",
        phase: "queued",
        percent: null,
        message,
        remoteTagDeletePreview: null,
      });
    } catch (cause) {
      setOperationAction(null);
      setActionError(errorMessage(cause));
    }
  }

  function openMergeDialog() {
    dialogReturnFocusRef.current = moreMenuButtonRef.current;
    setMoreMenuOpen(false);
    setActionError(null);
    setActionNotice(null);
    const localBranches = historyRefs.filter((ref) => ref.kind === "local" && !ref.current);
    if (localBranches.length === 0) {
      setActionNotice("没有可合并到当前分支的其他本地分支。");
      return;
    }
    setMergeDialog({ preview: null, query: "", strategy: "fast_forward_only" });
  }

  async function previewMergeBranch(targetFullName: string) {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const preview = await desktopApi.repository.previewLocalMerge(project.path, targetFullName);
      if (preview.mode === "up_to_date") {
        setMergeDialog(null);
        setActionNotice(`${preview.currentBranch} 已包含 ${preview.targetBranch} 的全部提交。`);
        return;
      }
      setMergeDialog((current) =>
        current
          ? {
              ...current,
              preview,
              strategy:
                preview.mode === "fast_forward" ? "fast_forward_only" : "create_merge_commit",
            }
          : current,
      );
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmLocalMerge() {
    if (actionBusy || !mergeDialog?.preview) return;
    const { preview, strategy } = mergeDialog;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await desktopApi.repository.mergeLocalBranch(
        project.path,
        preview.targetFullName,
        strategy,
      );
      updateHistoryRefsFromBranches(result.refs.branches);
      onStatusChange?.(result.status);
      setMergeDialog(null);
      await reloadCurrentHead();
      setActionNotice(`已将 ${preview.targetBranch} 合并到 ${preview.currentBranch}。`);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }

  async function createBranchFromToolbar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBranchName.trim();
    if (!name || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await desktopApi.repository.createBranch(project.path, name);
      updateHistoryRefsFromBranches(result.refs.branches);
      onStatusChange?.(result.status);
      setNewBranchOpen(false);
      setNewBranchName("");
      await reloadCurrentHead();
      setActionNotice(`已创建并切换到分支 ${name}。`);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    if (!moreMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!moreMenuRef.current?.contains(target) && !moreMenuPopoverRef.current?.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!refsMenuOpen) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRefsMenuOpen(false);
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => window.removeEventListener("keydown", closeWithEscape);
  }, [refsMenuOpen]);

  function cancelCommitHoverTimer() {
    if (hoverTimer.current === null) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }

  function cancelCommitHoverCloseTimer() {
    if (hoverCloseTimer.current === null) return;
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  }

  function closeCommitHover() {
    cancelCommitHoverTimer();
    cancelCommitHoverCloseTimer();
    ++hoverRequest.current;
    setHoverCard(null);
    setHoverDetails(null);
    setHoverDetailsError(null);
    setLoadingHoverDetails(false);
  }

  function scheduleCommitHoverClose() {
    cancelCommitHoverCloseTimer();
    hoverCloseTimer.current = window.setTimeout(() => {
      hoverCloseTimer.current = null;
      closeCommitHover();
    }, 160);
  }

  async function loadHoverDetails(commit: CommitSummary) {
    const repositoryPath = project.path;
    const cacheKey = `${repositoryPath}:${commit.oid}`;
    const selectedDetails = details?.commit.oid === commit.oid ? details : null;
    const cachedDetails = selectedDetails ?? hoverDetailsCache.current.get(cacheKey);
    if (cachedDetails) {
      setHoverDetails(cachedDetails);
      setHoverDetailsError(null);
      setLoadingHoverDetails(false);
      return;
    }

    const requestId = ++hoverRequest.current;
    setHoverDetails(null);
    setHoverDetailsError(null);
    setLoadingHoverDetails(true);
    try {
      const nextDetails = await desktopApi.repository.commit(repositoryPath, commit.oid);
      if (hoverRequest.current !== requestId || activeRepositoryPath.current !== repositoryPath) {
        return;
      }
      hoverDetailsCache.current.set(cacheKey, nextDetails);
      setHoverDetails(nextDetails);
    } catch (cause) {
      if (hoverRequest.current === requestId) setHoverDetailsError(errorMessage(cause));
    } finally {
      if (hoverRequest.current === requestId) setLoadingHoverDetails(false);
    }
  }

  function scheduleCommitHover(target: HTMLButtonElement, commit: CommitSummary) {
    cancelCommitHoverTimer();
    cancelCommitHoverCloseTimer();
    ++hoverRequest.current;
    setHoverCard(null);
    setHoverDetails(null);
    setHoverDetailsError(null);
    setLoadingHoverDetails(false);

    const rect = target.getBoundingClientRect();
    const cardWidth = 420;
    const cardHeight = 180;
    const gap = 10;
    const viewportPadding = 8;
    const rightX = rect.right + gap;
    const x =
      rightX + cardWidth <= window.innerWidth - viewportPadding
        ? rightX
        : Math.max(viewportPadding, rect.left - cardWidth - gap);
    const y = Math.max(
      viewportPadding,
      Math.min(rect.top - 4, window.innerHeight - cardHeight - viewportPadding),
    );

    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      setHoverCard({ anchorTop: rect.top, commit, x, y });
      void loadHoverDetails(commit);
    }, 320);
  }

  useLayoutEffect(() => {
    if (!hoverCard || !hoverCardRef.current) return;
    const viewportPadding = 8;
    const cardHeight = hoverCardRef.current.getBoundingClientRect().height;
    const nextY = Math.max(
      viewportPadding,
      Math.min(hoverCard.anchorTop - 4, window.innerHeight - cardHeight - viewportPadding),
    );
    if (Math.abs(nextY - hoverCard.y) < 1) return;
    setHoverCard((current) =>
      current?.commit.oid === hoverCard.commit.oid ? { ...current, y: nextY } : current,
    );
  }, [hoverCard, hoverDetails, hoverDetailsError, loadingHoverDetails]);

  function activateCommit(oid: string) {
    closeCommitHover();
    onDiffFocus?.();
    setExpandedCommitOid(oid);
    if (selected?.repositoryPath === project.path && selected.oid === oid) return;
    setSelected({ repositoryPath: project.path, oid });
  }

  function toggleCommit(oid: string) {
    closeCommitHover();
    onDiffFocus?.();
    if (expandedCommitOid === oid) {
      setExpandedCommitOid(null);
      return;
    }
    setExpandedCommitOid(oid);
    if (selected?.repositoryPath === project.path && selected.oid === oid) return;
    setSelected({ repositoryPath: project.path, oid });
  }

  function openCommitContextMenu(event: ReactMouseEvent, commit: CommitSummary) {
    event.preventDefault();
    dialogReturnFocusRef.current = event.currentTarget as HTMLElement;
    closeCommitHover();
    activateCommit(commit.oid);
    const menuWidth = 286;
    const menuHeight = 390;
    setContextMenu({
      commit,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
    setActionError(null);
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
        return;
      }
      const items = Array.from(
        contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown")
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp")
        nextIndex =
          currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        items[nextIndex]?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", handleKeyDown);
    const frame = window.requestAnimationFrame(() => {
      contextMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  function updateHistoryRefsFromBranches(
    branches: Awaited<ReturnType<typeof desktopApi.repository.refs>>["branches"],
  ) {
    setHistoryRefs((current) => [
      ...branches.map((branch) => ({
        ahead: branch.ahead,
        behind: branch.behind,
        current: branch.current,
        fullName: branch.fullName,
        kind: branch.kind,
        name: branch.name,
        oid: branch.oid,
        upstream: branch.upstream,
        upstreamMissing: branch.upstreamMissing,
      })),
      ...current.filter((ref) => ref.kind === "tag"),
    ]);
  }

  async function reloadCurrentHead(repositoryPath = project.path) {
    const emptyFilters = { ...EMPTY_HISTORY_FILTERS };
    setDraftFilters(emptyFilters);
    setActiveFilters(emptyFilters);
    setSelectedRefFullName(null);
    await loadHistory(repositoryPath, emptyFilters, "replace", 0, null);
  }

  async function runCommitContextAction(
    action:
      | "copyHash"
      | "copyMessage"
      | "amend"
      | "revert"
      | "cherryPick"
      | "createBranch"
      | "reset",
    commit: CommitSummary,
    resetMode?: ResetCommitMode,
  ) {
    setContextMenu(null);
    setActionError(null);
    setActionNotice(null);
    if (action === "createBranch") {
      setBranchName(`branch/${shortCommitOid(commit.oid)}`);
      setActionDialog({ kind: "branch", commit });
      return;
    }

    setActionBusy(true);
    try {
      if (action === "copyHash") {
        await copyText(commit.oid);
        setActionNotice(`已复制提交 ${shortCommitOid(commit.oid)} 的完整 hash。`);
        return;
      }
      if (action === "copyMessage") {
        const commitDetails =
          details?.commit.oid === commit.oid
            ? details
            : await desktopApi.repository.commit(project.path, commit.oid);
        const message = [commit.subject, commitDetails.body.trim()].filter(Boolean).join("\n\n");
        await copyText(message);
        setActionNotice(`已复制提交 ${shortCommitOid(commit.oid)} 的提交信息。`);
        return;
      }
      if (action === "amend") {
        const preview = await desktopApi.repository.previewAmendCommit(project.path);
        if (preview.headOid !== commit.oid) {
          throw new Error("只能修改当前分支的 HEAD 提交。");
        }
        if (!preview.canAmend) {
          const refs = preview.blockingRefs.join("、");
          throw new Error(
            `当前 HEAD 已被远端引用或标签引用，不能安全修改${refs ? `：${refs}` : ""}`,
          );
        }
        setAmendSubject(preview.currentSubject);
        setAmendBody(preview.currentBody);
        setActionDialog({ kind: "amend", commit, preview });
        return;
      }
      if (action === "revert") {
        const preview = await desktopApi.repository.previewRevert(project.path, commit.oid);
        setActionDialog({ kind: "revert", commit, preview });
        return;
      }
      if (action === "cherryPick") {
        const preview = await desktopApi.repository.previewCherryPick(project.path, commit.oid);
        setActionDialog({ kind: "cherryPick", commit, preview });
        return;
      }
      if (action === "reset" && resetMode) {
        const preview = await desktopApi.repository.previewResetCommit(
          project.path,
          commit.oid,
          resetMode,
        );
        setHardResetAcknowledged(false);
        setActionDialog({ kind: "reset", commit, preview });
      }
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmCommitAction(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const dialog = actionDialog;
    if (!dialog || actionBusy) return;
    const repositoryPath = project.path;
    const isCurrentRepository = () =>
      isCurrentRepositoryPath(activeRepositoryPath.current, repositoryPath);
    if (dialog.kind === "reset" && dialog.preview.mode === "hard" && !hardResetAcknowledged) {
      return;
    }
    setActionBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      if (dialog.kind === "branch") {
        const name = branchName.trim();
        if (!name) return;
        const result = await desktopApi.repository.createBranchAtCommit(repositoryPath, {
          name,
          targetOid: dialog.commit.oid,
        });
        updateHistoryRefsFromBranches(result.refs.branches);
        setActionNotice(
          `已从 ${shortCommitOid(dialog.commit.oid)} 创建本地分支 ${name}，当前分支未切换。`,
        );
      } else if (dialog.kind === "amend") {
        const subject = amendSubject.trim();
        if (!subject) return;
        const result = await desktopApi.repository.amendCommit(repositoryPath, {
          subject,
          body: amendBody.trim(),
          expectedToken: dialog.preview.token,
        });
        if (!isCurrentRepository()) return;
        onStatusChange?.(result.status);
        const refs = await desktopApi.repository.refs(repositoryPath);
        if (!isCurrentRepository()) return;
        updateHistoryRefsFromBranches(refs.branches);
        await reloadCurrentHead(repositoryPath);
        if (!isCurrentRepository()) return;
        setActionNotice(`已修改 HEAD 提交 ${shortCommitOid(dialog.preview.headOid)} 的提交信息。`);
      } else if (dialog.kind === "revert") {
        const result = await desktopApi.repository.revertCommit(repositoryPath, {
          targetOid: dialog.preview.targetOid,
          expectedToken: dialog.preview.token,
        });
        if (!isCurrentRepository()) return;
        onStatusChange?.(result.status);
        updateHistoryRefsFromBranches(result.refs.branches);
        await reloadCurrentHead(repositoryPath);
        if (!isCurrentRepository()) return;
        setActionNotice(
          `已在 ${dialog.preview.currentBranch} 创建 Revert 提交；原提交仍保留在历史中。`,
        );
      } else if (dialog.kind === "cherryPick") {
        const result = await desktopApi.repository.cherryPickCommit(repositoryPath, {
          targetOid: dialog.preview.targetOid,
          expectedToken: dialog.preview.token,
        });
        if (!isCurrentRepository()) return;
        onStatusChange?.(result.status);
        updateHistoryRefsFromBranches(result.refs.branches);
        await reloadCurrentHead(repositoryPath);
        if (!isCurrentRepository()) return;
        setActionNotice(
          `已将 ${shortCommitOid(dialog.preview.targetOid)} Cherry-pick 到 ${dialog.preview.currentBranch}。`,
        );
      } else {
        const result = await desktopApi.repository.resetCommit(repositoryPath, {
          selectedOid: dialog.preview.selectedOid,
          mode: dialog.preview.mode,
          expectedToken: dialog.preview.token,
        });
        if (!isCurrentRepository()) return;
        onStatusChange?.(result.status);
        updateHistoryRefsFromBranches(result.refs.branches);
        await reloadCurrentHead(repositoryPath);
        if (!isCurrentRepository()) return;
        setActionNotice(
          `已将 ${dialog.preview.currentBranch} 重置到 ${shortCommitOid(dialog.preview.targetOid)}（${resetModeLabel(dialog.preview.mode)}）。`,
        );
      }
      setActionDialog(null);
    } catch (cause) {
      if (isCurrentRepository()) {
        setActionError(errorMessage(cause));
        if (dialog.kind !== "branch") setActionDialog(null);
      }
    } finally {
      if (isCurrentRepository()) setActionBusy(false);
    }
  }

  const loadingHistory = historyLoadMode !== null;
  const loadingInitialHistory = historyLoadMode === "replace";
  const filtered = hasActiveFilters(activeFilters);
  const selectedHistoryRef = selectedRefFullName
    ? historyRefs.find((ref) => ref.fullName === selectedRefFullName)
    : undefined;
  const graphRows = useMemo(
    () =>
      buildCommitGraphRows(commits, !filtered, {
        currentOid: currentLocalBranch?.oid ?? null,
        selectedOid: selectedHistoryRef?.oid ?? null,
        upstreamOid: currentUpstreamBranch?.oid ?? null,
      }),
    [
      commits,
      currentLocalBranch?.oid,
      currentUpstreamBranch?.oid,
      filtered,
      selectedHistoryRef?.oid,
    ],
  );
  const refsByOid = useMemo(() => {
    const grouped = new Map<string, HistoryRefOption[]>();
    for (const ref of historyRefs) {
      const current = grouped.get(ref.oid) ?? [];
      current.push(ref);
      grouped.set(ref.oid, current);
    }
    return grouped;
  }, [historyRefs]);
  const currentHeadOid = currentLocalBranch?.oid ?? null;
  const historyScopeLabel = selectedRefFullName
    ? (historyRefs.find((ref) => ref.fullName === selectedRefFullName)?.name ?? "自定义范围")
    : "自动";
  const visibleHistoryRefs = useMemo(() => {
    const needle = refsQuery.trim().toLocaleLowerCase();
    if (!needle) return historyRefs;
    return historyRefs.filter((ref) =>
      `${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(needle),
    );
  }, [historyRefs, refsQuery]);
  const localMergeBranches = useMemo(
    () => historyRefs.filter((ref) => ref.kind === "local" && !ref.current),
    [historyRefs],
  );
  const visibleLocalMergeBranches = useMemo(() => {
    const needle = mergeDialog?.query.trim().toLocaleLowerCase() ?? "";
    if (!needle) return localMergeBranches;
    return localMergeBranches.filter((branch) =>
      `${branch.name} ${branch.fullName}`.toLocaleLowerCase().includes(needle),
    );
  }, [localMergeBranches, mergeDialog?.query]);
  const contextCommitIsHead = contextMenu?.commit.oid === currentHeadOid;
  const contextResetUnavailable = Boolean(
    contextMenu && contextCommitIsHead && contextMenu.commit.parentOids.length === 0,
  );
  const selectedFile = useMemo(
    () => details?.files.find((file) => file.path === selectedFilePath) ?? null,
    [details, selectedFilePath],
  );
  const selectedFileName = selectedFile?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const selectedFileAbsolutePath = selectedFile
    ? `${project.path.replace(/[\\/]$/, "")}/${selectedFile.path}`
    : "";
  const selectedFilePatch = useMemo(() => {
    if (!details || !selectedFile) return "";
    const filePatch = patchForFile(details.patch, selectedFile.path, selectedFile.originalPath);
    return filePatch || (details.files.length === 1 ? details.patch : "");
  }, [details, selectedFile]);
  const selectedFileDiff = useMemo(() => parseUnifiedDiff(selectedFilePatch), [selectedFilePatch]);
  const selectedFileHasTextDiff = useMemo(
    () =>
      selectedFileDiff.lines.some((line) =>
        ["context", "addition", "deletion"].includes(line.kind),
      ),
    [selectedFileDiff],
  );

  useEffect(() => {
    if (selectedFileHasTextDiff) {
      ++imageDiffRequest.current;
      setImageDiff(null);
      setImageDiffError(null);
      setLoadingImageDiff(false);
      return;
    }
    if (!selected || !selectedFile) {
      ++imageDiffRequest.current;
      setImageDiff(null);
      setImageDiffError(null);
      setLoadingImageDiff(false);
      return;
    }

    const requestId = ++imageDiffRequest.current;
    setLoadingImageDiff(true);
    setImageDiff(null);
    setImageDiffError(null);
    void desktopApi.repository
      .commitImageDiff(project.path, selected.oid, selectedFile.path, selectedFile.originalPath)
      .then((nextImageDiff) => {
        if (imageDiffRequest.current === requestId) setImageDiff(nextImageDiff);
      })
      .catch((cause) => {
        if (imageDiffRequest.current === requestId) setImageDiffError(errorMessage(cause));
      })
      .finally(() => {
        if (imageDiffRequest.current === requestId) setLoadingImageDiff(false);
      });
  }, [project.path, selected, selectedFile, selectedFileHasTextDiff]);

  function renderCommitFile(file: CommitDetails["files"][number], label = file.path, depth = 0) {
    const absoluteFilePath = absoluteRepositoryPath(project.path, file.path);
    const absoluteOriginalPath = file.originalPath
      ? absoluteRepositoryPath(project.path, file.originalPath)
      : null;
    return (
      <button
        className={`commit-inline-file${selectedFilePath === file.path ? " selected" : ""}`}
        type="button"
        key={`${file.status}:${file.originalPath ?? ""}:${file.path}`}
        title={
          absoluteOriginalPath ? `${absoluteOriginalPath} → ${absoluteFilePath}` : absoluteFilePath
        }
        style={fileViewMode === "tree" ? { paddingLeft: 7 + depth * 14 } : undefined}
        onClick={() => {
          onDiffFocus?.();
          setSelectedFilePath(file.path);
        }}
      >
        <span className={`commit-file-status status-${file.status.charAt(0)}`}>
          {commitFileStatusLabel(file.status)}
        </span>
        <span className="commit-inline-file-path">{label}</span>
      </button>
    );
  }

  function toggleHistoryPanel() {
    const nextCollapsed = !collapsed;
    if (nextCollapsed) {
      setFiltersOpen(false);
      setRefsMenuOpen(false);
      setMoreMenuOpen(false);
    }
    onCollapsedChange?.(nextCollapsed);
  }

  return (
    <div className={`history-layout${embedded ? " embedded" : ""}`}>
      <section
        className={`commit-list-panel${collapsed ? " collapsed" : ""}`}
        aria-label="提交历史"
      >
        <header>
          <div className="workbench-panel-title">
            <h3>
              <button
                className="workbench-panel-disclosure"
                type="button"
                aria-expanded={!collapsed}
                aria-label={collapsed ? "展开提交历史" : "收起提交历史"}
                onClick={toggleHistoryPanel}
              >
                {collapsed ? (
                  <CaretRight size={14} weight="bold" aria-hidden="true" />
                ) : (
                  <CaretDown size={14} weight="bold" aria-hidden="true" />
                )}
                <span>图表</span>
              </button>
            </h3>
            <span>{commits.length}</span>
          </div>
          <div
            className="history-panel-toolbar"
            aria-label="图表操作"
            aria-busy={operationInProgress}
          >
            <button
              className={`history-ref-picker-trigger${refsMenuOpen ? " active" : ""}`}
              type="button"
              disabled={loadingHistory}
              aria-haspopup="dialog"
              aria-expanded={refsMenuOpen}
              onClick={() => {
                setMoreMenuOpen(false);
                setRefsQuery("");
                setRefsMenuOpen(true);
              }}
              aria-label={`选择图表引用：${historyScopeLabel}`}
              title="选择分支或标签"
            >
              <GitBranch size={14} aria-hidden="true" />
              <span>{historyScopeLabel}</span>
              <CaretDown size={10} weight="bold" aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={remoteOperationBusy || !fetchRemoteName}
              onClick={() => void runRemoteOperation("fetch")}
              aria-label="抓取远程更新"
              title={fetchRemoteName ? `抓取远端 ${fetchRemoteName} 的更新` : "当前仓库没有远端"}
            >
              <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={
                remoteOperationBusy ||
                !currentLocalBranch?.upstream ||
                currentLocalBranch.upstreamMissing
              }
              onClick={() => void runRemoteOperation("pull")}
              aria-label="拉取当前分支"
              title="拉取当前分支"
            >
              <CloudArrowDown size={14} weight="bold" aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              disabled={
                remoteOperationBusy ||
                !currentLocalBranch?.upstream ||
                currentLocalBranch.upstreamMissing
              }
              onClick={() => void runRemoteOperation("push")}
              aria-label="推送当前分支"
              title="推送当前分支"
            >
              <CloudArrowUp size={14} weight="bold" aria-hidden="true" />
            </button>
            <button
              className={`icon-button history-search-button${activeFilters.search || (filtersOpen && searchOnly) ? " active" : ""}`}
              type="button"
              aria-expanded={filtersOpen && searchOnly}
              onClick={() => {
                if (filtersOpen && searchOnly) setFiltersOpen(false);
                else showFilters(true);
              }}
              aria-label="搜索提交"
              title="搜索提交"
            >
              <MagnifyingGlass size={14} weight="bold" aria-hidden="true" />
            </button>
            <div className="history-more" ref={moreMenuRef}>
              <button
                ref={moreMenuButtonRef}
                className={`icon-button${moreMenuOpen ? " active" : ""}`}
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                onClick={toggleMoreMenu}
                aria-label="更多图表操作"
                title="更多图表操作"
              >
                <DotsThree size={16} weight="bold" aria-hidden="true" />
              </button>
            </div>
            {moreMenuOpen && moreMenuPosition
              ? createPortal(
                  <div
                    ref={moreMenuPopoverRef}
                    className="history-more-popover history-more-popover-portal"
                    role="menu"
                    aria-label="更多图表操作"
                    style={moreMenuPosition}
                  >
                    <button
                      className="history-more-operation"
                      type="button"
                      role="menuitem"
                      disabled={remoteOperationBusy || !fetchRemoteName}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        void runRemoteOperation("fetch");
                      }}
                    >
                      <ArrowClockwise size={14} aria-hidden="true" />
                      <span>抓取远程更新</span>
                    </button>
                    <button
                      className="history-more-operation"
                      type="button"
                      role="menuitem"
                      disabled={
                        remoteOperationBusy ||
                        !currentLocalBranch?.upstream ||
                        currentLocalBranch.upstreamMissing
                      }
                      onClick={() => {
                        setMoreMenuOpen(false);
                        void runRemoteOperation("pull");
                      }}
                    >
                      <CloudArrowDown size={14} aria-hidden="true" />
                      <span>拉取当前分支</span>
                    </button>
                    <button
                      className="history-more-operation"
                      type="button"
                      role="menuitem"
                      disabled={
                        remoteOperationBusy ||
                        !currentLocalBranch?.upstream ||
                        currentLocalBranch.upstreamMissing
                      }
                      onClick={() => {
                        setMoreMenuOpen(false);
                        void runRemoteOperation("push");
                      }}
                    >
                      <CloudArrowUp size={14} aria-hidden="true" />
                      <span>推送当前分支</span>
                    </button>
                    <button
                      className="history-more-operation"
                      type="button"
                      role="menuitem"
                      disabled={actionBusy || localMergeBranches.length === 0}
                      onClick={openMergeDialog}
                    >
                      <GitMerge size={14} aria-hidden="true" />
                      <span>合并分支</span>
                    </button>
                    <button
                      className="history-more-operation"
                      type="button"
                      role="menuitem"
                      disabled={actionBusy}
                      onClick={() => {
                        dialogReturnFocusRef.current = moreMenuButtonRef.current;
                        setMoreMenuOpen(false);
                        setActionError(null);
                        setActionNotice(null);
                        setNewBranchName("");
                        setNewBranchOpen(true);
                      }}
                    >
                      <Plus size={14} aria-hidden="true" />
                      <span>新建分支</span>
                    </button>
                    <div className="history-more-separator" role="separator" />
                    <button
                      className="history-more-view-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={fileViewMode === "list"}
                      onClick={() => {
                        setFileViewMode("list");
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span className="history-more-check" aria-hidden="true">
                        {fileViewMode === "list" ? <Check size={14} /> : null}
                      </span>
                      <span>以列表形式查看</span>
                    </button>
                    <button
                      className="history-more-view-option"
                      type="button"
                      role="menuitemradio"
                      aria-checked={fileViewMode === "tree"}
                      onClick={() => {
                        setFileViewMode("tree");
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span className="history-more-check" aria-hidden="true">
                        {fileViewMode === "tree" ? <Check size={14} /> : null}
                      </span>
                      <span>以树形式查看</span>
                    </button>
                  </div>,
                  document.body,
                )
              : null}
          </div>
        </header>

        {refsMenuOpen ? (
          <Dialog
            open
            className="history-ref-picker"
            backdropClassName="history-ref-picker-backdrop"
            ariaLabelledBy="history-ref-picker-title"
            closeOnBackdrop
            onClose={() => setRefsMenuOpen(false)}
          >
            <header>
              <div>
                <GitBranch size={16} aria-hidden="true" />
                <strong id="history-ref-picker-title">选择图表引用</strong>
                <small>已选 1 项</small>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setRefsMenuOpen(false)}
                aria-label="关闭引用选择"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </header>

            <label className="history-ref-picker-search search-field-control">
              <MagnifyingGlass size={14} aria-hidden="true" />
              <input
                autoFocus
                type="search"
                value={refsQuery}
                onChange={(event) => setRefsQuery(event.target.value)}
                placeholder="搜索分支或标签"
                aria-label="搜索分支或标签"
              />
            </label>

            <div className="history-ref-picker-list">
              <button
                className={`history-ref-picker-item${selectedRefFullName === null ? " selected" : ""}`}
                type="button"
                aria-pressed={selectedRefFullName === null}
                onClick={() => {
                  changeHistoryRef("");
                  setRefsMenuOpen(false);
                }}
              >
                <span className="history-ref-picker-icon local">
                  <GitBranch size={14} aria-hidden="true" />
                </span>
                <strong>自动</strong>
                <small>跟随当前 HEAD</small>
                {selectedRefFullName === null ? <Check size={14} aria-hidden="true" /> : null}
              </button>

              {(["local", "remote", "tag"] as const).map((kind) => {
                const groupRefs = visibleHistoryRefs.filter((ref) => ref.kind === kind);
                if (groupRefs.length === 0) return null;
                return (
                  <section className="history-ref-picker-group" key={kind}>
                    <h4>{historyRefKindLabel(kind)}</h4>
                    {groupRefs.map((ref) => {
                      const selectedRef = selectedRefFullName === ref.fullName;
                      const RefIcon =
                        ref.kind === "remote" ? Cloud : ref.kind === "tag" ? Tag : GitBranch;
                      return (
                        <button
                          className={`history-ref-picker-item${selectedRef ? " selected" : ""}`}
                          type="button"
                          aria-pressed={selectedRef}
                          key={ref.fullName}
                          onClick={() => {
                            changeHistoryRef(ref.fullName);
                            setRefsMenuOpen(false);
                          }}
                        >
                          <span className={`history-ref-picker-icon ${ref.kind}`}>
                            <RefIcon size={14} aria-hidden="true" />
                          </span>
                          <span className="history-ref-picker-name">
                            <strong>{ref.name}</strong>
                            {ref.current ? (
                              <span className="history-current-branch-badge">当前</span>
                            ) : null}
                          </span>
                          <small>
                            {shortCommitOid(ref.oid)} 处的{historyRefKindLabel(ref.kind)}
                          </small>
                          {selectedRef ? <Check size={14} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </section>
                );
              })}

              {visibleHistoryRefs.length === 0 ? (
                <p className="history-ref-picker-empty">没有匹配的分支或标签。</p>
              ) : null}
            </div>
          </Dialog>
        ) : null}

        {filtersOpen ? (
          <div className={`history-filter-drawer open${searchOnly ? " search-only" : ""}`}>
            <form className="history-filter-form" onSubmit={applyFilters}>
              {historyRefsError ? (
                <p className="history-ref-warning" role="status">
                  无法读取可选分支和标签：{historyRefsError}。仍可查看当前 HEAD。
                </p>
              ) : null}
              <label className="history-search-field">
                <span>提交信息</span>
                <div className="search-field-control">
                  <MagnifyingGlass size={14} aria-hidden="true" />
                  <input
                    ref={filterSearchInputRef}
                    type="search"
                    maxLength={256}
                    value={draftFilters.search}
                    placeholder="按提交说明筛选"
                    onChange={(event) =>
                      setDraftFilters((current) => ({ ...current, search: event.target.value }))
                    }
                  />
                </div>
              </label>
              <label className="history-search-field">
                <span>作者</span>
                <div className="search-field-control">
                  <MagnifyingGlass size={14} aria-hidden="true" />
                  <input
                    type="search"
                    maxLength={256}
                    value={draftFilters.author}
                    placeholder="姓名或邮箱"
                    onChange={(event) =>
                      setDraftFilters((current) => ({ ...current, author: event.target.value }))
                    }
                  />
                </div>
              </label>
              <div className="history-date-fields">
                <label>
                  <span>开始日期</span>
                  <input
                    type="date"
                    value={draftFilters.after}
                    max={draftFilters.before || undefined}
                    onChange={(event) =>
                      setDraftFilters((current) => ({ ...current, after: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>结束日期</span>
                  <input
                    type="date"
                    value={draftFilters.before}
                    min={draftFilters.after || undefined}
                    onChange={(event) =>
                      setDraftFilters((current) => ({ ...current, before: event.target.value }))
                    }
                  />
                </label>
              </div>
              <label>
                <span>文件路径</span>
                <input
                  type="text"
                  value={draftFilters.filePath}
                  placeholder="例如 src/app/App.tsx"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraftFilters((current) => ({ ...current, filePath: event.target.value }))
                  }
                />
              </label>
              <div className="history-filter-actions">
                <button
                  className="primary-button compact-button"
                  type="submit"
                  disabled={loadingHistory}
                >
                  筛选
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                >
                  收起
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={loadingHistory || (!filtered && !hasActiveFilters(draftFilters))}
                  onClick={clearFilters}
                >
                  清除筛选
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {historyError ? <p className="panel-message error-message">{historyError}</p> : null}
        {actionNotice ? (
          <p className="history-action-message operation-notice" aria-live="polite">
            {actionNotice}
          </p>
        ) : null}
        {actionError ? (
          <p className="history-action-message error-message" role="alert">
            {actionError}
          </p>
        ) : null}
        {!historyError && !loadingInitialHistory && commits.length === 0 ? (
          <p className="panel-message">
            {filtered ? "没有符合当前筛选条件的提交。" : "仓库还没有提交。"}
          </p>
        ) : null}

        <div className="commit-list" onScroll={closeCommitHover}>
          {filtered && commits.length > 0 ? (
            <p className="history-graph-note">
              已启用筛选；图仅显示节点，不表示被筛选提交之间的完整拓扑。
            </p>
          ) : null}
          {commits.map((commit, index) => {
            const selectedCommit = selected?.oid === commit.oid;
            const expanded = expandedCommitOid === commit.oid;
            const commitRefs = refsByOid.get(commit.oid) ?? [];
            const showFiles = expanded && details?.commit.oid === commit.oid;
            const graphGutter = commitGraphGutter(graphRows[index]);
            return (
              <div
                className={`commit-entry${expanded ? " expanded" : ""}`}
                key={commit.oid}
                style={{ "--commit-graph-gutter": `${graphGutter}px` } as CSSProperties}
              >
                <button
                  className={`commit-row${selectedCommit ? " selected" : ""}`}
                  type="button"
                  aria-expanded={expanded}
                  aria-describedby={
                    hoverCard?.commit.oid === commit.oid ? "commit-hover-card" : undefined
                  }
                  onClick={() => toggleCommit(commit.oid)}
                  onMouseEnter={(event) => scheduleCommitHover(event.currentTarget, commit)}
                  onMouseLeave={scheduleCommitHoverClose}
                  onFocus={(event) => scheduleCommitHover(event.currentTarget, commit)}
                  onBlur={closeCommitHover}
                  onContextMenu={(event) => openCommitContextMenu(event, commit)}
                >
                  <CommitGraphCell commit={commit} first={index === 0} layout={graphRows[index]} />
                  <div className="commit-row-copy">
                    <strong title={commit.subject || "无标题提交"}>
                      {commit.subject || "无标题提交"}
                    </strong>
                    {commitRefs.length ? (
                      <span className="history-ref-chips">
                        {commitRefs.slice(0, 2).map((ref) => (
                          <span
                            className={`history-ref-chip ${ref.kind}${ref.current ? " current" : ""}`}
                            key={ref.fullName}
                            title={ref.fullName}
                          >
                            <span className="history-ref-chip-label">{ref.name}</span>
                          </span>
                        ))}
                        {commitRefs.length > 2 ? (
                          <span className="history-ref-chip more">
                            <span className="history-ref-chip-label">+{commitRefs.length - 2}</span>
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className="commit-row-author"
                    title={`${commit.authorName} <${commit.authorEmail}> · ${formatCommitDate(commit.authoredAt)}`}
                  >
                    {commit.authorName}
                  </span>
                  <code title={commit.oid}>{shortCommitOid(commit.oid)}</code>
                </button>

                {expanded ? (
                  <div className="commit-inline-files" aria-label="此提交涉及的文件">
                    <CommitGraphContinuation layout={graphRows[index]} />
                    {loadingDetails ? (
                      <p className="commit-inline-message">正在读取文件变更…</p>
                    ) : null}
                    {detailsError ? (
                      <p className="commit-inline-message error-message">{detailsError}</p>
                    ) : null}
                    {showFiles && details.files.length === 0 ? (
                      <p className="commit-inline-message">此提交没有文件变更。</p>
                    ) : null}
                    {showFiles
                      ? fileViewMode === "tree"
                        ? buildCommitFileTreeEntries(details.files).map((entry) =>
                            entry.kind === "directory" ? (
                              <div
                                className="commit-inline-directory"
                                key={`directory:${entry.path}`}
                                style={{ paddingLeft: 7 + entry.depth * 14 }}
                              >
                                <CaretDown size={10} weight="bold" aria-hidden="true" />
                                <span>{entry.name}</span>
                              </div>
                            ) : (
                              renderCommitFile(
                                entry.file,
                                entry.file.path.split(/[\\/]/).filter(Boolean).at(-1) ??
                                  entry.file.path,
                                entry.depth,
                              )
                            ),
                          )
                        : details.files.map((file) => renderCommitFile(file))
                      : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {historyLimitReached ? (
            <p className="history-limit-note">
              已达到提交历史显示上限（{HISTORY_SOFT_LIMIT.toLocaleString("zh-CN")}{" "}
              条），请缩小筛选范围后重新查看。
            </p>
          ) : null}
          {hasMore && !historyLimitReached ? (
            <div className="history-load-more">
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={loadingHistory}
                onClick={() =>
                  void loadHistory(
                    project.path,
                    activeFilters,
                    "append",
                    nextOffset,
                    selectedRefFullName,
                  )
                }
              >
                {historyLoadMode === "append" ? "继续读取中…" : "继续加载"}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section
        className={`commit-details-panel history-diff-panel${
          diffPanelVisible ? " workbench-diff-visible" : ""
        }`}
        aria-label="提交文件差异"
        aria-hidden={embedded && !diffPanelVisible ? true : undefined}
      >
        {loadingDetails ? <p className="panel-message">正在读取提交详情…</p> : null}
        {detailsError ? <p className="panel-message error-message">{detailsError}</p> : null}
        {!selected && !loadingInitialHistory ? (
          <p className="panel-message">选择一条提交，再从展开的文件列表中查看 Diff。</p>
        ) : null}

        {details ? (
          <>
            <header className="history-diff-header editor-file-tab-row">
              <div className="editor-file-tab">
                <FileText size={14} aria-hidden="true" />
                <strong
                  title={
                    selectedFile
                      ? absoluteRepositoryPath(project.path, selectedFile.path)
                      : undefined
                  }
                >
                  {selectedFileName ?? "选择文件"}
                </strong>
                {selectedFile ? <small>{commitFileStatusLabel(selectedFile.status)}</small> : null}
              </div>
              <div className="editor-file-actions">
                <code title={details.commit.oid}>{shortCommitOid(details.commit.oid)}</code>
                <button
                  className="icon-button"
                  type="button"
                  disabled={!selectedFile}
                  onClick={() => {
                    void copyText(selectedFileAbsolutePath).catch((cause) =>
                      setDetailsError(errorMessage(cause)),
                    );
                  }}
                  aria-label="复制文件绝对路径"
                  title="复制文件绝对路径"
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  disabled={!selectedFile}
                  onClick={() => setSelectedFilePath(null)}
                  aria-label="关闭文件 Diff"
                  title="关闭文件 Diff"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            </header>

            <div className="editor-file-breadcrumb">
              <span>提交</span>
              <span
                title={
                  selectedFile ? absoluteRepositoryPath(project.path, selectedFile.path) : undefined
                }
              >
                {selectedFile?.path ?? "选择文件查看差异"}
              </span>
              {selectedFile?.originalPath ? (
                <span title={absoluteRepositoryPath(project.path, selectedFile.originalPath)}>
                  来自 {selectedFile.originalPath}
                </span>
              ) : null}
            </div>

            <div className="history-commit-summary">
              <div>
                <strong>{details.commit.subject || "无标题提交"}</strong>
                <span>
                  {details.commit.authorName} · {formatCommitDate(details.commit.authoredAt)} ·{" "}
                  {details.files.length} 个文件
                </span>
              </div>
              <span className="history-context-hint">右键提交可执行 Git 操作</span>
            </div>

            {details.body.trim() ? (
              <details className="commit-body-disclosure">
                <summary>提交正文</summary>
                <p className="commit-body">{details.body.trim()}</p>
              </details>
            ) : null}

            <div className="patch-panel history-file-patch">
              <header>
                <div className="history-file-patch-heading">
                  <h4>{selectedFile ? commitFileStatusLabel(selectedFile.status) : "Diff"}</h4>
                  {selectedFilePatch ? (
                    <span className="diff-stats" aria-label="差异统计">
                      <strong className="added">+{selectedFileDiff.additions}</strong>
                      <strong className="deleted">−{selectedFileDiff.deletions}</strong>
                    </span>
                  ) : null}
                </div>
                <div className="history-file-patch-tools">
                  {details.patchTruncated ? (
                    <span className="diff-truncated-note">内容超过 2 MiB，已截断</span>
                  ) : null}
                  {imageDiffError ? (
                    <span className="diff-truncated-note">{imageDiffError}</span>
                  ) : null}
                </div>
              </header>
              {!selectedFile ? (
                <p className="panel-message">
                  {details.files.length === 0
                    ? "此提交没有文件变更。"
                    : "从左侧展开列表中选择一个文件。"}
                </p>
              ) : imageDiff ? (
                <ImageDiffView diff={imageDiff} />
              ) : !selectedFileHasTextDiff && loadingImageDiff ? (
                <p className="panel-message">正在检查图片差异…</p>
              ) : selectedFilePatch ? (
                <UnifiedDiffView diff={selectedFileDiff} />
              ) : (
                <p className="panel-message">
                  该文件没有可显示的文本差异，可能是二进制文件或 Patch 已截断。
                </p>
              )}
            </div>
          </>
        ) : null}
      </section>

      {hoverCard
        ? createPortal(
            <aside
              ref={hoverCardRef}
              id="commit-hover-card"
              className="commit-hover-card"
              role="tooltip"
              style={{ left: hoverCard.x, top: hoverCard.y }}
              onMouseEnter={cancelCommitHoverCloseTimer}
              onMouseLeave={scheduleCommitHoverClose}
            >
              <header>
                <strong title={`${hoverCard.commit.authorName} <${hoverCard.commit.authorEmail}>`}>
                  {hoverCard.commit.authorName}
                </strong>
                <time dateTime={hoverCard.commit.authoredAt}>
                  {formatCommitDate(hoverCard.commit.authoredAt)}
                </time>
              </header>
              <h4>{hoverCard.commit.subject || "无标题提交"}</h4>
              {loadingHoverDetails ? (
                <p className="commit-hover-status">正在读取提交信息…</p>
              ) : hoverDetailsError ? (
                <p className="commit-hover-status error-message">{hoverDetailsError}</p>
              ) : hoverDetails?.body.trim() ? (
                <p className="commit-hover-body">{hoverDetails.body.trim()}</p>
              ) : (
                <p className="commit-hover-empty">此提交没有正文。</p>
              )}
              <footer>
                <code title={hoverCard.commit.oid}>{hoverCard.commit.oid}</code>
                <span>{hoverDetails ? `${hoverDetails.files.length} 个文件` : "提交元数据"}</span>
              </footer>
            </aside>,
            document.body,
          )
        : null}

      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="commit-context-menu"
              role="menu"
              aria-label={`${contextMenu.commit.subject || "无标题提交"} 的操作`}
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <header>
                <strong>{contextMenu.commit.subject || "无标题提交"}</strong>
                <code>{shortCommitOid(contextMenu.commit.oid)}</code>
              </header>
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy}
                onClick={() => void runCommitContextAction("copyHash", contextMenu.commit)}
              >
                <Copy aria-hidden="true" />
                <span>复制提交 hash</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy}
                onClick={() => void runCommitContextAction("copyMessage", contextMenu.commit)}
              >
                <TextT aria-hidden="true" />
                <span>复制提交信息</span>
              </button>
              <div className="commit-context-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy || !contextCommitIsHead}
                title={contextCommitIsHead ? undefined : "只能修改当前分支的 HEAD 提交"}
                onClick={() => void runCommitContextAction("amend", contextMenu.commit)}
              >
                <PencilSimple aria-hidden="true" />
                <span>修改此提交信息</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy || contextMenu.commit.parentOids.length !== 1}
                title={contextMenu.commit.parentOids.length === 1 ? undefined : "仅支持单父提交"}
                onClick={() => void runCommitContextAction("revert", contextMenu.commit)}
              >
                <ArrowCounterClockwise aria-hidden="true" />
                <span>还原此提交</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy || contextMenu.commit.parentOids.length !== 1}
                title={contextMenu.commit.parentOids.length === 1 ? undefined : "仅支持单父提交"}
                onClick={() => void runCommitContextAction("cherryPick", contextMenu.commit)}
              >
                <GitCommit aria-hidden="true" />
                <span>Cherry-pick 此提交</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy}
                onClick={() => void runCommitContextAction("createBranch", contextMenu.commit)}
              >
                <GitBranch aria-hidden="true" />
                <span>从此提交创建分支</span>
              </button>
              <div className="commit-context-separator" role="separator" />
              {(["soft", "mixed", "hard"] as const).map((mode) => (
                <button
                  className={mode === "hard" ? "danger" : undefined}
                  type="button"
                  role="menuitem"
                  key={mode}
                  disabled={actionBusy || contextResetUnavailable}
                  title={contextResetUnavailable ? "根提交没有父提交，无法撤销" : undefined}
                  onClick={() => void runCommitContextAction("reset", contextMenu.commit, mode)}
                >
                  {mode === "hard" ? (
                    <Warning aria-hidden="true" />
                  ) : (
                    <ArrowUUpLeft aria-hidden="true" />
                  )}
                  <span>
                    {contextCommitIsHead ? "撤销此提交" : "重置到此提交"}，
                    {mode === "soft" ? "保留更改" : mode === "mixed" ? "取消暂存" : "丢弃更改"}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {newBranchOpen ? (
        <Dialog
          open
          as="form"
          className="confirmation-dialog commit-action-dialog"
          ariaLabelledBy="history-new-branch-title"
          busy={actionBusy}
          returnFocusElement={dialogReturnFocusRef.current}
          fallbackFocusElement={moreMenuButtonRef.current}
          closeOnBackdrop
          onSubmit={(event) => void createBranchFromToolbar(event)}
          onClose={() => setNewBranchOpen(false)}
        >
          <p className="eyebrow">CREATE LOCAL BRANCH</p>
          <h2 id="history-new-branch-title">新建分支</h2>
          <p>从当前 HEAD 创建本地分支并立即切换。工作区内容会保持不变。</p>
          <label className="commit-action-field">
            <span>分支名称</span>
            <input
              autoFocus
              type="text"
              maxLength={255}
              value={newBranchName}
              autoComplete="off"
              spellCheck={false}
              disabled={actionBusy}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
          </label>
          {actionError ? (
            <p className="history-dialog-error error-message" role="alert">
              {actionError}
            </p>
          ) : null}
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={actionBusy}
              onClick={() => setNewBranchOpen(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={actionBusy || !newBranchName.trim()}
            >
              {actionBusy ? "创建中…" : "创建并切换"}
            </button>
          </div>
        </Dialog>
      ) : null}

      {mergeDialog ? (
        <Dialog
          open
          className="confirmation-dialog history-merge-dialog"
          ariaLabelledBy="history-merge-dialog-title"
          busy={actionBusy}
          returnFocusElement={dialogReturnFocusRef.current}
          fallbackFocusElement={moreMenuButtonRef.current}
          closeOnBackdrop
          onClose={() => setMergeDialog(null)}
        >
          <p className="eyebrow">LOCAL MERGE</p>
          <h2 id="history-merge-dialog-title">
            {mergeDialog.preview ? "合并到当前分支？" : "选择要合并的分支"}
          </h2>
          {mergeDialog.preview ? (
            <>
              <p>将来源分支的提交合并到当前分支。执行前会再次校验分支状态和工作区。</p>
              <dl className="merge-preview-grid">
                <div>
                  <dt>当前分支</dt>
                  <dd>{mergeDialog.preview.currentBranch}</dd>
                </div>
                <div>
                  <dt>来源分支</dt>
                  <dd>{mergeDialog.preview.targetBranch}</dd>
                </div>
                <div>
                  <dt>当前独有</dt>
                  <dd>{mergeDialog.preview.ahead} 个提交</dd>
                </div>
                <div>
                  <dt>来源独有</dt>
                  <dd>{mergeDialog.preview.behind} 个提交</dd>
                </div>
              </dl>
              {mergeDialog.preview.mode === "fast_forward" ? (
                <fieldset className="merge-strategy-options">
                  <legend>合并方式</legend>
                  <label>
                    <input
                      type="radio"
                      name="history-local-merge-strategy"
                      value="fast_forward_only"
                      checked={mergeDialog.strategy === "fast_forward_only"}
                      disabled={actionBusy}
                      onChange={() =>
                        setMergeDialog((current) =>
                          current ? { ...current, strategy: "fast_forward_only" } : current,
                        )
                      }
                    />
                    <span>
                      <strong>仅快进</strong>
                      <small>不创建额外提交，当前分支直接前移。</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="history-local-merge-strategy"
                      value="create_merge_commit"
                      checked={mergeDialog.strategy === "create_merge_commit"}
                      disabled={actionBusy}
                      onChange={() =>
                        setMergeDialog((current) =>
                          current ? { ...current, strategy: "create_merge_commit" } : current,
                        )
                      }
                    />
                    <span>
                      <strong>创建合并提交</strong>
                      <small>即使可以快进，也保留明确的合并节点。</small>
                    </span>
                  </label>
                </fieldset>
              ) : (
                <p className="merge-strategy-note">当前分支已分叉，将创建一个合并提交。</p>
              )}
            </>
          ) : (
            <>
              <p>选择一个本地分支，将它的提交合并到当前分支。</p>
              <label className="history-merge-search search-field-control">
                <MagnifyingGlass size={14} aria-hidden="true" />
                <input
                  autoFocus
                  type="search"
                  value={mergeDialog.query}
                  placeholder="搜索本地分支"
                  disabled={actionBusy}
                  onChange={(event) =>
                    setMergeDialog((current) =>
                      current ? { ...current, query: event.target.value } : current,
                    )
                  }
                />
              </label>
              <div className="history-merge-branch-list">
                {visibleLocalMergeBranches.map((branch) => (
                  <button
                    type="button"
                    key={branch.fullName}
                    disabled={actionBusy}
                    onClick={() => void previewMergeBranch(branch.fullName)}
                  >
                    <GitBranch size={14} aria-hidden="true" />
                    <strong>{branch.name}</strong>
                    <code>{shortCommitOid(branch.oid)}</code>
                  </button>
                ))}
                {visibleLocalMergeBranches.length === 0 ? (
                  <p className="history-merge-empty">没有匹配的本地分支。</p>
                ) : null}
              </div>
            </>
          )}
          {actionError ? (
            <p className="history-dialog-error error-message" role="alert">
              {actionError}
            </p>
          ) : null}
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={actionBusy}
              onClick={() => setMergeDialog(null)}
            >
              取消
            </button>
            {mergeDialog.preview ? (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={actionBusy}
                  onClick={() =>
                    setMergeDialog((current) => (current ? { ...current, preview: null } : current))
                  }
                >
                  重新选择
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void confirmLocalMerge()}
                >
                  {actionBusy ? "合并中…" : "确认合并"}
                </button>
              </>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {actionDialog ? (
        <Dialog
          open
          as="form"
          className={`confirmation-dialog commit-action-dialog${
            actionDialog.kind === "amend" ? " amend-dialog" : ""
          }`}
          role={
            actionDialog.kind === "branch" || actionDialog.kind === "amend"
              ? "dialog"
              : "alertdialog"
          }
          ariaLabelledBy="commit-action-dialog-title"
          busy={actionBusy}
          returnFocusElement={dialogReturnFocusRef.current}
          fallbackFocusElement={moreMenuButtonRef.current}
          closeOnBackdrop
          onSubmit={(event) => void confirmCommitAction(event)}
          onClose={() => setActionDialog(null)}
        >
          <p className={`eyebrow${actionDialog.kind === "reset" ? " danger" : ""}`}>
            {actionDialog.kind === "branch"
              ? "CREATE LOCAL BRANCH"
              : actionDialog.kind === "amend"
                ? "REWRITE HEAD"
                : actionDialog.kind === "revert"
                  ? "CREATE REVERT COMMIT"
                  : actionDialog.kind === "cherryPick"
                    ? "CHERRY-PICK COMMIT"
                    : "RESET CURRENT BRANCH"}
          </p>
          <h2 id="commit-action-dialog-title">
            {actionDialog.kind === "branch"
              ? "从此提交创建分支"
              : actionDialog.kind === "amend"
                ? "修改 HEAD 提交信息"
                : actionDialog.kind === "revert"
                  ? "还原此提交？"
                  : actionDialog.kind === "cherryPick"
                    ? "Cherry-pick 此提交？"
                    : `${actionDialog.preview.selectedIsHead ? "撤销此提交" : "重置到此提交"}？`}
          </h2>
          <p>
            {actionDialog.kind === "branch"
              ? "创建新的本地分支引用，不切换当前分支，也不会改动工作区。"
              : actionDialog.kind === "amend"
                ? "这会重写当前 HEAD 的提交对象。暂存区中的内容也会包含在新提交中。"
                : actionDialog.kind === "revert"
                  ? `将在 ${actionDialog.preview.currentBranch} 上创建一个新的反向提交，已有历史不会被删除。`
                  : actionDialog.kind === "cherryPick"
                    ? `将在 ${actionDialog.preview.currentBranch} 上复制该提交的变更；发生冲突时应用会自动中止。`
                    : actionDialog.preview.mode === "hard"
                      ? "当前分支将移动到目标提交，目标之后的提交会从当前分支历史移除，暂存区和已跟踪文件会同步到目标版本。未跟踪文件不会删除。"
                      : `当前分支将移动到目标提交，并${resetModeLabel(actionDialog.preview.mode)}。目标之后的提交会从当前分支历史移除。`}
          </p>

          {actionDialog.kind === "branch" ? (
            <label className="commit-action-field">
              <span>分支名称</span>
              <input
                autoFocus
                type="text"
                maxLength={255}
                value={branchName}
                autoComplete="off"
                spellCheck={false}
                disabled={actionBusy}
                onChange={(event) => setBranchName(event.target.value)}
              />
            </label>
          ) : null}

          {actionDialog.kind === "amend" ? (
            <div className="commit-action-fields">
              <label className="commit-action-field">
                <span>提交标题</span>
                <input
                  autoFocus
                  type="text"
                  maxLength={4096}
                  value={amendSubject}
                  disabled={actionBusy}
                  onChange={(event) => setAmendSubject(event.target.value)}
                />
              </label>
              <label className="commit-action-field">
                <span>提交正文</span>
                <textarea
                  value={amendBody}
                  disabled={actionBusy}
                  onChange={(event) => setAmendBody(event.target.value)}
                />
              </label>
              <p className="commit-action-note">
                当前暂存区包含 {actionDialog.preview.stagedChangeCount} 项变更。
              </p>
            </div>
          ) : null}

          {actionDialog.kind !== "branch" && actionDialog.kind !== "amend" ? (
            <code>
              {shortCommitOid(actionDialog.preview.targetOid)} ·{" "}
              {actionDialog.commit.subject || "无标题提交"}
            </code>
          ) : (
            <code>
              {shortCommitOid(actionDialog.commit.oid)} ·{" "}
              {actionDialog.commit.subject || "无标题提交"}
            </code>
          )}

          {actionDialog.kind === "reset" && actionDialog.preview.mode === "hard" ? (
            <label className="commit-hard-reset-confirmation">
              <input
                type="checkbox"
                checked={hardResetAcknowledged}
                disabled={actionBusy}
                onChange={(event) => setHardResetAcknowledged(event.target.checked)}
              />
              <span>我了解：目标提交之后的提交会从当前分支历史中移除。</span>
            </label>
          ) : null}

          <div className="confirmation-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={actionBusy}
              onClick={() => setActionDialog(null)}
            >
              取消
            </button>
            <button
              className={
                actionDialog.kind === "revert" || actionDialog.kind === "reset"
                  ? "danger-button"
                  : "primary-button"
              }
              type="submit"
              disabled={
                actionBusy ||
                (actionDialog.kind === "branch" && !branchName.trim()) ||
                (actionDialog.kind === "amend" && !amendSubject.trim()) ||
                (actionDialog.kind === "reset" &&
                  actionDialog.preview.mode === "hard" &&
                  !hardResetAcknowledged)
              }
            >
              {actionBusy
                ? "处理中…"
                : actionDialog.kind === "branch"
                  ? "创建分支"
                  : actionDialog.kind === "amend"
                    ? "确认修改"
                    : actionDialog.kind === "revert"
                      ? "创建 Revert 提交"
                      : actionDialog.kind === "cherryPick"
                        ? "确认 Cherry-pick"
                        : actionDialog.preview.mode === "hard"
                          ? "永久丢弃并重置"
                          : "确认重置"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function commitGraphLaneX(lane: number) {
  return 10 + Math.min(Math.max(lane, 0), 2) * 14;
}

function commitGraphGutter(layout: CommitGraphRowLayout | undefined) {
  if (!layout) return 24;
  const lanes = [
    layout.nodeLane,
    ...layout.segments.flatMap((segment) =>
      segment.type === "line" ? [segment.lane] : [segment.fromLane, segment.toLane],
    ),
  ];
  const maxLane = Math.max(0, ...lanes);
  return Math.max(24, commitGraphLaneX(maxLane) + 10);
}

function CommitGraphContinuation({ layout }: { layout: CommitGraphRowLayout | undefined }) {
  const lines = layout?.expansionLines ?? [];
  if (lines.length === 0) return null;

  return (
    <svg
      className="commit-inline-graph"
      viewBox="0 0 44 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {lines.map((line) => {
        const x = commitGraphLaneX(line.lane);
        return (
          <path
            className={`commit-graph-line straight graph-tone-${line.tone}`}
            d={`M ${x} -0.02 L ${x} 1.02`}
            key={`${line.tone}:${line.lane}`}
          />
        );
      })}
    </svg>
  );
}

function CommitGraphCell({
  commit,
  first,
  layout,
}: {
  commit: CommitSummary;
  first: boolean;
  layout: CommitGraphRowLayout | undefined;
}) {
  const row = layout ?? {
    expansionLines: [],
    merge: false,
    nodeLane: 0,
    nodeTone: "local" as CommitGraphTone,
    segments:
      commit.parentOids.length > 0
        ? ([
            {
              end: "bottom",
              lane: 0,
              start: "node",
              tone: "local",
              type: "line",
            },
          ] satisfies CommitGraphSegment[])
        : [],
  };

  return (
    <svg
      className={`commit-graph-cell graph-tone-${row.nodeTone}${first ? " graph-first-node" : ""}`}
      viewBox="0 0 44 28"
      aria-hidden="true"
    >
      {row.segments.map((segment, index) => (
        <path
          className={`commit-graph-line${segment.type === "line" ? " straight" : ""} graph-tone-${segment.tone}`}
          d={commitGraphSegmentPath(segment)}
          key={`${segment.type}:${segment.tone}:${index}`}
        />
      ))}
      {row.merge ? (
        <>
          <circle
            className={`commit-graph-merge-ring graph-tone-${row.nodeTone}`}
            cx={commitGraphLaneX(row.nodeLane)}
            cy="14"
            r="5.2"
          />
          <circle
            className={`commit-graph-merge-dot graph-tone-${row.nodeTone}`}
            cx={commitGraphLaneX(row.nodeLane)}
            cy="14"
            r="2.3"
          />
        </>
      ) : (
        <circle
          className={`commit-graph-node${commit.parentOids.length === 0 ? " root" : ""} graph-tone-${row.nodeTone}`}
          cx={commitGraphLaneX(row.nodeLane)}
          cy="14"
          r="4.2"
        />
      )}
    </svg>
  );
}

function commitGraphSegmentPath(segment: CommitGraphSegment) {
  const y = (position: "top" | "node" | "bottom") =>
    position === "top" ? 0 : position === "node" ? 14 : 28;
  if (segment.type === "line") {
    const x = commitGraphLaneX(segment.lane);
    return `M ${x} ${y(segment.start)} L ${x} ${y(segment.end)}`;
  }

  const x1 = commitGraphLaneX(segment.fromLane);
  const x2 = commitGraphLaneX(segment.toLane);
  const y1 = y(segment.start);
  const y2 = y(segment.end);
  if (segment.connectToNode) {
    const midpoint = (y1 + y2) / 2;
    const direction = x1 >= x2 ? 1 : -1;
    const nodeX = x2 + direction * 5.2;
    const nodeControlX = nodeX + direction * 3.2;
    return `M ${x1} ${y1} C ${x1} ${midpoint} ${nodeControlX} ${y2} ${nodeX} ${y2}`;
  }
  if (!segment.merge) {
    return `M ${x1} ${y1} C ${x1} 14 ${x2} 14 ${x2} ${y2}`;
  }

  const direction = x2 >= x1 ? 1 : -1;
  const nodeX = x1 + direction * 5.2;
  const nodeControlX = nodeX + direction * 3.2;
  return `M ${nodeX} ${y1} C ${nodeControlX} ${y1} ${x2} ${y2 - 5} ${x2} ${y2}`;
}
