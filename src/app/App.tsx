import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  CaretDown,
  CloudArrowDown,
  FolderSimple,
  FolderSimplePlus,
  FolderOpen,
  Funnel,
  GitBranch,
  GitCommit,
  GitFork,
  GitMerge,
  MagnifyingGlass,
  Monitor,
  Moon,
  PushPin,
  Star,
  Sun,
  Tag,
  Trash,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import {
  desktopApi,
  type GitOperationEvent,
  type GitVersion,
  type Project,
  type RepositoryStatus,
} from "../platform/desktop";
import { BranchesView } from "../features/branches/BranchesView";
import { TagsView } from "../features/tags/TagsView";
import { StashesView } from "../features/stashes/StashesView";
import { SubmodulesView } from "../features/submodules/SubmodulesView";
import { WorktreesView } from "../features/worktrees/WorktreesView";
import { RepositoryWorkbenchView } from "../features/repository/RepositoryWorkbenchView";
import {
  isCurrentRepositoryStatusRequest,
  isCurrentStatusRequest,
} from "../features/repository/status";
import { CloneRepositoryDialog } from "../features/projects/CloneRepositoryDialog";
import { UpdateControl } from "../features/updates/UpdateControl";
import {
  groupProjects,
  mergeScannedProjects,
  selectProjectIdWhenEmpty,
  upsertProject,
} from "../features/projects/projectList";
import {
  isActiveGitOperation,
  isTerminalGitOperation,
  upsertGitOperation,
} from "../features/operations/gitOperations";
import logoUrl from "../assets/git-knot-logo.svg";
import {
  applyThemeMode,
  getStoredThemeMode,
  nextThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "./theme";

type RepositoryView = "workspace" | "branches" | "tags" | "stashes" | "worktrees" | "submodules";

type ProjectStatusFilter = "all" | "dirty" | "clean" | "ahead" | "behind" | "favorite";

interface ProjectContextMenuState {
  project: Project;
  x: number;
  y: number;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "操作失败，请稍后重试";
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gitVersion, setGitVersion] = useState<GitVersion | null>(null);
  const [status, setStatus] = useState<RepositoryStatus | null>(null);
  const [projectStatuses, setProjectStatuses] = useState<Record<string, RepositoryStatus>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<RepositoryView>("workspace");
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneRemoteUrl, setCloneRemoteUrl] = useState("");
  const [cloneParentDirectory, setCloneParentDirectory] = useState("");
  const [cloneOperation, setCloneOperation] = useState<GitOperationEvent | null>(null);
  const [gitOperations, setGitOperations] = useState<GitOperationEvent[]>([]);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneStarting, setCloneStarting] = useState(false);
  const [choosingCloneDirectory, setChoosingCloneDirectory] = useState(false);
  const [scanningProjects, setScanningProjects] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectStatusFilter, setProjectStatusFilter] = useState<ProjectStatusFilter>("all");
  const [metadataSavingId, setMetadataSavingId] = useState<string | null>(null);
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(
    null,
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredThemeMode);
  const statusRequest = useRef(0);
  const projectContextMenuRef = useRef<HTMLDivElement | null>(null);
  const projectStatusesRef = useRef<Record<string, RepositoryStatus>>({});
  const repositoryStatusLoads = useRef(new Map<string, Promise<RepositoryStatus>>());
  const repositoryStatusRequests = useRef(new Map<string, number>());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? null,
    [projects, selectedId],
  );
  const statusFilteredProjects = useMemo(
    () =>
      projects.filter((project) => {
        if (projectStatusFilter === "all") return true;
        if (projectStatusFilter === "favorite") return project.favorite;
        const projectStatus = projectStatuses[project.id];
        if (!projectStatus) return false;
        if (projectStatusFilter === "dirty") return projectStatus.changes.length > 0;
        if (projectStatusFilter === "clean") return projectStatus.changes.length === 0;
        if (projectStatusFilter === "ahead") return projectStatus.branch.ahead > 0;
        return projectStatus.branch.behind > 0;
      }),
    [projectStatusFilter, projectStatuses, projects],
  );
  const selectedRepositoryOperations = useMemo(
    () =>
      selectedProject
        ? gitOperations.filter((operation) => operation.repositoryPath === selectedProject.path)
        : [],
    [gitOperations, selectedProject],
  );
  const activeRepositoryOperations = useMemo(
    () =>
      gitOperations.filter(
        (operation) => operation.kind !== "clone" && isActiveGitOperation(operation),
      ),
    [gitOperations],
  );
  const projectSections = useMemo(
    () => groupProjects(statusFilteredProjects, projectQuery),
    [projectQuery, statusFilteredProjects],
  );
  const matchingProjectCount = useMemo(
    () => projectSections.reduce((total, section) => total + section.projects.length, 0),
    [projectSections],
  );

  useEffect(() => {
    persistThemeMode(themeMode);
    return subscribeToSystemTheme(themeMode, () => applyThemeMode(themeMode));
  }, [themeMode]);

  useEffect(() => {
    if (!projectNotice) return;
    const timeout = window.setTimeout(() => setProjectNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [projectNotice]);

  const cacheProjectStatus = useCallback((projectId: string, nextStatus: RepositoryStatus) => {
    const nextStatuses = { ...projectStatusesRef.current, [projectId]: nextStatus };
    projectStatusesRef.current = nextStatuses;
    setProjectStatuses(nextStatuses);
  }, []);

  const recordGitOperation = useCallback((event: GitOperationEvent) => {
    setGitOperations((current) => upsertGitOperation(current, event));
  }, []);

  const cancelGitOperation = useCallback(async (operationId: string) => {
    try {
      const accepted = await desktopApi.gitOperations.cancel(operationId);
      if (!accepted) setProjectNotice("该 Git 操作已经结束。");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const readRepositoryStatus = useCallback((project: Project) => {
    const pending = repositoryStatusLoads.current.get(project.path);
    if (pending) return pending;

    const request = desktopApi.repository.status(project.path);
    repositoryStatusLoads.current.set(project.path, request);
    const clearPendingRequest = () => {
      if (repositoryStatusLoads.current.get(project.path) === request) {
        repositoryStatusLoads.current.delete(project.path);
      }
    };
    void request.then(clearPendingRequest, clearPendingRequest);
    return request;
  }, []);

  const repositoryStatusRequestId = useCallback(
    (repositoryPath: string) => repositoryStatusRequests.current.get(repositoryPath) ?? 0,
    [],
  );

  const invalidateRepositoryStatus = useCallback((repositoryPath: string) => {
    const requestId = (repositoryStatusRequests.current.get(repositoryPath) ?? 0) + 1;
    repositoryStatusRequests.current.set(repositoryPath, requestId);
    repositoryStatusLoads.current.delete(repositoryPath);
    return requestId;
  }, []);

  const loadStatus = useCallback(
    async (project: Project | null) => {
      const requestId = ++statusRequest.current;
      if (!project) {
        setStatus(null);
        setRefreshing(false);
        return;
      }
      setRefreshing(true);
      setError(null);
      const repositoryRequestId = repositoryStatusRequestId(project.path);
      try {
        const nextStatus = await readRepositoryStatus(project);
        if (
          !isCurrentRepositoryStatusRequest(
            statusRequest.current,
            requestId,
            repositoryStatusRequestId(project.path),
            repositoryRequestId,
          )
        ) {
          return;
        }
        cacheProjectStatus(project.id, nextStatus);
        setStatus(nextStatus);
      } catch (cause) {
        if (isCurrentStatusRequest(statusRequest.current, requestId)) {
          setStatus(null);
          setError(errorMessage(cause));
        }
      } finally {
        if (isCurrentStatusRequest(statusRequest.current, requestId)) setRefreshing(false);
      }
    },
    [cacheProjectStatus, readRepositoryStatus, repositoryStatusRequestId],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([desktopApi.projects.list(), desktopApi.repository.gitVersion()])
      .then(([savedProjects, version]) => {
        if (cancelled) return;
        setProjects(savedProjects);
        setGitVersion(version);
        setSelectedId(savedProjects[0]?.id ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};
    void desktopApi.gitOperations
      .subscribe((event) => {
        recordGitOperation(event);

        if (event.kind === "clone") {
          setCloneOperation(event);
          if (!isTerminalGitOperation(event)) return;
          setCloneStarting(false);
          if (event.state !== "succeeded") return;

          void desktopApi.projects
            .list()
            .then((savedProjects) => {
              if (disposed) return;
              const cloned = savedProjects.find((project) => project.path === event.repositoryPath);
              if (cloned) {
                setProjects((current) => upsertProject(current, cloned));
                setSelectedId((current) => selectProjectIdWhenEmpty(current, cloned));
              }
              setCloneOpen(false);
              setCloneRemoteUrl("");
              setCloneParentDirectory("");
              setCloneOperation(null);
            })
            .catch((cause) => {
              if (!disposed) setError(errorMessage(cause));
            });
          return;
        }

        if (!isTerminalGitOperation(event)) return;
        if (event.state === "failed" || event.state === "timed_out") {
          setError(event.message);
        } else {
          setProjectNotice(event.message);
        }

        const project = projectsRef.current.find((item) => item.path === event.repositoryPath);
        if (!project) return;
        const requestId =
          selectedIdRef.current === project.id ? ++statusRequest.current : statusRequest.current;
        const repositoryRequestId = invalidateRepositoryStatus(project.path);
        void readRepositoryStatus(project)
          .then((nextStatus) => {
            if (disposed || repositoryStatusRequestId(project.path) !== repositoryRequestId) {
              return;
            }
            cacheProjectStatus(project.id, nextStatus);
            if (
              selectedIdRef.current === project.id &&
              isCurrentStatusRequest(statusRequest.current, requestId)
            ) {
              setStatus(nextStatus);
              setRefreshing(false);
            }
          })
          .catch((cause) => {
            if (disposed || repositoryStatusRequestId(project.path) !== repositoryRequestId) {
              return;
            }
            setError(errorMessage(cause));
            if (
              selectedIdRef.current === project.id &&
              isCurrentStatusRequest(statusRequest.current, requestId)
            ) {
              setRefreshing(false);
            }
          });
      })
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [
    cacheProjectStatus,
    invalidateRepositoryStatus,
    readRepositoryStatus,
    recordGitOperation,
    repositoryStatusRequestId,
  ]);

  useEffect(() => {
    const activeProjectIds = new Set(projects.map((project) => project.id));
    const retainedStatuses = Object.fromEntries(
      Object.entries(projectStatusesRef.current).filter(([projectId]) =>
        activeProjectIds.has(projectId),
      ),
    );
    if (Object.keys(retainedStatuses).length !== Object.keys(projectStatusesRef.current).length) {
      projectStatusesRef.current = retainedStatuses;
      setProjectStatuses(retainedStatuses);
    }

    const pendingProjects = projects.filter((project) => {
      const cached = projectStatusesRef.current[project.id];
      return !cached || cached.root !== project.path;
    });
    if (pendingProjects.length === 0) return;

    let cancelled = false;
    let nextProjectIndex = 0;
    const loadNextProject = async () => {
      while (!cancelled) {
        const project = pendingProjects[nextProjectIndex++];
        if (!project) return;
        const requestId = statusRequest.current;
        const repositoryRequestId = repositoryStatusRequestId(project.path);
        try {
          const nextStatus = await readRepositoryStatus(project);
          const selectedRequestIsCurrent =
            selectedIdRef.current !== project.id ||
            isCurrentStatusRequest(statusRequest.current, requestId);
          if (
            !cancelled &&
            selectedRequestIsCurrent &&
            repositoryStatusRequestId(project.path) === repositoryRequestId
          ) {
            cacheProjectStatus(project.id, nextStatus);
          }
        } catch {
          // A missing or invalid repository should not prevent the rest of the list from loading.
        }
      }
    };

    const workerCount = Math.min(3, pendingProjects.length);
    void Promise.all(Array.from({ length: workerCount }, loadNextProject));
    return () => {
      cancelled = true;
    };
  }, [cacheProjectStatus, projects, readRepositoryStatus, repositoryStatusRequestId]);

  useEffect(() => {
    void loadStatus(selectedProject);
  }, [loadStatus, selectedProject]);

  const handleSelectedStatusChange = useCallback(
    (nextStatus: RepositoryStatus) => {
      ++statusRequest.current;
      const selectedProjectPath = projectsRef.current.find(
        (project) => project.id === selectedId,
      )?.path;
      invalidateRepositoryStatus(nextStatus.root);
      if (selectedProjectPath && selectedProjectPath !== nextStatus.root) {
        invalidateRepositoryStatus(selectedProjectPath);
      }
      setRefreshing(false);
      setStatus(nextStatus);
      if (selectedId) cacheProjectStatus(selectedId, nextStatus);
    },
    [cacheProjectStatus, invalidateRepositoryStatus, selectedId],
  );

  async function addRepository() {
    setError(null);
    try {
      const path = await desktopApi.projects.pickRepository();
      if (!path) return;
      const project = await desktopApi.projects.add(path);
      setProjects((current) => {
        const withoutExisting = current.filter((item) => item.id !== project.id);
        return [project, ...withoutExisting];
      });
      setSelectedId(project.id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function scanParentDirectory() {
    if (scanningProjects) return;
    setError(null);
    setScanningProjects(true);
    try {
      const parentDirectory = await desktopApi.projects.pickScanParentDirectory();
      if (!parentDirectory) return;

      setProjectNotice("正在扫描父目录中的 Git 项目…");
      const scanned = await desktopApi.projects.scan(parentDirectory);
      if (scanned.length === 0) {
        setProjectNotice("未发现 Git 项目");
        return;
      }

      const currentPaths = new Set(projectsRef.current.map((project) => project.path));
      const newCount = scanned.filter((project) => !currentPaths.has(project.path)).length;
      setProjects((current) => mergeScannedProjects(scanned, current));
      setSelectedId((current) => selectProjectIdWhenEmpty(current, scanned[0]));
      setProjectNotice(`已扫描 ${scanned.length} 个 Git 项目，新增 ${newCount} 个`);
    } catch (cause) {
      setError(errorMessage(cause));
      setProjectNotice(null);
    } finally {
      setScanningProjects(false);
    }
  }

  function openProjectContextMenu(event: ReactMouseEvent, project: Project) {
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 196;
    const menuHeight = 360;
    setSelectedId(project.id);
    setProjectContextMenu({
      project,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  useEffect(() => {
    if (!projectContextMenu) return;

    const close = (event: MouseEvent) => {
      if (!projectContextMenuRef.current?.contains(event.target as Node)) {
        setProjectContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectContextMenu(null);
        return;
      }

      const items = Array.from(
        projectContextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;

      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      }
      if (event.key === "ArrowUp") {
        nextIndex =
          currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      }
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
      projectContextMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [projectContextMenu]);

  async function removeProject(project: Project) {
    if (removingProjectId) return;

    setProjectContextMenu(null);
    setRemovingProjectId(project.id);
    setError(null);
    try {
      await desktopApi.projects.remove(project.id);

      const projectIndex = projects.findIndex((item) => item.id === project.id);
      const remainingProjects = projects.filter((item) => item.id !== project.id);
      setProjects(remainingProjects);

      if (selectedId === project.id) {
        ++statusRequest.current;
        const nextProject =
          remainingProjects[Math.min(projectIndex, remainingProjects.length - 1)] ?? null;
        setSelectedId(nextProject?.id ?? null);
        setStatus(null);
        setRefreshing(false);
      }

      const remainingStatuses = { ...projectStatusesRef.current };
      delete remainingStatuses[project.id];
      projectStatusesRef.current = remainingStatuses;
      setProjectStatuses(remainingStatuses);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRemovingProjectId(null);
    }
  }

  async function updateProjectMetadata(project: Project, favorite: boolean, group: string | null) {
    if (metadataSavingId) return;
    setMetadataSavingId(project.id);
    setError(null);
    try {
      const updated = await desktopApi.projects.updateMetadata({
        id: project.id,
        favorite,
        group,
      });
      setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setMetadataSavingId(null);
    }
  }

  async function pickCloneParentDirectory() {
    setChoosingCloneDirectory(true);
    setCloneError(null);
    try {
      const path = await desktopApi.projects.pickCloneParentDirectory();
      if (path) setCloneParentDirectory(path);
    } catch (cause) {
      setCloneError(errorMessage(cause));
    } finally {
      setChoosingCloneDirectory(false);
    }
  }

  async function startClone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cloneRemoteUrl.trim() || !cloneParentDirectory || cloneStarting) return;
    setCloneStarting(true);
    setCloneOperation(null);
    setCloneError(null);
    try {
      const started = await desktopApi.projects.clone(cloneRemoteUrl, cloneParentDirectory);
      const operation: GitOperationEvent = {
        operationId: started.operationId,
        repositoryPath: started.repositoryPath,
        kind: "clone",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待克隆仓库",
        remoteTagDeletePreview: null,
      };
      setCloneOperation(operation);
      recordGitOperation(operation);
    } catch (cause) {
      setCloneStarting(false);
      setCloneError(errorMessage(cause));
    }
  }

  async function cancelClone() {
    if (!cloneOperation) return;
    try {
      await desktopApi.gitOperations.cancel(cloneOperation.operationId);
    } catch (cause) {
      setCloneError(errorMessage(cause));
    }
  }

  function closeCloneDialog() {
    setCloneOpen(false);
    setCloneOperation(null);
    setCloneError(null);
  }

  const visibleStatus = selectedProject && status?.root === selectedProject.path ? status : null;

  const themeLabel =
    themeMode === "system" ? "跟随系统" : themeMode === "light" ? "浅色主题" : "深色主题";
  const ThemeIcon = themeMode === "system" ? Monitor : themeMode === "light" ? Sun : Moon;

  const projectFilters: Array<{ id: ProjectStatusFilter; label: string }> = [
    { id: "all", label: "全部仓库" },
    { id: "dirty", label: "有更改" },
    { id: "clean", label: "工作区干净" },
    { id: "ahead", label: "领先远端" },
    { id: "behind", label: "落后远端" },
    { id: "favorite", label: "已收藏" },
  ];
  const activeProjectFilterLabel =
    projectFilters.find((filter) => filter.id === projectStatusFilter)?.label ?? "全部仓库";

  const views: Array<{
    id: RepositoryView;
    label: string;
    icon: typeof GitCommit;
  }> = [
    { id: "workspace", label: "工作台", icon: GitMerge },
    { id: "branches", label: "分支与远端", icon: GitBranch },
    { id: "tags", label: "标签", icon: Tag },
    { id: "stashes", label: "储藏", icon: Archive },
    { id: "worktrees", label: "工作树", icon: TreeStructure },
    { id: "submodules", label: "子模块", icon: GitFork },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="仓库列表">
        <header className="sidebar-header">
          <div className="sidebar-header-actions">
            <button
              className="clone-trigger"
              type="button"
              onClick={() => setCloneOpen(true)}
              aria-label="克隆仓库"
              title="克隆仓库"
            >
              <CloudArrowDown size={15} weight="bold" aria-hidden="true" />
              <span className="clone-trigger-label">克隆</span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={addRepository}
              aria-label="添加本地仓库"
              title="添加本地仓库"
            >
              <FolderSimplePlus size={17} weight="bold" aria-hidden="true" />
            </button>
            <button
              className={`icon-button project-scan-button${scanningProjects ? " scanning" : ""}`}
              type="button"
              disabled={scanningProjects}
              onClick={() => void scanParentDirectory()}
              aria-label="扫描父目录中的 Git 项目"
              title="扫描父目录中的 Git 项目"
            >
              <FolderOpen size={16} weight="bold" aria-hidden="true" />
            </button>

            <label
              className="project-toolbar-search icon-button"
              data-active={projectQuery.trim() ? "true" : "false"}
              title="搜索仓库"
            >
              <MagnifyingGlass size={15} weight="bold" aria-hidden="true" />
              <input
                type="search"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.target.value)}
                placeholder="搜索仓库"
                aria-label="搜索仓库"
              />
            </label>

            <details
              className={`project-filter${projectStatusFilter === "all" ? "" : " active"}`}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  event.currentTarget.removeAttribute("open");
                }
              }}
            >
              <summary
                className="icon-button"
                aria-label={`筛选仓库：${activeProjectFilterLabel}`}
                title={`筛选仓库：${activeProjectFilterLabel}`}
              >
                <Funnel
                  size={15}
                  weight={projectStatusFilter === "all" ? "regular" : "fill"}
                  aria-hidden="true"
                />
              </summary>
              <div className="project-filter-popover" role="menu" aria-label="筛选仓库">
                <header>
                  <strong>筛选仓库</strong>
                  <small>{activeProjectFilterLabel}</small>
                </header>
                {projectFilters.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={projectStatusFilter === filter.id}
                    onClick={(event) => {
                      setProjectStatusFilter(filter.id);
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    <span className="project-filter-mark" aria-hidden="true" />
                    <span>{filter.label}</span>
                  </button>
                ))}
              </div>
            </details>

            <button
              className="icon-button theme-toggle"
              type="button"
              onClick={() => setThemeMode((current) => nextThemeMode(current))}
              aria-label={`切换主题，当前：${themeLabel}`}
              title={`切换主题，当前：${themeLabel}`}
            >
              <ThemeIcon size={15} weight="bold" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="project-list">
          {projects.length === 0 && !loading ? (
            <div className="empty-sidebar">
              <GitBranch size={24} weight="duotone" aria-hidden="true" />
              <p>还没有仓库</p>
              <button type="button" className="secondary-button" onClick={addRepository}>
                添加本地仓库
              </button>
            </div>
          ) : null}
          {projects.length > 0 && matchingProjectCount === 0 ? (
            <div className="empty-sidebar project-search-empty">
              <MagnifyingGlass size={23} aria-hidden="true" />
              <p>没有符合当前搜索或筛选的仓库</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setProjectQuery("");
                  setProjectStatusFilter("all");
                }}
              >
                清除筛选
              </button>
            </div>
          ) : null}
          {projectSections.map((section) => (
            <section className="project-section" key={section.key}>
              <header>
                <span className="project-section-title">
                  <CaretDown size={12} weight="bold" aria-hidden="true" />
                  {section.label}
                </span>
                <span>{section.projects.length}</span>
              </header>
              {section.projects.map((project) => {
                const projectStatus = projectStatuses[project.id];
                const branchName = projectStatus?.branch.head ?? "Detached";
                const changeCount = projectStatus?.changes.length ?? 0;
                const ahead = projectStatus?.branch.ahead ?? 0;
                const behind = projectStatus?.branch.behind ?? 0;
                const diverged = ahead > 0 && behind > 0;

                return (
                  <div
                    key={project.id}
                    className={`project-row${selectedId === project.id ? " selected" : ""}`}
                    onContextMenu={(event) => openProjectContextMenu(event, project)}
                  >
                    <button
                      type="button"
                      className="project-select"
                      title={project.path}
                      onClick={() => {
                        setProjectContextMenu(null);
                        setSelectedId(project.id);
                        setActiveView("workspace");
                      }}
                    >
                      <span className="repo-icon" aria-hidden="true">
                        <FolderSimple size={15} weight="bold" />
                      </span>
                      <span className="project-copy">
                        <strong>{project.name}</strong>
                        {projectStatus ? (
                          <span className="project-meta">
                            <span
                              className="repo-info-badge branch"
                              title={`当前分支：${branchName}`}
                            >
                              <GitBranch size={10} weight="bold" aria-hidden="true" />
                              <span className="repo-info-badge-label">{branchName}</span>
                            </span>
                            {changeCount > 0 ? (
                              <span
                                className="repo-info-badge changes"
                                title={`${changeCount} 个工作区更改`}
                              >
                                {changeCount} 更改
                              </span>
                            ) : null}
                            {diverged ? (
                              <span
                                className="repo-info-badge diverged"
                                title={`领先 ${ahead}，落后 ${behind}`}
                                aria-label={`领先 ${ahead}，落后 ${behind}`}
                              >
                                ↑{ahead} ↓{behind}
                              </span>
                            ) : ahead > 0 ? (
                              <span className="repo-info-badge ahead" title={`领先 ${ahead}`}>
                                领先 {ahead}
                              </span>
                            ) : behind > 0 ? (
                              <span className="repo-info-badge behind" title={`落后 ${behind}`}>
                                落后 {behind}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="project-meta project-path-meta">
                            <small>{project.path}</small>
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`project-favorite${project.favorite ? " active" : ""}`}
                      aria-label={
                        project.favorite ? `取消收藏 ${project.name}` : `收藏 ${project.name}`
                      }
                      aria-pressed={project.favorite}
                      disabled={metadataSavingId === project.id || removingProjectId === project.id}
                      onClick={() =>
                        void updateProjectMetadata(project, !project.favorite, project.group)
                      }
                    >
                      <Star
                        size={16}
                        weight={project.favorite ? "fill" : "regular"}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="sidebar-footer">
          <div className="sidebar-footer-status">
            <span className="status-dot" aria-hidden="true" />
            <span title={projectNotice ?? undefined}>
              {projectNotice ?? gitVersion?.raw ?? "正在检测 Git..."}
            </span>
          </div>
          <UpdateControl />
        </footer>
      </aside>

      <section className="workspace">
        {error ? (
          <div className="error-banner" role="alert">
            <strong>无法完成操作</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">
              <X size={15} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {activeRepositoryOperations.length > 0 ? (
          <div className="app-operation-stack" aria-label="正在运行的 Git 操作">
            {activeRepositoryOperations.map((operation) => {
              const projectName =
                projects.find((project) => project.path === operation.repositoryPath)?.name ??
                operation.repositoryPath;
              return (
                <section
                  className="git-operation-card app-operation-card"
                  key={operation.operationId}
                >
                  <div>
                    <strong>{operation.message}</strong>
                    <small>
                      {projectName}
                      {operation.percent === null
                        ? " · Git 长任务运行中"
                        : ` · ${operation.percent}%`}
                    </small>
                  </div>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => void cancelGitOperation(operation.operationId)}
                  >
                    取消
                  </button>
                  <progress max={100} value={operation.percent ?? undefined} />
                </section>
              );
            })}
          </div>
        ) : null}

        {!selectedProject ? (
          <div className="welcome-panel">
            <img className="welcome-logo" src={logoUrl} alt="git-knot" />
            <p className="eyebrow">LOCAL FIRST GIT CLIENT</p>
            <h2>把仓库脉络打成一个结</h2>
            <p>添加本地仓库或克隆远端仓库，在一个原生桌面工作区中管理提交、分支和工作树。</p>
            <div className="welcome-actions">
              <button type="button" className="primary-button" onClick={() => setCloneOpen(true)}>
                <CloudArrowDown size={16} weight="bold" aria-hidden="true" />
                克隆远端仓库
              </button>
              <button type="button" className="secondary-button" onClick={addRepository}>
                <FolderSimplePlus size={16} weight="bold" aria-hidden="true" />
                添加本地仓库
              </button>
            </div>
          </div>
        ) : (
          <>
            {activeView === "workspace" ? (
              <RepositoryWorkbenchView
                project={selectedProject}
                status={visibleStatus}
                refreshing={refreshing}
                onRefresh={() => loadStatus(selectedProject)}
                onStatusChange={handleSelectedStatusChange}
                onError={setError}
                gitOperations={selectedRepositoryOperations}
                onOperationStarted={recordGitOperation}
              />
            ) : activeView === "branches" ? (
              <BranchesView
                project={selectedProject}
                onStatusChange={handleSelectedStatusChange}
                onError={setError}
                gitOperations={selectedRepositoryOperations}
                onOperationStarted={recordGitOperation}
              />
            ) : activeView === "tags" ? (
              <TagsView
                project={selectedProject}
                onError={setError}
                gitOperations={selectedRepositoryOperations}
                onOperationStarted={recordGitOperation}
              />
            ) : activeView === "stashes" ? (
              <StashesView
                project={selectedProject}
                onStatusChange={handleSelectedStatusChange}
                onError={setError}
              />
            ) : activeView === "worktrees" ? (
              <WorktreesView project={selectedProject} onError={setError} />
            ) : (
              <SubmodulesView project={selectedProject} />
            )}
          </>
        )}
      </section>

      {projectContextMenu
        ? createPortal(
            <div
              ref={projectContextMenuRef}
              className="project-context-menu"
              role="menu"
              aria-label={`${projectContextMenu.project.name} 的项目操作`}
              style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="menuitem"
                disabled={
                  metadataSavingId === projectContextMenu.project.id ||
                  removingProjectId === projectContextMenu.project.id
                }
                onClick={() => {
                  const project = projectContextMenu.project;
                  setProjectContextMenu(null);
                  void updateProjectMetadata(project, !project.favorite, project.group);
                }}
              >
                <PushPin
                  weight={projectContextMenu.project.favorite ? "fill" : "regular"}
                  aria-hidden="true"
                />
                <span>{projectContextMenu.project.favorite ? "取消置顶" : "置顶项目"}</span>
              </button>

              <div className="project-context-separator" role="separator" />
              <span className="project-context-heading">打开仓库视图</span>
              {views.map((view) => {
                const ViewIcon = view.icon;
                return (
                  <button
                    key={view.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeView === view.id}
                    onClick={() => {
                      setSelectedId(projectContextMenu.project.id);
                      setActiveView(view.id);
                      setProjectContextMenu(null);
                    }}
                  >
                    <ViewIcon
                      size={15}
                      weight={activeView === view.id ? "fill" : "regular"}
                      aria-hidden="true"
                    />
                    <span>{view.label}</span>
                  </button>
                );
              })}

              <div className="project-context-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setThemeMode((current) => nextThemeMode(current));
                  setProjectContextMenu(null);
                }}
              >
                <ThemeIcon size={15} weight="bold" aria-hidden="true" />
                <span>主题：{themeLabel}</span>
              </button>

              <div className="project-context-separator" role="separator" />

              <button
                type="button"
                role="menuitem"
                className="danger"
                title="仅从 git-knot 列表移除，不会删除本地仓库文件"
                disabled={
                  metadataSavingId === projectContextMenu.project.id ||
                  removingProjectId === projectContextMenu.project.id
                }
                onClick={() => void removeProject(projectContextMenu.project)}
              >
                <Trash aria-hidden="true" />
                <span>移除项目记录</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      <CloneRepositoryDialog
        open={cloneOpen}
        remoteUrl={cloneRemoteUrl}
        parentDirectory={cloneParentDirectory}
        operation={cloneOperation}
        error={cloneError}
        starting={cloneStarting}
        choosingDirectory={choosingCloneDirectory}
        onRemoteUrlChange={setCloneRemoteUrl}
        onPickParentDirectory={pickCloneParentDirectory}
        onSubmit={startClone}
        onCancelOperation={cancelClone}
        onClose={closeCloneDialog}
      />
    </main>
  );
}
