import type {
  AmendCommitPreview,
  BranchInfo,
  CherryPickCommitPreview,
  CommitFileChange,
  CommitSummary,
  ConflictDetails,
  ConflictResolutionChoice,
  DesktopApi,
  FileChange,
  GitOperationEvent,
  HistoryQuery,
  LocalMergePreview,
  LocalMergeStrategy,
  MergeRecoveryPreview,
  Project,
  RemoteInfo,
  RemoteTagDeletePreview,
  RepositoryRefs,
  RepositoryStatus,
  ResetCommitMode,
  ResetCommitPreview,
  RevertCommitPreview,
  StashInfo,
  RepositorySubmodules,
  SubmoduleInfo,
  TagInfo,
  WorktreeCreateCandidate,
  WorktreeInfo,
} from "./contract";

const mockProject: Project = {
  id: "browser-preview",
  name: "git-knot",
  path: "/Users/demo/projects/git-knot",
  addedAt: Date.parse("2026-08-16T16:00:00+08:00"),
  favorite: true,
  group: "示例",
};

let mockProjects: Project[] = [{ ...mockProject }];

let mockSubmodules: SubmoduleInfo[] = [
  {
    path: "vendor/design-system",
    name: "vendor/design-system",
    url: "https://github.com/git-knot/design-system.git",
    branch: "main",
    expectedOid: "a".repeat(40),
    conflictOids: [],
    state: "clean",
    configured: true,
    stateDetail: null,
  },
  {
    path: "vendor/legacy",
    name: "vendor/legacy",
    url: "https://github.com/git-knot/legacy.git",
    branch: null,
    expectedOid: "b".repeat(40),
    conflictOids: [],
    state: "uninitialized",
    configured: true,
    stateDetail: null,
  },
];

function cloneSubmodules(): RepositorySubmodules {
  return {
    gitmodulesPresent: true,
    submodules: mockSubmodules.map((item) => ({
      ...item,
      conflictOids: [...item.conflictOids],
    })),
  };
}

let mockCommits: CommitSummary[] = [
  {
    oid: "75a2a598d38c764e2c82f86d12d3f47fd1ac0801",
    parentOids: ["acf4a2cfb17c7dce004479953fd193722ecebf6a"],
    authorName: "git-knot",
    authorEmail: "dev@example.com",
    authoredAt: "2026-08-16T18:30:00+08:00",
    subject: "feat: add repository history view",
  },
  {
    oid: "acf4a2cfb17c7dce004479953fd193722ecebf6a",
    parentOids: [],
    authorName: "git-knot",
    authorEmail: "dev@example.com",
    authoredAt: "2026-08-16T16:00:00+08:00",
    subject: "feat: bootstrap Tauri workspace",
  },
];

const mockCommitPaths = new Map<string, string[]>([
  [
    "75a2a598d38c764e2c82f86d12d3f47fd1ac0801",
    ["src/features/history/HistoryView.tsx", "src/platform/desktop/contract.ts"],
  ],
  ["acf4a2cfb17c7dce004479953fd193722ecebf6a", ["package.json", "src-tauri/Cargo.toml"]],
]);

const mockCommitBodies = new Map<string, string>([
  [
    "75a2a598d38c764e2c82f86d12d3f47fd1ac0801",
    "展示由 Rust 读取的提交元数据、文件列表和受限大小的 patch。",
  ],
  ["acf4a2cfb17c7dce004479953fd193722ecebf6a", ""],
]);

let mockChanges: FileChange[] = [
  {
    path: "src/features/history/HistoryView.tsx",
    originalPath: null,
    indexStatus: "M",
    worktreeStatus: null,
    kind: "ordinary",
  },
  {
    path: "src/platform/desktop/contract.ts",
    originalPath: null,
    indexStatus: null,
    worktreeStatus: "M",
    kind: "ordinary",
  },
  {
    path: "docs/architecture.md",
    originalPath: null,
    indexStatus: null,
    worktreeStatus: null,
    kind: "untracked",
  },
];

let mockBranches: BranchInfo[] = [
  {
    name: "main",
    fullName: "refs/heads/main",
    kind: "local",
    current: true,
    oid: mockCommits[0].oid,
    upstream: "origin/main",
    upstreamMissing: false,
    ahead: 1,
    behind: 0,
  },
  {
    name: "feature/workspace-actions",
    fullName: "refs/heads/feature/workspace-actions",
    kind: "local",
    current: false,
    oid: mockCommits[1].oid,
    upstream: null,
    upstreamMissing: false,
    ahead: 0,
    behind: 0,
  },
  {
    name: "release/preview",
    fullName: "refs/heads/release/preview",
    kind: "local",
    current: false,
    oid: mockCommits[1].oid,
    upstream: null,
    upstreamMissing: false,
    ahead: 0,
    behind: 0,
  },
  {
    name: "origin/main",
    fullName: "refs/remotes/origin/main",
    kind: "remote",
    current: false,
    oid: mockCommits[1].oid,
    upstream: null,
    upstreamMissing: false,
    ahead: 0,
    behind: 0,
  },
  {
    name: "origin/feature/remote-preview",
    fullName: "refs/remotes/origin/feature/remote-preview",
    kind: "remote",
    current: false,
    oid: mockCommits[1].oid,
    upstream: null,
    upstreamMissing: false,
    ahead: 0,
    behind: 0,
  },
];

type MockWorktreeState = Omit<WorktreeInfo, "token">;

let mockWorktrees: MockWorktreeState[] = [
  {
    path: mockProject.path,
    headOid: mockCommits[0]!.oid,
    branch: "main",
    branchFullName: "refs/heads/main",
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    isMain: true,
  },
  {
    path: "/Users/demo/projects/git-knot-worktrees/feature-workspace-actions",
    headOid: mockCommits[1]!.oid,
    branch: "feature/workspace-actions",
    branchFullName: "refs/heads/feature/workspace-actions",
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    isMain: false,
  },
];
const mockUnmergedBranches = new Set(["refs/heads/feature/workspace-actions"]);
let mockTags: TagInfo[] = [
  {
    name: "v0.1.0-preview",
    fullName: "refs/tags/v0.1.0-preview",
    oid: mockCommits[1].oid,
    targetOid: mockCommits[1].oid,
    annotated: false,
    subject: mockCommits[1].subject,
    taggerDate: null,
  },
];

let mockStashSequence = 100;
let mockMergeSequence = 200;
let mockAmendSequence = 300;
let mockRevertSequence = 400;
let mockCherryPickSequence = 500;
let mockCommitSequence = 600;
let mockStashes: StashInfo[] = [];
const mockStashChanges = new Map<string, FileChange[]>();

interface MockMergeRecoveryState {
  currentBranch: string | null;
  headOid: string;
  mergeHeadOid: string;
  beforeChanges: FileChange[];
}

const mockMergeRecoveryStates = new Map<string, MockMergeRecoveryState>();

let mockRemotes: RemoteInfo[] = [
  {
    name: "origin",
    fetchUrl: "https://github.com/git/git.git",
    pushUrl: "git@github.com:git/git.git",
    pushUrlOverridden: true,
  },
];
const mockRemoteTags = new Map<string, string>([
  [`origin\0${mockTags[0]!.fullName}`, mockTags[0]!.oid],
]);

const mockOperationListeners = new Set<(event: GitOperationEvent) => void>();
const mockOperationTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const mockOperationMeta = new Map<
  string,
  Pick<GitOperationEvent, "repositoryPath" | "kind"> & { cancelMessage: string }
>();
let mockOperationSequence = 0;

type MockGitOperationEvent = Omit<GitOperationEvent, "remoteTagDeletePreview"> &
  Partial<Pick<GitOperationEvent, "remoteTagDeletePreview">>;

function emitMockOperation(event: MockGitOperationEvent) {
  const normalized: GitOperationEvent = {
    remoteTagDeletePreview: null,
    ...event,
  };
  for (const listener of mockOperationListeners) listener(normalized);
}

function finishMockOperation(operationId: string) {
  mockOperationTimers.delete(operationId);
  mockOperationMeta.delete(operationId);
}

function scheduleMockOperation(operationId: string, callback: () => void, delay: number) {
  const timer = setTimeout(callback, delay);
  const timers = mockOperationTimers.get(operationId) ?? [];
  timers.push(timer);
  mockOperationTimers.set(operationId, timers);
}

function cloneRefs(): RepositoryRefs {
  return {
    branches: mockBranches.map((branch) => ({ ...branch })),
    remotes: mockRemotes.map((remote) => ({ ...remote })),
  };
}

function mockRemoteAffectedBranches(name: string) {
  return mockBranches
    .filter((branch) => branch.kind === "local" && branch.upstream?.startsWith(`${name}/`))
    .map((branch) => branch.name)
    .sort((left, right) => left.localeCompare(right));
}

function mockRemoteToken(remote: RemoteInfo) {
  const source = JSON.stringify({
    remote,
    affectedBranches: mockRemoteAffectedBranches(remote.name),
  });
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `00000000-0000-5000-8000-${(hash >>> 0).toString(16).padStart(8, "0")}0000`;
}

function mockRemoteTagKey(remoteName: string, fullName: string) {
  return `${remoteName}\0${fullName}`;
}

function findExpectedMockTag(fullName: string, expectedLocalOid: string) {
  if (!fullName.startsWith("refs/tags/")) {
    throw mockError("local_tag_required", "只能操作已读取的本地标签");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(expectedLocalOid)) {
    throw mockError("invalid_remote_tag_oid", "标签对象标识格式无效");
  }
  const tag = mockTags.find((candidate) => candidate.fullName === fullName);
  if (!tag) throw mockError("tag_not_found", "该标签已不存在，请刷新后重试");
  if (tag.oid.toLowerCase() !== expectedLocalOid.toLowerCase()) {
    throw mockError("local_tag_changed", "本地标签已被移动或替换，请刷新后重试");
  }
  return tag;
}

function mockRemoteTagDeleteToken(
  remote: RemoteInfo,
  fullName: string,
  localOid: string,
  remoteOid: string,
) {
  const source = JSON.stringify({ remote, fullName, localOid, remoteOid });
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `00000000-0000-5000-8000-${(hash >>> 0).toString(16).padStart(8, "0")}0000`;
}

function findMockRemote(name: string) {
  const remote = mockRemotes.find((candidate) => candidate.name === name);
  if (!remote) throw mockError("remote_not_found", "该远端已不存在，请刷新后重试");
  return remote;
}

function validateMockRemoteName(value: string) {
  const name = value.trim();
  if (
    !name ||
    name.length > 255 ||
    name.startsWith("-") ||
    name.includes("..") ||
    /[\s/\\\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw mockError(
      "invalid_remote_name",
      "远端名称不能为空，且不能包含空白、斜杠、连续点号或控制字符",
    );
  }
  return name;
}

function rejectMockGiteeHost(host: string) {
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  if (normalized === "gitee.com" || normalized.endsWith(".gitee.com")) {
    throw mockError("gitee_not_supported", "当前版本不支持 Gitee");
  }
}

function validateMockRemoteUrl(value: string) {
  const remoteUrl = value.trim();
  if (
    !remoteUrl ||
    remoteUrl.length > 4096 ||
    remoteUrl.startsWith("-") ||
    /[\u0000-\u001f\u007f]/u.test(remoteUrl)
  ) {
    throw mockError("invalid_remote_url", "远端地址无效");
  }
  if (remoteUrl.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(remoteUrl)) return remoteUrl;

  try {
    const parsed = new URL(remoteUrl);
    if (parsed.search || parsed.hash || parsed.password) {
      throw mockError("invalid_remote_url", "远端地址不能包含查询参数、片段或密码");
    }
    if (parsed.protocol === "file:") {
      if (!parsed.pathname.startsWith("/")) {
        throw mockError("invalid_remote_url", "file:// 远端必须指向绝对路径");
      }
      return remoteUrl;
    }
    if (!["https:", "ssh:", "git+ssh:"].includes(parsed.protocol) || !parsed.hostname) {
      throw mockError("unsupported_remote_url", "只支持 HTTPS、SSH、file:// 或本地绝对路径远端");
    }
    if (parsed.protocol === "https:" && parsed.username) {
      throw mockError("remote_url_credentials_forbidden", "HTTPS 远端地址不能包含用户名或凭据");
    }
    rejectMockGiteeHost(parsed.hostname);
    return remoteUrl;
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      !String(cause.code).startsWith("ERR_")
    ) {
      throw cause;
    }
  }

  const scp = remoteUrl.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^?#\\]+)$/u);
  if (!scp || !scp[3]?.replace(/^\/+|\/+$/gu, "")) {
    throw mockError(
      "invalid_remote_url",
      "远端地址必须是 HTTPS、SSH、user@host:path、file:// 或本地绝对路径",
    );
  }
  rejectMockGiteeHost(scp[2]!);
  return remoteUrl;
}

function sanitizeMockRemoteUrl(value: string) {
  const withoutSuffix = value.split(/[?#]/u, 1)[0] ?? value;
  const separator = withoutSuffix.indexOf("://");
  if (separator < 0) return withoutSuffix;
  const scheme = withoutSuffix.slice(0, separator);
  const remainder = withoutSuffix.slice(separator + 3);
  const slash = remainder.indexOf("/");
  const authority = slash < 0 ? remainder : remainder.slice(0, slash);
  const path = slash < 0 ? "" : remainder.slice(slash);
  const host = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return `${scheme}://${host}${path}`;
}

function mockError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function mockStableUuid(source: string) {
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `00000000-0000-5000-8000-${(hash >>> 0).toString(16).padStart(8, "0")}0000`;
}

function mockWorktreeToken(worktree: MockWorktreeState) {
  return mockStableUuid(JSON.stringify(worktree));
}

function mockWorktreeSlug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "branch"
  );
}

function mockWorktreeCreateCandidates(): WorktreeCreateCandidate[] {
  const checkedOut = new Set(mockWorktrees.flatMap((worktree) => worktree.branchFullName ?? []));
  return mockBranches
    .filter((branch) => branch.kind === "local" && !checkedOut.has(branch.fullName))
    .map((branch) => {
      const suffix = mockStableUuid(branch.fullName).slice(0, 8);
      const targetPath = `/Users/demo/projects/.git-knot-worktrees/wt-git-knot-preview/wt-${mockWorktreeSlug(branch.name)}-${suffix}`;
      return {
        branch: branch.name,
        branchFullName: branch.fullName,
        headOid: branch.oid,
        targetPath,
        token: mockStableUuid(
          JSON.stringify({ branchFullName: branch.fullName, headOid: branch.oid, targetPath }),
        ),
      };
    });
}

function cloneWorktrees() {
  const worktrees = mockWorktrees.map((worktree) => ({
    ...worktree,
    token: mockWorktreeToken(worktree),
  }));
  return {
    worktrees,
    createCandidates: mockWorktreeCreateCandidates(),
    pruneToken: mockStableUuid(
      JSON.stringify({ kind: "prune-worktrees-v1", tokens: worktrees.map((item) => item.token) }),
    ),
  };
}

function requireMockWorktreeCreateCandidate(branchFullName: string, expectedToken: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(expectedToken)) {
    throw mockError("invalid_worktree_token", "worktree 确认令牌无效");
  }
  if (!branchFullName.startsWith("refs/heads/") || /[\u0000-\u001f\u007f]/u.test(branchFullName)) {
    throw mockError("invalid_branch_selector", "要创建 worktree 的本地分支标识无效");
  }
  const candidate = mockWorktreeCreateCandidates().find(
    (item) => item.branchFullName === branchFullName,
  );
  if (!candidate) {
    throw mockError(
      "worktree_create_unavailable",
      "该本地分支已被检出、目标目录已占用或分支已发生变化，请刷新后重试",
    );
  }
  if (candidate.token !== expectedToken) {
    throw mockError(
      "worktree_create_snapshot_changed",
      "本地分支或创建目标已发生变化，请刷新后重试",
    );
  }
  return candidate;
}

function requireMockWorktree(worktreePath: string, expectedToken: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(expectedToken)) {
    throw mockError("invalid_worktree_token", "worktree 确认令牌无效");
  }
  if (!worktreePath.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(worktreePath)) {
    throw mockError("invalid_worktree_path", "关联 worktree 路径格式无效");
  }
  const worktree = mockWorktrees.find((candidate) => candidate.path === worktreePath);
  if (!worktree) {
    throw mockError("worktree_not_found", "该关联 worktree 已不存在，请刷新后重试");
  }
  if (mockWorktreeToken(worktree) !== expectedToken) {
    throw mockError("worktree_snapshot_changed", "关联 worktree 状态已被外部修改，请刷新后重试");
  }
  if (worktree.isMain) {
    throw mockError("main_worktree_immutable", "主 worktree 不能在此锁定或解锁");
  }
  if (worktree.bare) {
    throw mockError("bare_worktree_unsupported", "当前不支持管理 bare worktree");
  }
  if (worktree.prunable) {
    throw mockError(
      "prunable_worktree_unsupported",
      "该 worktree 记录已失效，请先使用 Git 修复或清理",
    );
  }
  return worktree;
}

function validateMockHistoryText(value: string, label: string) {
  const normalized = value.trim();
  if ([...normalized].length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw mockError("invalid_history_query", `${label}筛选不能包含控制字符且不能超过 256 个字符`);
  }
  return normalized;
}

function validateMockHistoryDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw mockError("invalid_history_date", `${label}必须使用 YYYY-MM-DD 格式`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day));
  if (
    year === 0 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month! - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw mockError("invalid_history_date", `${label}不是有效日期`);
  }
  return value;
}

function queryMockHistory(query: HistoryQuery) {
  if (query.limit < 1 || query.limit > 200) {
    throw mockError("invalid_history_limit", "提交历史每次只能读取 1 到 200 条");
  }
  const search = validateMockHistoryText(query.search, "提交信息").toLocaleLowerCase();
  const author = validateMockHistoryText(query.author, "作者").toLocaleLowerCase();
  const after = query.after ? validateMockHistoryDate(query.after.trim(), "开始日期") : null;
  const before = query.before ? validateMockHistoryDate(query.before.trim(), "结束日期") : null;
  if (after && before && after > before) {
    throw mockError("invalid_history_date_range", "开始日期不能晚于结束日期");
  }
  const filePath = query.filePath?.trim() || null;
  if (
    filePath &&
    (filePath.startsWith(":") ||
      filePath.startsWith("/") ||
      filePath.includes("\0") ||
      filePath
        .split("/")
        .some((component) => !component || component === "." || component === ".."))
  ) {
    throw mockError("invalid_repository_pathspec", "仓库文件路径格式无效");
  }

  const currentBranch = mockBranches.find((branch) => branch.current);
  let startOids = [currentBranch?.oid ?? mockCommits[0]?.oid].filter((oid): oid is string =>
    Boolean(oid),
  );
  if (currentBranch?.upstream && !currentBranch.upstreamMissing) {
    const upstreamBranch = mockBranches.find(
      (branch) =>
        branch.name === currentBranch.upstream && branch.fullName !== currentBranch.fullName,
    );
    if (upstreamBranch && !startOids.includes(upstreamBranch.oid)) {
      startOids.push(upstreamBranch.oid);
    }
  }
  if (query.refFullName) {
    const fullName = query.refFullName;
    const validNamespace = ["refs/heads/", "refs/remotes/", "refs/tags/"].some((prefix) =>
      fullName.startsWith(prefix),
    );
    if (!validNamespace || fullName.length > 1024 || /[\u0000-\u001f\u007f]/u.test(fullName)) {
      throw mockError(
        "invalid_history_ref",
        "历史范围只能选择本地分支、远端跟踪分支或标签的完整引用",
      );
    }
    const branch = mockBranches.find((candidate) => candidate.fullName === fullName);
    const tag = mockTags.find((candidate) => candidate.fullName === fullName);
    if (!branch && !tag) {
      throw mockError("history_ref_not_found", "所选历史引用已不存在，请刷新后重试");
    }
    const selectedOid = branch?.oid ?? tag?.targetOid;
    if (!selectedOid || !mockCommits.some((commit) => commit.oid === selectedOid)) {
      throw mockError("history_ref_not_commit", "所选历史引用没有指向提交对象");
    }
    startOids = [selectedOid];
  }

  const reachable = new Set(startOids.flatMap((oid) => [...mockCommitAncestors(oid)]));

  const filtered = mockCommits.filter((commit) => {
    const authorText = `${commit.authorName} ${commit.authorEmail}`.toLocaleLowerCase();
    const authoredDate = commit.authoredAt.slice(0, 10);
    return (
      reachable.has(commit.oid) &&
      (!search || commit.subject.toLocaleLowerCase().includes(search)) &&
      (!author || authorText.includes(author)) &&
      (!after || authoredDate >= after) &&
      (!before || authoredDate <= before) &&
      (!filePath || (mockCommitPaths.get(commit.oid) ?? []).includes(filePath))
    );
  });
  const requested = filtered.slice(query.offset, query.offset + query.limit + 1);
  const hasMore = requested.length > query.limit;
  const commits = requested.slice(0, query.limit).map((commit) => ({
    ...commit,
    parentOids: [...commit.parentOids],
  }));
  return {
    commits,
    hasMore,
    nextOffset: query.offset + commits.length,
  };
}

function mockCommitAncestors(oid: string) {
  const ancestors = new Set<string>();
  const pending = [oid];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    const commit = mockCommits.find((candidate) => candidate.oid === current);
    if (commit) pending.push(...commit.parentOids);
  }
  return ancestors;
}

function previewMockLocalMerge(targetFullName: string): LocalMergePreview {
  if (!targetFullName.startsWith("refs/heads/")) {
    throw mockError("local_branch_required", "只能合并已读取的本地分支");
  }
  if (mockChanges.some((change) => change.kind === "unmerged")) {
    throw mockError("repository_has_conflicts", "仓库存在未解决的冲突，解决冲突后才能合并分支");
  }
  if (mockChanges.length > 0) {
    throw mockError(
      "local_merge_dirty_worktree",
      "合并前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
    );
  }
  const current = mockBranches.find((branch) => branch.kind === "local" && branch.current);
  if (!current) {
    throw mockError(
      "local_merge_current_branch_required",
      "当前 HEAD 未附着到本地分支，不能执行本地分支合并",
    );
  }
  const target = mockBranches.find((branch) => branch.fullName === targetFullName);
  if (!target) throw mockError("branch_not_found", "该分支已不存在，请刷新后重试");
  if (target.kind !== "local") {
    throw mockError("local_branch_required", "只能合并已读取的本地分支");
  }
  if (target.current) {
    throw mockError("local_merge_same_branch", "不能把当前分支合并到自身");
  }

  const currentAncestors = mockCommitAncestors(current.oid);
  const targetAncestors = mockCommitAncestors(target.oid);
  if (![...currentAncestors].some((oid) => targetAncestors.has(oid))) {
    throw mockError(
      "local_merge_unrelated_history",
      "两个本地分支没有共同祖先，不支持合并无关历史",
    );
  }
  const ahead = [...currentAncestors].filter((oid) => !targetAncestors.has(oid)).length;
  const behind = [...targetAncestors].filter((oid) => !currentAncestors.has(oid)).length;
  return {
    currentBranch: current.name,
    currentFullName: current.fullName,
    currentOid: current.oid,
    targetBranch: target.name,
    targetFullName: target.fullName,
    targetOid: target.oid,
    mode: behind === 0 ? "up_to_date" : ahead === 0 ? "fast_forward" : "merge_commit",
    ahead,
    behind,
  };
}

function previewMockRevert(path: string, targetOid: string): RevertCommitPreview {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(targetOid)) {
    throw mockError("invalid_commit_oid", "提交标识格式无效");
  }
  if (mockMergeRecoveryStates.has(path)) {
    throw mockError(
      "revert_operation_in_progress",
      "仓库存在尚未完成的 merge、rebase、cherry-pick 或 revert，不能撤销提交",
    );
  }
  if (mockChanges.length > 0) {
    throw mockError(
      "revert_dirty_worktree",
      "撤销提交前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
    );
  }
  const current = mockBranches.find((branch) => branch.kind === "local" && branch.current);
  if (!current) {
    throw mockError("revert_local_branch_required", "只能在 attached 本地分支上撤销提交");
  }
  const target = mockCommits.find((commit) => commit.oid === targetOid);
  if (!target || !mockCommitAncestors(current.oid).has(target.oid)) {
    throw mockError("revert_target_not_in_history", "只能撤销当前分支历史中的提交");
  }
  if (target.parentOids.length !== 1) {
    throw mockError(
      "revert_merge_commit_unsupported",
      "当前只支持撤销单父提交，暂不支持撤销 merge commit",
    );
  }
  const targetParentOid = target.parentOids[0]!;
  return {
    currentBranch: current.name,
    currentOid: current.oid,
    targetOid: target.oid,
    targetParentOid,
    targetSubject: target.subject,
    token: mockStableUuid(
      JSON.stringify({
        kind: "revert-commit-v1",
        currentBranch: current.fullName,
        currentOid: current.oid,
        targetOid: target.oid,
        targetParentOid,
        targetSubject: target.subject,
      }),
    ),
  };
}

function previewMockCherryPick(path: string, targetOid: string): CherryPickCommitPreview {
  if (!isValidMockCommitOid(targetOid)) {
    throw mockError("invalid_commit_oid", "提交标识格式无效");
  }
  if (mockMergeRecoveryStates.has(path)) {
    throw mockError(
      "history_mutation_in_progress",
      "仓库存在尚未完成的 Git 操作，不能执行 Cherry-pick",
    );
  }
  if (mockChanges.length > 0) {
    throw mockError(
      "cherry_pick_dirty_worktree",
      "Cherry-pick 前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
    );
  }
  const current = mockBranches.find((branch) => branch.kind === "local" && branch.current);
  if (!current) {
    throw mockError(
      "cherry_pick_local_branch_required",
      "只能在 attached 本地分支上 Cherry-pick 提交",
    );
  }
  const target = mockCommits.find((commit) => commit.oid === targetOid);
  if (!target) throw mockError("commit_not_found", "提交已不存在，请刷新提交历史后重试");
  if (target.parentOids.length !== 1) {
    throw mockError(
      "cherry_pick_merge_commit_unsupported",
      "当前只支持 Cherry-pick 单父提交，暂不支持 merge commit",
    );
  }
  return {
    currentBranch: current.name,
    currentOid: current.oid,
    targetOid: target.oid,
    targetSubject: target.subject,
    token: mockStableUuid(
      JSON.stringify({
        kind: "cherry-pick-commit-v1",
        currentBranch: current.fullName,
        currentOid: current.oid,
        targetOid: target.oid,
        targetSubject: target.subject,
      }),
    ),
  };
}

function previewMockReset(
  path: string,
  selectedOid: string,
  mode: ResetCommitMode,
): ResetCommitPreview {
  if (!isValidMockCommitOid(selectedOid)) {
    throw mockError("invalid_commit_oid", "提交标识格式无效");
  }
  if (mockMergeRecoveryStates.has(path)) {
    throw mockError(
      "history_mutation_in_progress",
      "仓库存在尚未完成的 Git 操作，不能执行重置提交",
    );
  }
  if (mockChanges.length > 0) {
    throw mockError(
      "reset_dirty_worktree",
      "重置提交前工作区和暂存区必须完全干净，请先提交或储藏本地更改",
    );
  }
  const current = mockBranches.find((branch) => branch.kind === "local" && branch.current);
  if (!current) {
    throw mockError(
      "reset_local_branch_required",
      "只能重置 attached 本地分支，请先切换到本地分支",
    );
  }
  const selected = mockCommits.find((commit) => commit.oid === selectedOid);
  if (!selected) throw mockError("commit_not_found", "提交已不存在，请刷新提交历史后重试");
  const selectedIsHead = selected.oid === current.oid;
  const targetOid = selectedIsHead ? selected.parentOids[0] : selected.oid;
  if (!targetOid) {
    throw mockError("reset_root_commit_unsupported", "根提交没有父提交，不能通过此操作撤销");
  }
  const publishedRefs = mockBranches.filter(
    (branch) => branch.kind === "remote" && mockCommitAncestors(branch.oid).has(current.oid),
  );
  if (publishedRefs.length > 0) {
    throw mockError(
      "reset_published_history",
      "当前 HEAD 已被远端分支或标签引用，禁止重置已发布历史；请改用 Revert",
    );
  }
  return {
    currentBranch: current.name,
    currentOid: current.oid,
    selectedOid: selected.oid,
    selectedSubject: selected.subject,
    targetOid,
    selectedIsHead,
    mode,
    token: mockStableUuid(
      JSON.stringify({
        kind: "reset-commit-v1",
        currentBranch: current.fullName,
        currentOid: current.oid,
        selectedOid: selected.oid,
        targetOid,
        mode,
        changes: mockChanges,
      }),
    ),
  };
}

function applyMockLocalMerge(preview: LocalMergePreview, strategy: LocalMergeStrategy) {
  if (preview.mode === "up_to_date") return;
  if (strategy === "fast_forward_only" && preview.mode === "merge_commit") {
    throw mockError(
      "local_merge_not_fast_forward",
      "所选分支与当前分支已经分叉，无法执行仅快进合并",
    );
  }
  if (strategy === "fast_forward_only") {
    mockBranches = mockBranches.map((branch) =>
      branch.fullName === preview.currentFullName ? { ...branch, oid: preview.targetOid } : branch,
    );
    return;
  }

  const oid = (++mockMergeSequence).toString(16).padStart(40, "0");
  mockCommitPaths.set(oid, []);
  mockCommits = [
    {
      oid,
      parentOids: [preview.currentOid, preview.targetOid],
      authorName: "git-knot",
      authorEmail: "dev@example.com",
      authoredAt: new Date().toISOString(),
      subject: `Merge branch '${preview.targetBranch}'`,
    },
    ...mockCommits,
  ];
  mockBranches = mockBranches.map((branch) =>
    branch.fullName === preview.currentFullName ? { ...branch, oid } : branch,
  );
}

function cloneTags() {
  return { tags: mockTags.map((tag) => ({ ...tag })) };
}

function cloneStashes() {
  return { stashes: mockStashes.map((stash) => ({ ...stash })) };
}

function reindexMockStashes() {
  mockStashes = mockStashes.map((stash, index) => ({
    ...stash,
    selector: `stash@{${index}}`,
  }));
}

function isExactMockOid(oid: string) {
  return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(oid);
}

function findMockStash(oid: string) {
  if (!isExactMockOid(oid)) throw new Error("储藏对象标识格式无效");
  const matches = mockStashes.filter((stash) => stash.oid.toLowerCase() === oid.toLowerCase());
  if (matches.length === 0) throw new Error("该储藏已不存在，请刷新后重试");
  if (matches.length > 1) throw new Error("多个储藏具有相同对象标识，无法安全确定目标");
  return matches[0];
}

function applyMockStash(path: string, oid: string, restoreIndex: boolean) {
  const stash = findMockStash(oid);
  if (mockChanges.some((change) => change.kind === "unmerged")) {
    throw new Error("仓库存在未解决的冲突，解决冲突后才能恢复储藏");
  }
  const saved = mockStashChanges.get(stash.oid) ?? [];
  const overlapping = saved.find((change) =>
    mockChanges.some((current) => current.path === change.path),
  );
  if (overlapping) {
    const currentBranch = mockBranches.find((branch) => branch.current);
    mockMergeRecoveryStates.set(path, {
      currentBranch: currentBranch?.name ?? null,
      headOid: currentBranch?.oid ?? mockCommits[0]?.oid ?? "0".repeat(40),
      mergeHeadOid: stash.oid,
      beforeChanges: mockChanges.map((change) => ({ ...change })),
    });
    mockChanges = mockChanges.map((change) =>
      change.path === overlapping.path
        ? { ...change, kind: "unmerged", indexStatus: "U", worktreeStatus: "U" }
        : change,
    );
    throw Object.assign(new Error("应用储藏时产生冲突；该储藏仍然保留，请解决冲突后再处理"), {
      code: "stash_apply_conflict",
    });
  }
  mockChanges = [
    ...mockChanges,
    ...saved.map((change) => ({
      ...change,
      indexStatus: restoreIndex || change.kind === "untracked" ? change.indexStatus : null,
      worktreeStatus:
        change.kind === "untracked"
          ? change.worktreeStatus
          : (change.worktreeStatus ?? change.indexStatus),
    })),
  ];
  return { stash, status: cloneStatus(path) };
}

function cloneStatus(path: string): RepositoryStatus {
  const currentBranch = mockBranches.find((branch) => branch.current);
  return {
    root: path,
    branch: {
      head: currentBranch?.name ?? null,
      oid: currentBranch?.oid ?? mockCommits[0]?.oid ?? null,
      upstream: currentBranch?.upstream ?? null,
      ahead: currentBranch?.ahead ?? 0,
      behind: currentBranch?.behind ?? 0,
    },
    changes: mockChanges.map((change) => ({ ...change })),
  };
}

function conflictResolutionRequired() {
  return mockError("conflict_resolution_required", "仓库存在未解决冲突，请先通过冲突解决流程处理");
}

function rejectAnyMockConflict() {
  if (mockChanges.some((change) => change.kind === "unmerged")) {
    throw conflictResolutionRequired();
  }
}

function rejectTargetedMockConflicts(paths: string[]) {
  if (mockChanges.some((change) => change.kind === "unmerged" && matchesPaths(change, paths))) {
    throw conflictResolutionRequired();
  }
}

function mockConflictToken(change: FileChange) {
  const source = `${change.path}\0${change.indexStatus ?? ""}\0${change.worktreeStatus ?? ""}`;
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `00000000-0000-5000-8000-${(hash >>> 0).toString(16).padStart(8, "0")}0000`;
}

function mockConflictDetails(change: FileChange): ConflictDetails {
  return {
    path: change.path,
    current: {
      exists: true,
      content: `// 当前侧（Git stage 2）\n// ${change.path}\nexport const version = "current";\n`,
    },
    incoming: {
      exists: true,
      content: `// 传入侧（Git stage 3）\n// ${change.path}\nexport const version = "incoming";\n`,
    },
    isBinary: false,
    contentTruncated: false,
    resolvable: true,
    unsupportedReason: null,
    token: mockConflictToken(change),
  };
}

function mockMergeRecoveryToken(path: string, state: MockMergeRecoveryState) {
  const source = JSON.stringify({
    path,
    currentBranch: state.currentBranch,
    headOid: state.headOid,
    mergeHeadOid: state.mergeHeadOid,
    changes: mockChanges,
  });
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `00000000-0000-5000-8000-${(hash >>> 0).toString(16).padStart(8, "0")}0000`;
}

function previewMockMergeRecovery(path: string): MergeRecoveryPreview | null {
  const state = mockMergeRecoveryStates.get(path);
  if (!state) return null;
  const unresolvedConflictCount = mockChanges.filter((change) => change.kind === "unmerged").length;
  const hasUnstagedChanges = mockChanges.some(
    (change) => change.kind === "untracked" || change.worktreeStatus !== null,
  );
  return {
    currentBranch: state.currentBranch,
    headOid: state.headOid,
    mergeHeadOid: state.mergeHeadOid,
    unresolvedConflictCount,
    hasUnstagedChanges,
    canContinue: unresolvedConflictCount === 0 && !hasUnstagedChanges,
    token: mockMergeRecoveryToken(path, state),
  };
}

function requireMockMergeRecovery(path: string, expectedToken: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(expectedToken)) {
    throw mockError("invalid_merge_recovery_token", "合并恢复确认令牌无效");
  }
  const state = mockMergeRecoveryStates.get(path);
  if (!state) {
    throw mockError("merge_not_in_progress", "当前仓库没有正在进行的合并，请刷新后重试");
  }
  if (mockMergeRecoveryToken(path, state) !== expectedToken) {
    throw mockError(
      "merge_recovery_changed",
      "合并状态、暂存内容或工作区已发生变化，请刷新后重新确认",
    );
  }
  return state;
}

function resolveMockConflictChoice(choice: ConflictResolutionChoice) {
  return choice === "current" ? "M" : "A";
}

function matchesPaths(change: FileChange, paths: string[]) {
  return (
    paths.includes(change.path) ||
    Boolean(change.originalPath && paths.includes(change.originalPath))
  );
}

function stageChange(change: FileChange): FileChange {
  if (change.kind === "untracked") {
    return { ...change, kind: "ordinary", indexStatus: "A", worktreeStatus: null };
  }
  if (!change.worktreeStatus) return change;
  return { ...change, indexStatus: change.worktreeStatus, worktreeStatus: null };
}

function unstageChange(change: FileChange): FileChange {
  if (!change.indexStatus) return change;
  if (change.indexStatus === "A" && !change.worktreeStatus) {
    return { ...change, kind: "untracked", indexStatus: null, worktreeStatus: null };
  }
  return {
    ...change,
    indexStatus: null,
    worktreeStatus: change.worktreeStatus ?? change.indexStatus,
  };
}

export function applyMockDiscard(change: FileChange): FileChange | null {
  if (change.kind === "unmerged") {
    throw new Error("冲突文件不能直接放弃，请先解决冲突");
  }
  if (change.kind === "untracked") return null;
  if (!change.worktreeStatus) {
    throw new Error("该文件没有可放弃的未暂存更改");
  }
  if (change.indexStatus) return { ...change, worktreeStatus: null };
  return null;
}

export function applyMockDiscards(changes: FileChange[], filePaths: string[]): FileChange[] {
  if (filePaths.length === 0 || filePaths.length > 256) {
    throw new Error("每次只能操作 1 到 256 个仓库路径");
  }

  const requested = new Set<string>();
  const replacements = new Map<string, FileChange | null>();
  for (const filePath of filePaths) {
    if (requested.has(filePath)) throw new Error("批量放弃列表包含重复文件路径");
    requested.add(filePath);

    const change = changes.find((candidate) => candidate.path === filePath);
    if (!change) throw new Error(`${filePath} 已不在未提交更改中，请刷新后重试`);
    replacements.set(filePath, applyMockDiscard(change));
  }

  return changes.flatMap((change) => {
    if (!replacements.has(change.path)) return [change];
    const replacement = replacements.get(change.path);
    return replacement ? [replacement] : [];
  });
}

export function isValidMockBranchName(name: string) {
  const normalized = name.trim();
  const forbidden = ["~", "^", ":", "?", "*", "[", "\\"];
  return Boolean(
    normalized &&
    !/\s/.test(normalized) &&
    !normalized.startsWith("-") &&
    !normalized.startsWith("/") &&
    !normalized.endsWith("/") &&
    !normalized.endsWith(".") &&
    !normalized.endsWith(".lock") &&
    !normalized.includes("..") &&
    !normalized.includes("//") &&
    !normalized.includes("@{") &&
    !forbidden.some((character) => normalized.includes(character)),
  );
}

function isValidMockCommitOid(oid: string) {
  return (oid.length === 40 || oid.length === 64) && /^[0-9a-f]+$/i.test(oid);
}

export function isValidMockTagName(name: string) {
  const normalized = name.trim();
  const forbidden = ["~", "^", ":", "?", "*", "[", "\\"];
  const components = normalized.split("/");
  return Boolean(
    normalized &&
    new TextEncoder().encode(normalized).length <= 255 &&
    !/[\u0000-\u0020\u007f]/.test(normalized) &&
    !normalized.startsWith("/") &&
    !normalized.endsWith("/") &&
    !normalized.endsWith(".") &&
    !normalized.endsWith(".lock") &&
    !components.some((component) => component.startsWith(".")) &&
    !normalized.includes("..") &&
    !normalized.includes("//") &&
    !normalized.includes("@{") &&
    !forbidden.some((character) => normalized.includes(character)),
  );
}

function mockCloneTarget(remoteUrl: string, parentDirectory: string) {
  const value = remoteUrl.trim();
  if (
    !value ||
    value.length > 4096 ||
    value.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("远端仓库地址无效");
  }

  let host = "";
  let path = "";
  try {
    const url = new URL(value);
    if (
      !["https:", "ssh:", "git+ssh:"].includes(url.protocol) ||
      url.search ||
      url.hash ||
      url.password
    ) {
      throw new Error("只支持不含查询参数或密码的 HTTPS、SSH 仓库地址");
    }
    if (url.protocol === "https:" && url.username) {
      throw new Error("HTTPS 仓库地址不能包含用户名或凭据");
    }
    host = url.hostname;
    path = url.pathname;
  } catch (cause) {
    if (cause instanceof Error && !cause.message.includes("Invalid URL")) throw cause;
    const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^?#\\]+)$/.exec(value);
    if (!match) throw new Error("只支持 HTTPS、SSH 或 user@host:path 形式的仓库地址");
    host = match[2];
    path = match[3];
  }

  const normalizedHost = host.replace(/\.$/, "").toLowerCase();
  if (normalizedHost === "gitee.com" || normalizedHost.endsWith(".gitee.com")) {
    throw new Error("当前项目不支持 Gitee 仓库");
  }
  const rawName = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.startsWith("-") ||
    name.includes("%") ||
    name.length > 255
  ) {
    throw new Error("无法从远端地址推导安全的仓库目录名");
  }
  const parent = parentDirectory.replace(/[\\/]+$/, "");
  if (!parent) throw new Error("克隆目标必须是已存在的目录");
  return { name, path: `${parent}/${name}` };
}

function fileChangesForCommit(): CommitFileChange[] {
  return mockChanges
    .filter((change) => Boolean(change.indexStatus))
    .map((change) => ({
      status: change.indexStatus ?? "M",
      path: change.path,
      originalPath: change.originalPath,
    }));
}

function mockAmendBlockingRefs(headOid: string) {
  const blocking = mockBranches
    .filter((branch) => branch.kind === "remote" && mockCommitAncestors(branch.oid).has(headOid))
    .map((branch) => branch.fullName);
  blocking.push(...mockTags.filter((tag) => tag.targetOid === headOid).map((tag) => tag.fullName));
  return [...new Set(blocking)].sort();
}

function mockAmendToken(branch: BranchInfo, commit: CommitSummary, blockingRefs: string[]) {
  const material = JSON.stringify({
    branch: branch.fullName,
    headOid: commit.oid,
    subject: commit.subject,
    body: mockCommitBodies.get(commit.oid) ?? "",
    blockingRefs,
    index: mockChanges.map((change) => ({
      path: change.path,
      originalPath: change.originalPath,
      indexStatus: change.indexStatus,
      kind: change.kind,
    })),
  });
  let hash = 2166136261;
  for (const character of material) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `mock-amend-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function previewMockAmend(path: string): AmendCommitPreview {
  rejectAnyMockConflict();
  if (mockMergeRecoveryStates.has(path)) {
    throw mockError(
      "amend_operation_in_progress",
      "仓库存在尚未完成的 merge、rebase、cherry-pick 或 revert，不能修改 HEAD 提交",
    );
  }
  const branch = mockBranches.find((candidate) => candidate.current && candidate.kind === "local");
  if (!branch) {
    throw mockError("amend_detached_head", "Detached HEAD 不支持安全修改提交，请先切换到本地分支");
  }
  const commit = mockCommits.find((candidate) => candidate.oid === branch.oid);
  if (!commit) {
    throw mockError("amend_no_head_commit", "当前分支还没有提交，无法执行 Amend");
  }
  const blockingRefs = mockAmendBlockingRefs(commit.oid);
  return {
    currentBranch: branch.name,
    headOid: commit.oid,
    currentSubject: commit.subject,
    currentBody: mockCommitBodies.get(commit.oid) ?? "",
    stagedChangeCount: mockChanges.filter((change) => Boolean(change.indexStatus)).length,
    blockingRefs,
    canAmend: blockingRefs.length === 0,
    token: mockAmendToken(branch, commit, blockingRefs),
  };
}

export const webMockBridge: DesktopApi = {
  projects: {
    async list() {
      return mockProjects.map((project) => ({ ...project }));
    },
    async pickRepository() {
      return mockProject.path;
    },
    async pickCloneParentDirectory() {
      return "/Users/demo/projects";
    },
    async pickScanParentDirectory() {
      return "/Users/demo/projects";
    },
    async add(path) {
      const existing = mockProjects.find((item) => item.path === path);
      const project = {
        ...mockProject,
        id: `mock-${path}`,
        name: path.split(/[\\/]/).at(-1) || "Repository",
        path,
        addedAt: Date.now(),
        favorite: existing?.favorite ?? false,
        group: existing?.group ?? null,
      };
      mockProjects = [project, ...mockProjects.filter((item) => item.path !== path)];
      return { ...project };
    },
    async scan(_parentDirectory) {
      return mockProjects.map((project) => ({ ...project }));
    },
    async remove(id) {
      const previousLength = mockProjects.length;
      mockProjects = mockProjects.filter((project) => project.id !== id);
      if (mockProjects.length === previousLength) {
        throw new Error("项目不存在，请刷新后重试");
      }
    },
    async updateMetadata(input) {
      const project = mockProjects.find((item) => item.id === input.id);
      if (!project) throw new Error("项目不存在，请刷新后重试");
      const group = input.group?.trim() || null;
      if (
        group &&
        ([...group].length > 40 || [...group].some((character) => /\p{Cc}/u.test(character)))
      ) {
        throw new Error("项目分组不能包含控制字符，且最多 40 个字符");
      }
      const updated = { ...project, favorite: input.favorite, group };
      mockProjects = mockProjects.map((item) => (item.id === updated.id ? updated : item));
      return { ...updated };
    },
    async clone(remoteUrl, parentDirectory) {
      const target = mockCloneTarget(remoteUrl, parentDirectory);
      if (mockProjects.some((project) => project.path === target.path)) {
        throw new Error(`目标目录 ${target.name} 已存在，请选择其他位置`);
      }
      const operationId = `mock-clone-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: target.path,
        kind: "clone",
        cancelMessage: "已取消克隆仓库",
      });
      emitMockOperation({
        operationId,
        repositoryPath: target.path,
        kind: "clone",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待克隆 ${target.name}`,
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: target.path,
            kind: "clone",
            state: "running",
            phase: "connecting",
            percent: null,
            message: "正在连接远端仓库",
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: target.path,
            kind: "clone",
            state: "progress",
            phase: "receiving",
            percent: 64,
            message: "正在接收远端对象",
          });
        },
        180,
      );
      scheduleMockOperation(
        operationId,
        () => {
          const project: Project = {
            id: `mock-${target.path}`,
            name: target.name,
            path: target.path,
            addedAt: Date.now(),
            favorite: false,
            group: null,
          };
          mockProjects = [project, ...mockProjects.filter((item) => item.path !== target.path)];
          emitMockOperation({
            operationId,
            repositoryPath: target.path,
            kind: "clone",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: "仓库已克隆并添加到项目列表",
          });
          finishMockOperation(operationId);
        },
        420,
      );
      return { operationId, repositoryPath: target.path };
    },
  },
  repository: {
    async gitVersion() {
      return { raw: "Browser preview", version: "不可用" };
    },
    async status(path) {
      return cloneStatus(path);
    },
    async history(_path, query) {
      return queryMockHistory(query);
    },
    async commit(_path, oid) {
      const commit = mockCommits.find((item) => item.oid === oid) ?? mockCommits[0];
      return {
        commit: { ...commit },
        body: mockCommitBodies.get(commit.oid) ?? "",
        files: [
          {
            status: "A",
            path: "src/features/history/HistoryView.tsx",
            originalPath: null,
          },
          {
            status: "M",
            path: "src/platform/desktop/contract.ts",
            originalPath: null,
          },
        ],
        patch: [
          "diff --git a/src/features/history/HistoryView.tsx b/src/features/history/HistoryView.tsx",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/features/history/HistoryView.tsx",
          "@@ -0,0 +1,3 @@",
          "+export function HistoryView() {",
          "+  return <section>History</section>;",
          "+}",
          "diff --git a/src/platform/desktop/contract.ts b/src/platform/desktop/contract.ts",
          "--- a/src/platform/desktop/contract.ts",
          "+++ b/src/platform/desktop/contract.ts",
          "@@ -20,4 +20,5 @@ export interface RepositoryApi {",
          "   history(path: string, query: HistoryQuery): Promise<HistoryPage>;",
          "+  commit(path: string, oid: string): Promise<CommitDetails>;",
          "   worktreeDiff(path: string, filePath: string, staged: boolean): Promise<WorktreeDiff>;",
        ].join("\n"),
        patchTruncated: false,
      };
    },
    async commitImageDiff() {
      return null;
    },
    async worktreeDiff(_path, filePath, staged) {
      return {
        path: filePath,
        staged,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -1,2 +1,3 @@",
          " export const desktopApi = {",
          staged ? "+  history: true," : "+  workspaceDiff: true,",
          " };",
        ].join("\n"),
        patchTruncated: false,
        image: null,
      };
    },
    async conflictDetails(_path, filePath) {
      const change = mockChanges.find(
        (candidate) => candidate.path === filePath && candidate.kind === "unmerged",
      );
      if (!change) {
        throw mockError("conflict_not_found", "该文件已不再处于冲突状态，请刷新后重试");
      }
      return mockConflictDetails(change);
    },
    async resolveConflict(path, filePath, input) {
      const index = mockChanges.findIndex(
        (candidate) => candidate.path === filePath && candidate.kind === "unmerged",
      );
      if (index < 0) {
        throw mockError("conflict_not_found", "该文件已不再处于冲突状态，请刷新后重试");
      }
      const change = mockChanges[index]!;
      if (input.expectedToken !== mockConflictToken(change)) {
        throw mockError("conflict_snapshot_changed", "冲突文件已被外部修改，请重新打开后再解决");
      }
      mockChanges = mockChanges.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? {
              ...candidate,
              kind: "ordinary",
              indexStatus: resolveMockConflictChoice(input.choice),
              worktreeStatus: null,
            }
          : candidate,
      );
      return { status: cloneStatus(path) };
    },
    async previewMergeRecovery(path) {
      return previewMockMergeRecovery(path);
    },
    async continueMergeRecovery(path, input) {
      const state = requireMockMergeRecovery(path, input.expectedToken);
      const preview = previewMockMergeRecovery(path)!;
      if (preview.unresolvedConflictCount > 0) {
        throw mockError(
          "merge_conflicts_unresolved",
          "仍有冲突文件未解决，请解决全部冲突后再继续合并",
        );
      }
      if (preview.hasUnstagedChanges) {
        throw mockError(
          "merge_worktree_not_clean",
          "工作区仍有未暂存或未跟踪更改，请先处理后再继续合并",
        );
      }

      const oid = (++mockMergeSequence).toString(16).padStart(40, "0");
      const changedPaths = [...new Set(mockChanges.map((change) => change.path))];
      const commit: CommitSummary = {
        oid,
        parentOids: [state.headOid, state.mergeHeadOid],
        authorName: "git-knot",
        authorEmail: "dev@example.com",
        authoredAt: new Date().toISOString(),
        subject: "Merge recovery preview",
      };
      mockCommitPaths.set(oid, changedPaths);
      mockCommits = [commit, ...mockCommits];
      mockBranches = mockBranches.map((branch) => (branch.current ? { ...branch, oid } : branch));
      mockChanges = [];
      mockMergeRecoveryStates.delete(path);
      return { status: cloneStatus(path) };
    },
    async abortMergeRecovery(path, input) {
      const state = requireMockMergeRecovery(path, input.expectedToken);
      mockChanges = state.beforeChanges.map((change) => ({ ...change }));
      mockMergeRecoveryStates.delete(path);
      return { status: cloneStatus(path) };
    },
    async refs() {
      return cloneRefs();
    },
    async worktrees() {
      return cloneWorktrees();
    },
    async createLinkedWorktree(_path, input) {
      const candidate = requireMockWorktreeCreateCandidate(
        input.branchFullName,
        input.expectedToken,
      );
      mockWorktrees = [
        ...mockWorktrees,
        {
          path: candidate.targetPath,
          headOid: candidate.headOid,
          branch: candidate.branch,
          branchFullName: candidate.branchFullName,
          detached: false,
          bare: false,
          locked: false,
          lockReason: null,
          prunable: false,
          prunableReason: null,
          isMain: false,
        },
      ];
      return cloneWorktrees();
    },
    async lockWorktree(_path, input) {
      const worktree = requireMockWorktree(input.worktreePath, input.expectedToken);
      if (worktree.locked) {
        throw mockError("worktree_already_locked", "该关联 worktree 已锁定，请刷新后重试");
      }
      const reason = input.reason?.trim() || null;
      if (reason && ([...reason].length > 256 || /[\u0000-\u001f\u007f]/u.test(reason))) {
        throw mockError(
          "invalid_worktree_lock_reason",
          "锁定原因不能包含控制字符且不能超过 256 个字符",
        );
      }
      mockWorktrees = mockWorktrees.map((candidate) =>
        candidate.path === worktree.path
          ? { ...candidate, locked: true, lockReason: reason }
          : candidate,
      );
      return cloneWorktrees();
    },
    async unlockWorktree(_path, input) {
      const worktree = requireMockWorktree(input.worktreePath, input.expectedToken);
      if (!worktree.locked) {
        throw mockError("worktree_not_locked", "该关联 worktree 未锁定，请刷新后重试");
      }
      mockWorktrees = mockWorktrees.map((candidate) =>
        candidate.path === worktree.path
          ? { ...candidate, locked: false, lockReason: null }
          : candidate,
      );
      return cloneWorktrees();
    },
    async pruneWorktrees(_path, input) {
      const snapshot = cloneWorktrees();
      if (!snapshot.worktrees.some((worktree) => worktree.prunable)) {
        throw mockError("no_prunable_worktrees", "当前没有可清理的失效 worktree 记录");
      }
      if (snapshot.pruneToken !== input.expectedToken) {
        throw mockError(
          "worktree_snapshot_changed",
          "关联 worktree 清单已被外部修改，请刷新后重试",
        );
      }
      mockWorktrees = mockWorktrees.filter((worktree) => !worktree.prunable);
      return cloneWorktrees();
    },
    async previewRemoteEdit(_path, name) {
      const remote = findMockRemote(validateMockRemoteName(name));
      return { remote: { ...remote }, token: mockRemoteToken(remote) };
    },
    async previewRemoteDelete(_path, name) {
      const remote = findMockRemote(validateMockRemoteName(name));
      return {
        remote: { ...remote },
        affectedBranches: mockRemoteAffectedBranches(remote.name),
        token: mockRemoteToken(remote),
      };
    },
    async createRemote(path, input) {
      const name = validateMockRemoteName(input.name);
      const fetchUrl = validateMockRemoteUrl(input.fetchUrl);
      const pushUrl = input.pushUrl === null ? null : validateMockRemoteUrl(input.pushUrl);
      if (mockRemotes.some((remote) => remote.name === name)) {
        throw mockError("remote_already_exists", `远端 ${name} 已存在`);
      }
      if (mockRemotes.length >= 64) {
        throw mockError("too_many_remotes", "单个仓库最多配置 64 个远端");
      }
      mockRemotes = [
        ...mockRemotes,
        {
          name,
          fetchUrl: sanitizeMockRemoteUrl(fetchUrl),
          pushUrl: sanitizeMockRemoteUrl(pushUrl ?? fetchUrl),
          pushUrlOverridden: pushUrl !== null,
        },
      ].sort((left, right) => left.name.localeCompare(right.name));
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async updateRemote(path, input) {
      const name = validateMockRemoteName(input.name);
      if (input.newPushUrl !== null && input.resetPushUrl) {
        throw mockError("invalid_remote_update", "不能同时设置并重置 Push 地址");
      }
      if (input.newFetchUrl === null && input.newPushUrl === null && !input.resetPushUrl) {
        throw mockError("invalid_remote_update", "至少需要修改一个远端地址");
      }
      const remote = findMockRemote(name);
      if (mockRemoteToken(remote) !== input.expectedToken) {
        throw mockError("remote_snapshot_changed", "远端配置已被外部修改，请重新打开后再操作");
      }
      const fetchUrl =
        input.newFetchUrl === null
          ? remote.fetchUrl
          : sanitizeMockRemoteUrl(validateMockRemoteUrl(input.newFetchUrl));
      let pushUrl = remote.pushUrl;
      let pushUrlOverridden = remote.pushUrlOverridden;
      if (input.newPushUrl !== null) {
        pushUrl = sanitizeMockRemoteUrl(validateMockRemoteUrl(input.newPushUrl));
        pushUrlOverridden = true;
      } else if (input.resetPushUrl) {
        pushUrl = fetchUrl;
        pushUrlOverridden = false;
      } else if (!pushUrlOverridden) {
        pushUrl = fetchUrl;
      }
      mockRemotes = mockRemotes.map((candidate) =>
        candidate.name === name
          ? { ...candidate, fetchUrl, pushUrl, pushUrlOverridden }
          : candidate,
      );
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async deleteRemote(path, input) {
      const name = validateMockRemoteName(input.name);
      const remote = findMockRemote(name);
      if (mockRemoteToken(remote) !== input.expectedToken) {
        throw mockError(
          "remote_snapshot_changed",
          "远端配置或受影响分支已变化，请重新确认后再删除",
        );
      }
      mockRemotes = mockRemotes.filter((candidate) => candidate.name !== name);
      mockBranches = mockBranches
        .filter((branch) => !branch.fullName.startsWith(`refs/remotes/${name}/`))
        .map((branch) =>
          branch.kind === "local" && branch.upstream?.startsWith(`${name}/`)
            ? { ...branch, upstream: null, upstreamMissing: false, ahead: 0, behind: 0 }
            : branch,
        );
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async previewLocalMerge(_path, targetFullName) {
      return previewMockLocalMerge(targetFullName);
    },
    async previewRevert(path, targetOid) {
      return previewMockRevert(path, targetOid);
    },
    async revertCommit(path, input) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          input.expectedToken,
        )
      ) {
        throw mockError("invalid_revert_token", "撤销提交确认令牌无效");
      }
      const preview = previewMockRevert(path, input.targetOid);
      if (preview.token !== input.expectedToken) {
        throw mockError(
          "revert_snapshot_changed",
          "当前分支、提交历史或工作区已发生变化，请刷新后重试",
        );
      }
      const oid = (++mockRevertSequence).toString(16).padStart(40, "0");
      const commit: CommitSummary = {
        oid,
        parentOids: [preview.currentOid],
        authorName: "git-knot",
        authorEmail: "dev@example.com",
        authoredAt: new Date().toISOString(),
        subject: `Revert "${preview.targetSubject}"`,
      };
      mockCommitPaths.set(oid, [...(mockCommitPaths.get(preview.targetOid) ?? [])]);
      mockCommitBodies.set(oid, `This reverts commit ${preview.targetOid}.`);
      mockCommits = [commit, ...mockCommits];
      mockBranches = mockBranches.map((branch) =>
        branch.kind === "local" && branch.current
          ? { ...branch, oid, ahead: branch.upstream ? branch.ahead + 1 : branch.ahead }
          : branch,
      );
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async previewCherryPick(path, targetOid) {
      return previewMockCherryPick(path, targetOid);
    },
    async cherryPickCommit(path, input) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          input.expectedToken,
        )
      ) {
        throw mockError("invalid_cherry_pick_token", "Cherry-pick确认令牌无效");
      }
      const preview = previewMockCherryPick(path, input.targetOid);
      if (preview.token !== input.expectedToken) {
        throw mockError(
          "cherry_pick_snapshot_changed",
          "当前分支、提交历史或工作区已发生变化，请重新预览后再 Cherry-pick",
        );
      }
      const target = mockCommits.find((commit) => commit.oid === preview.targetOid)!;
      const oid = (++mockCherryPickSequence).toString(16).padStart(40, "0");
      const commit: CommitSummary = {
        ...target,
        oid,
        parentOids: [preview.currentOid],
        authoredAt: new Date().toISOString(),
      };
      mockCommitPaths.set(oid, [...(mockCommitPaths.get(preview.targetOid) ?? [])]);
      mockCommitBodies.set(oid, mockCommitBodies.get(preview.targetOid) ?? "");
      mockCommits = [commit, ...mockCommits];
      mockBranches = mockBranches.map((branch) =>
        branch.kind === "local" && branch.current
          ? { ...branch, oid, ahead: branch.upstream ? branch.ahead + 1 : branch.ahead }
          : branch,
      );
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async previewResetCommit(path, selectedOid, mode) {
      return previewMockReset(path, selectedOid, mode);
    },
    async resetCommit(path, input) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          input.expectedToken,
        )
      ) {
        throw mockError("invalid_reset_token", "重置提交确认令牌无效");
      }
      const preview = previewMockReset(path, input.selectedOid, input.mode);
      if (preview.token !== input.expectedToken) {
        throw mockError(
          "reset_snapshot_changed",
          "当前分支、提交历史、暂存区或工作区已发生变化，请重新预览后再重置",
        );
      }
      mockBranches = mockBranches.map((branch) =>
        branch.kind === "local" && branch.current
          ? { ...branch, oid: preview.targetOid, ahead: 0 }
          : branch,
      );
      if (input.mode === "hard") mockChanges = [];
      if (input.mode === "mixed") mockChanges = mockChanges.map(unstageChange);
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async tags() {
      return cloneTags();
    },
    async stashes() {
      return cloneStashes();
    },
    async submodules() {
      return cloneSubmodules();
    },
    async stage(path, paths) {
      rejectTargetedMockConflicts(paths);
      mockChanges = mockChanges.map((change) =>
        matchesPaths(change, paths) ? stageChange(change) : change,
      );
      return { status: cloneStatus(path) };
    },
    async stageAll(path) {
      rejectAnyMockConflict();
      mockChanges = mockChanges.map(stageChange);
      return { status: cloneStatus(path) };
    },
    async unstage(path, paths) {
      rejectTargetedMockConflicts(paths);
      mockChanges = mockChanges.map((change) =>
        matchesPaths(change, paths) ? unstageChange(change) : change,
      );
      return { status: cloneStatus(path) };
    },
    async unstageAll(path) {
      rejectAnyMockConflict();
      mockChanges = mockChanges.map(unstageChange);
      return { status: cloneStatus(path) };
    },
    async discardFiles(path, filePaths) {
      mockChanges = applyMockDiscards(mockChanges, filePaths);
      return { status: cloneStatus(path) };
    },
    async switchBranch(path, fullName) {
      const target = mockBranches.find((branch) => branch.fullName === fullName);
      if (!target) throw new Error("该分支已不存在，请刷新后重试");
      if (target.kind !== "local") {
        throw new Error("暂不支持直接切换远端分支，请先创建本地跟踪分支");
      }
      mockBranches = mockBranches.map((branch) => ({
        ...branch,
        current: branch.fullName === fullName,
      }));
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async createBranch(path, name) {
      const normalized = name.trim();
      if (!isValidMockBranchName(normalized)) {
        throw new Error("分支名不合法，请检查空格、连续点号或 Git 不允许的字符");
      }
      const fullName = `refs/heads/${normalized}`;
      if (mockBranches.some((branch) => branch.fullName === fullName)) {
        throw new Error(`fatal: a branch named '${normalized}' already exists`);
      }
      mockBranches = [
        {
          name: normalized,
          fullName,
          kind: "local",
          current: true,
          oid: mockCommits[0]?.oid ?? "0".repeat(40),
          upstream: null,
          upstreamMissing: false,
          ahead: 0,
          behind: 0,
        },
        ...mockBranches.map((branch) => ({ ...branch, current: false })),
      ];
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async createBranchAtCommit(path, input) {
      const normalized = input.name.trim();
      if (!isValidMockBranchName(normalized)) {
        throw mockError(
          "invalid_branch_name",
          "分支名不合法，请检查空格、连续点号或 Git 不允许的字符",
        );
      }
      if (!isValidMockCommitOid(input.targetOid)) {
        throw mockError("invalid_commit_oid", "提交标识格式无效");
      }
      const commit = mockCommits.find((item) => item.oid === input.targetOid);
      if (!commit) {
        throw mockError("branch_target_not_found", "分支目标提交已不存在，请刷新提交历史后重试");
      }
      const fullName = `refs/heads/${normalized}`;
      if (mockBranches.some((branch) => branch.fullName === fullName)) {
        throw mockError("local_branch_already_exists", `本地分支 ${normalized} 已存在`);
      }
      if (
        mockBranches.some(
          (branch) =>
            branch.kind === "local" &&
            (branch.fullName.startsWith(`${fullName}/`) ||
              fullName.startsWith(`${branch.fullName}/`)),
        )
      ) {
        throw mockError(
          "local_branch_name_conflict",
          "分支名与现有引用的路径冲突，请使用其他分支名",
        );
      }
      mockBranches = [
        {
          name: normalized,
          fullName,
          kind: "local",
          current: false,
          oid: commit.oid,
          upstream: null,
          upstreamMissing: false,
          ahead: 0,
          behind: 0,
        },
        ...mockBranches,
      ];
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async deleteBranch(path, fullName, allowUnmerged) {
      if (!fullName.startsWith("refs/heads/")) {
        throw new Error("只能删除已读取的本地分支");
      }
      const target = mockBranches.find((branch) => branch.fullName === fullName);
      if (!target) throw new Error("该分支已不存在，请刷新后重试");
      if (target.kind !== "local") throw new Error("只能删除已读取的本地分支");
      if (target.current) throw new Error("不能删除当前检出的分支，请先切换到其他本地分支");
      if (mockUnmergedBranches.has(fullName) && !allowUnmerged) {
        throw Object.assign(new Error("该本地分支尚未合并，需要再次确认后才能删除"), {
          code: "local_branch_not_merged",
        });
      }
      mockBranches = mockBranches.filter((branch) => branch.fullName !== fullName);
      mockUnmergedBranches.delete(fullName);
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async mergeLocalBranch(path, targetFullName, strategy) {
      const preview = previewMockLocalMerge(targetFullName);
      applyMockLocalMerge(preview, strategy);
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async createTag(_path, name, targetOid, message) {
      const normalized = name.trim();
      if (!isValidMockTagName(normalized)) {
        throw new Error("标签名不合法，请检查长度、空格或 Git 不允许的字符");
      }
      const commit = mockCommits.find((item) => item.oid === targetOid);
      if (!commit) throw new Error("标签目标提交已不存在，请刷新提交历史后重试");
      const fullName = `refs/tags/${normalized}`;
      if (mockTags.some((tag) => tag.fullName === fullName)) {
        throw new Error(`本地标签 ${normalized} 已存在`);
      }
      const annotation = message?.trim() ?? "";
      if (message !== null && !annotation) throw new Error("附注标签的说明不能为空");
      if (new TextEncoder().encode(annotation).length > 64 * 1024) {
        throw new Error("标签说明不能超过 64 KiB");
      }
      mockTags = [
        ...mockTags,
        {
          name: normalized,
          fullName,
          oid: annotation ? `${targetOid.slice(1)}${targetOid[0]}` : targetOid,
          targetOid,
          annotated: Boolean(annotation),
          subject: annotation ? annotation.split(/\r?\n/, 1)[0] : commit.subject,
          taggerDate: annotation ? new Date().toISOString() : null,
        },
      ].sort((left, right) => left.name.localeCompare(right.name));
      return { tags: cloneTags() };
    },
    async deleteTag(_path, fullName) {
      if (!fullName.startsWith("refs/tags/")) throw new Error("只能删除已读取的本地标签");
      if (!mockTags.some((tag) => tag.fullName === fullName)) {
        throw new Error("该标签已不存在，请刷新后重试");
      }
      mockTags = mockTags.filter((tag) => tag.fullName !== fullName);
      return { tags: cloneTags() };
    },
    async pushTag(path, input) {
      const operationId = `mock-tag-push-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "tag_push",
        cancelMessage: "已取消发布远端标签",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "tag_push",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待发布远端标签",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "tag_push",
            state: "running",
            phase: "pushing_tag",
            percent: null,
            message: `正在发布 ${input.fullName} 到远端 ${input.remoteName}`,
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          try {
            const tag = findExpectedMockTag(input.fullName, input.expectedLocalOid);
            const remote = findMockRemote(input.remoteName);
            validateMockRemoteUrl(remote.pushUrl);
            const key = mockRemoteTagKey(remote.name, tag.fullName);
            const remoteOid = mockRemoteTags.get(key);
            if (remoteOid && remoteOid.toLowerCase() !== tag.oid.toLowerCase()) {
              throw mockError(
                "remote_tag_already_exists",
                "远端已有不同的同名标签，安全发布不会覆盖它",
              );
            }
            mockRemoteTags.set(key, tag.oid);
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_push",
              state: "succeeded",
              phase: "completed",
              percent: 100,
              message: `已安全发布标签 ${tag.name} 到远端 ${remote.name}`,
            });
          } catch (cause) {
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_push",
              state: "failed",
              phase: "completed",
              percent: null,
              message: cause instanceof Error ? cause.message : "发布远端标签失败",
            });
          }
          finishMockOperation(operationId);
        },
        320,
      );
      return { operationId };
    },
    async previewRemoteTagDelete(path, input) {
      const operationId = `mock-tag-delete-preview-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "tag_delete_preview",
        cancelMessage: "已取消读取远端标签",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "tag_delete_preview",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待读取远端标签",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "tag_delete_preview",
            state: "running",
            phase: "reading_remote_tag",
            percent: null,
            message: `正在读取远端 ${input.remoteName} 的标签`,
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          try {
            const tag = findExpectedMockTag(input.fullName, input.expectedLocalOid);
            const remote = findMockRemote(input.remoteName);
            validateMockRemoteUrl(remote.pushUrl);
            const remoteOid = mockRemoteTags.get(mockRemoteTagKey(remote.name, tag.fullName));
            if (!remoteOid) {
              throw mockError("remote_tag_not_found", "该远端没有同名标签，无需删除");
            }
            const preview: RemoteTagDeletePreview = {
              remoteName: remote.name,
              name: tag.name,
              fullName: tag.fullName,
              localOid: tag.oid,
              remoteOid,
              token: mockRemoteTagDeleteToken(remote, tag.fullName, tag.oid, remoteOid),
            };
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_delete_preview",
              state: "succeeded",
              phase: "completed",
              percent: 100,
              message: `已读取远端标签 ${tag.name}`,
              remoteTagDeletePreview: preview,
            });
          } catch (cause) {
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_delete_preview",
              state: "failed",
              phase: "completed",
              percent: null,
              message: cause instanceof Error ? cause.message : "读取远端标签失败",
            });
          }
          finishMockOperation(operationId);
        },
        320,
      );
      return { operationId };
    },
    async deleteRemoteTag(path, input) {
      const operationId = `mock-tag-delete-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "tag_delete",
        cancelMessage: "已取消删除远端标签",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "tag_delete",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待删除远端标签",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "tag_delete",
            state: "running",
            phase: "deleting_remote_tag",
            percent: null,
            message: `正在从远端 ${input.remoteName} 删除标签`,
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          try {
            const tag = findExpectedMockTag(input.fullName, input.expectedLocalOid);
            const remote = findMockRemote(input.remoteName);
            validateMockRemoteUrl(remote.pushUrl);
            const expectedToken = mockRemoteTagDeleteToken(
              remote,
              tag.fullName,
              tag.oid,
              input.expectedRemoteOid,
            );
            if (expectedToken !== input.expectedToken) {
              throw mockError(
                "remote_tag_snapshot_changed",
                "本地标签或远端配置已变化，请重新读取远端标签后再删除",
              );
            }
            const key = mockRemoteTagKey(remote.name, tag.fullName);
            const remoteOid = mockRemoteTags.get(key);
            if (!remoteOid || remoteOid.toLowerCase() !== input.expectedRemoteOid.toLowerCase()) {
              throw mockError(
                "remote_tag_changed",
                "远端标签在确认后已变化或被删除，安全删除已停止",
              );
            }
            mockRemoteTags.delete(key);
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_delete",
              state: "succeeded",
              phase: "completed",
              percent: 100,
              message: `已从远端 ${remote.name} 删除标签 ${tag.name}`,
            });
          } catch (cause) {
            emitMockOperation({
              operationId,
              repositoryPath: path,
              kind: "tag_delete",
              state: "failed",
              phase: "completed",
              percent: null,
              message: cause instanceof Error ? cause.message : "删除远端标签失败",
            });
          }
          finishMockOperation(operationId);
        },
        320,
      );
      return { operationId };
    },
    async createStash(path, input) {
      if (mockChanges.some((change) => change.kind === "unmerged")) {
        throw new Error("仓库存在未解决的冲突，解决冲突后才能创建储藏");
      }
      const message = input.message?.trim() ?? "";
      if (
        input.message !== null &&
        (!message || [...message].length > 500 || /[\u0000-\u001f\u007f]/.test(message))
      ) {
        throw new Error("储藏说明不能为空、不能包含换行或控制字符，且不能超过 500 个字符");
      }
      const saved = mockChanges.filter(
        (change) => change.kind !== "untracked" || input.includeUntracked,
      );
      if (saved.length === 0) {
        throw new Error(
          mockChanges.length === 0
            ? "没有可储藏的本地更改"
            : "只有未跟踪文件；启用“包含未跟踪文件”后才能储藏",
        );
      }

      const oid = (++mockStashSequence).toString(16).padStart(40, "0");
      const branch = mockBranches.find((branch) => branch.current)?.name ?? "HEAD";
      mockStashes = [
        {
          selector: "stash@{0}",
          oid,
          subject: message ? `On ${branch}: ${message}` : `WIP on ${branch}`,
          createdAt: new Date().toISOString(),
        },
        ...mockStashes,
      ];
      reindexMockStashes();
      mockStashChanges.set(
        oid,
        saved.map((change) => ({ ...change })),
      );
      mockChanges = mockChanges
        .filter((change) => !saved.some((savedChange) => savedChange.path === change.path))
        .concat(
          input.keepIndex
            ? saved
                .filter((change) => Boolean(change.indexStatus))
                .map((change) => ({ ...change, worktreeStatus: null }))
            : [],
        );
      return { stashes: cloneStashes(), status: cloneStatus(path) };
    },
    async applyStash(path, oid, restoreIndex) {
      applyMockStash(path, oid, restoreIndex);
      return { stashes: cloneStashes(), status: cloneStatus(path) };
    },
    async popStash(path, oid, restoreIndex) {
      const { stash } = applyMockStash(path, oid, restoreIndex);
      mockStashes = mockStashes.filter((item) => item.oid !== stash.oid);
      mockStashChanges.delete(stash.oid);
      reindexMockStashes();
      return { stashes: cloneStashes(), status: cloneStatus(path) };
    },
    async dropStash(path, oid) {
      const stash = findMockStash(oid);
      mockStashes = mockStashes.filter((item) => item.oid !== stash.oid);
      mockStashChanges.delete(stash.oid);
      reindexMockStashes();
      return { stashes: cloneStashes(), status: cloneStatus(path) };
    },
    async createTrackingBranch(path, remoteFullName) {
      const target = mockBranches.find((branch) => branch.fullName === remoteFullName);
      if (!target || target.kind !== "remote" || !remoteFullName.startsWith("refs/remotes/")) {
        throw new Error("只能从已读取的远端分支创建本地跟踪分支");
      }
      const localName = target.name.slice(target.name.indexOf("/") + 1);
      if (!localName || !isValidMockBranchName(localName)) {
        throw new Error("远端分支缺少可用的本地分支名");
      }
      const localFullName = `refs/heads/${localName}`;
      if (mockBranches.some((branch) => branch.fullName === localFullName)) {
        throw new Error(`本地分支 ${localName} 已存在`);
      }
      mockBranches = [
        {
          name: localName,
          fullName: localFullName,
          kind: "local",
          current: true,
          oid: target.oid,
          upstream: target.name,
          upstreamMissing: false,
          ahead: 0,
          behind: 0,
        },
        ...mockBranches.map((branch) => ({ ...branch, current: false })),
      ];
      return { refs: cloneRefs(), status: cloneStatus(path) };
    },
    async fetch(path, remoteName) {
      if (!mockRemotes.some((remote) => remote.name === remoteName)) {
        throw new Error("该远端已不存在，请刷新后重试");
      }
      const operationId = `mock-fetch-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "fetch",
        cancelMessage: "已取消获取远端更新",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "fetch",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待获取远端 ${remoteName}`,
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "fetch",
            state: "running",
            phase: "connecting",
            percent: null,
            message: `正在连接远端 ${remoteName}`,
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "fetch",
            state: "progress",
            phase: "receiving",
            percent: 64,
            message: "正在接收远端对象",
          });
        },
        180,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "fetch",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: `已获取远端 ${remoteName}`,
          });
          finishMockOperation(operationId);
        },
        420,
      );
      return { operationId };
    },
    async pull(path) {
      const current = mockBranches.find((branch) => branch.current && branch.kind === "local");
      if (!current) throw new Error("当前处于 detached HEAD，无法执行 Pull");
      if (!current.upstream) throw new Error("当前分支尚未配置远端上游");
      const remoteName = current.upstream.split("/", 1)[0];
      if (!mockRemotes.some((remote) => remote.name === remoteName)) {
        throw new Error("当前分支的远端已不存在，请刷新分支与远端后重试");
      }

      const operationId = `mock-pull-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "pull",
        cancelMessage: "已取消 Pull",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "pull",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待安全 Pull",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "pull",
            state: "running",
            phase: "connecting",
            percent: null,
            message: "正在获取当前分支的远端上游",
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "pull",
            state: "progress",
            phase: "receiving",
            percent: 72,
            message: "正在接收远端对象",
          });
        },
        180,
      );
      scheduleMockOperation(
        operationId,
        () => {
          const upstream = current.upstream;
          const remoteBranch = mockBranches.find(
            (branch) => branch.kind === "remote" && branch.name === upstream,
          );
          mockBranches = mockBranches.map((branch) =>
            branch.fullName === current.fullName
              ? { ...branch, oid: remoteBranch?.oid ?? branch.oid, behind: 0 }
              : branch,
          );
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "pull",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: "已通过仅快进方式更新当前分支",
          });
          finishMockOperation(operationId);
        },
        420,
      );
      return { operationId };
    },
    async push(path) {
      const current = mockBranches.find((branch) => branch.current && branch.kind === "local");
      if (!current) throw new Error("当前处于 detached HEAD，无法执行 Push");
      if (!current.upstream) throw new Error("当前分支尚未配置远端上游");
      const remoteName = current.upstream.split("/", 1)[0];
      if (!mockRemotes.some((remote) => remote.name === remoteName)) {
        throw new Error("当前分支的远端已不存在，请刷新分支与远端后重试");
      }

      const operationId = `mock-push-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "push",
        cancelMessage: "已取消 Push",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "push",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待 Push",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "running",
            phase: "connecting",
            percent: null,
            message: "正在推送当前分支到远端上游",
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "progress",
            phase: "pushing",
            percent: 68,
            message: "正在上传远端对象",
          });
        },
        180,
      );
      scheduleMockOperation(
        operationId,
        () => {
          const upstream = current.upstream;
          mockBranches = mockBranches.map((branch) => {
            if (branch.fullName === current.fullName) return { ...branch, ahead: 0 };
            if (branch.kind === "remote" && branch.name === upstream) {
              return { ...branch, oid: current.oid };
            }
            return branch;
          });
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: "已推送当前分支到远端上游",
          });
          finishMockOperation(operationId);
        },
        420,
      );
      return { operationId };
    },
    async publishBranch(path, input) {
      const current = mockBranches.find((branch) => branch.current && branch.kind === "local");
      if (!current) throw new Error("当前处于 detached HEAD，无法发布远端分支");
      if (current.upstream) throw new Error("当前分支已经配置远端上游，请使用普通 Push");
      if (current.fullName !== input.localFullName || current.oid !== input.expectedLocalOid) {
        throw new Error("当前分支在确认后发生变化，请刷新后重试");
      }
      if (!mockRemotes.some((remote) => remote.name === input.remoteName)) {
        throw new Error("目标远端已不存在，请刷新后重试");
      }
      if (!isValidMockBranchName(input.remoteBranchName)) {
        throw new Error("分支名不合法，请检查空格、连续点号或 Git 不允许的字符");
      }
      const remoteBranchName = `${input.remoteName}/${input.remoteBranchName}`;
      if (
        mockBranches.some((branch) => branch.kind === "remote" && branch.name === remoteBranchName)
      ) {
        throw new Error("远端分支已经存在，请更换名称或先创建本地跟踪分支");
      }

      const operationId = `mock-publish-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "push",
        cancelMessage: "已取消 Push",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "push",
        state: "queued",
        phase: "queued",
        percent: null,
        message: `正在等待发布到 ${remoteBranchName}`,
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "running",
            phase: "connecting",
            percent: null,
            message: `正在发布当前分支到 ${remoteBranchName}`,
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "progress",
            phase: "publishing",
            percent: 68,
            message: "正在上传远端对象",
          });
        },
        180,
      );
      scheduleMockOperation(
        operationId,
        () => {
          mockBranches = [
            ...mockBranches.map((branch) =>
              branch.fullName === current.fullName
                ? { ...branch, upstream: remoteBranchName, upstreamMissing: false, ahead: 0 }
                : branch,
            ),
            {
              name: remoteBranchName,
              fullName: `refs/remotes/${remoteBranchName}`,
              kind: "remote",
              current: false,
              oid: current.oid,
              upstream: null,
              upstreamMissing: false,
              ahead: 0,
              behind: 0,
            },
          ];
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "push",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: `已发布当前分支到 ${remoteBranchName} 并设置上游`,
          });
          finishMockOperation(operationId);
        },
        420,
      );
      return { operationId };
    },
    async sync(path) {
      const current = mockBranches.find((branch) => branch.current && branch.kind === "local");
      if (!current) throw new Error("当前处于 detached HEAD，无法同步");
      if (!current.upstream) throw new Error("当前分支尚未配置远端上游");
      const remoteName = current.upstream.split("/", 1)[0];
      if (!mockRemotes.some((remote) => remote.name === remoteName)) {
        throw new Error("当前分支的远端已不存在，请刷新分支与远端后重试");
      }

      const operationId = `mock-sync-${++mockOperationSequence}`;
      mockOperationMeta.set(operationId, {
        repositoryPath: path,
        kind: "sync",
        cancelMessage: "已取消同步",
      });
      emitMockOperation({
        operationId,
        repositoryPath: path,
        kind: "sync",
        state: "queued",
        phase: "queued",
        percent: null,
        message: "正在等待同步当前分支",
      });
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "sync",
            state: "running",
            phase: "pulling",
            percent: null,
            message: "正在拉取当前分支的远端上游",
          });
        },
        20,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "sync",
            state: "progress",
            phase: "receiving",
            percent: 45,
            message: "正在接收远端对象",
          });
        },
        160,
      );
      scheduleMockOperation(
        operationId,
        () => {
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "sync",
            state: "progress",
            phase: "pushing",
            percent: 75,
            message: "正在推送当前分支到远端上游",
          });
        },
        300,
      );
      scheduleMockOperation(
        operationId,
        () => {
          const currentAtCompletion = mockBranches.find(
            (branch) => branch.current && branch.kind === "local",
          );
          if (currentAtCompletion) {
            mockBranches = mockBranches.map((branch) => {
              if (branch.fullName === currentAtCompletion.fullName) {
                return { ...branch, ahead: 0, behind: 0 };
              }
              if (branch.kind === "remote" && branch.name === currentAtCompletion.upstream) {
                return { ...branch, oid: currentAtCompletion.oid };
              }
              return branch;
            });
          }
          emitMockOperation({
            operationId,
            repositoryPath: path,
            kind: "sync",
            state: "succeeded",
            phase: "completed",
            percent: 100,
            message: "已同步当前分支",
          });
          finishMockOperation(operationId);
        },
        480,
      );
      return { operationId };
    },
    async createCommit(path, input) {
      rejectAnyMockConflict();
      if (mockMergeRecoveryStates.has(path)) {
        throw mockError(
          "merge_recovery_required",
          "仓库正在合并，请使用专用的继续合并操作完成 merge commit",
        );
      }
      const files = fileChangesForCommit();
      if (!input.subject.trim() || files.length === 0) {
        throw new Error(files.length === 0 ? "没有已暂存的更改可提交" : "提交标题不能为空");
      }
      const oid = (++mockCommitSequence).toString(16).padStart(40, "0");
      const commit: CommitSummary = {
        oid,
        parentOids: mockCommits[0] ? [mockCommits[0].oid] : [],
        authorName: "git-knot",
        authorEmail: "dev@example.com",
        authoredAt: new Date().toISOString(),
        subject: input.subject.trim(),
      };
      mockCommitPaths.set(commit.oid, [
        ...new Set(
          files.flatMap((file) => [file.originalPath, file.path].filter(Boolean) as string[]),
        ),
      ]);
      mockCommitBodies.set(commit.oid, input.body.trim());
      mockCommits = [commit, ...mockCommits];
      mockBranches = mockBranches.map((branch) =>
        branch.current
          ? { ...branch, oid: commit.oid, ahead: branch.upstream ? branch.ahead + 1 : branch.ahead }
          : branch,
      );
      mockChanges = mockChanges
        .filter((change) => !change.indexStatus || Boolean(change.worktreeStatus))
        .map((change) => ({ ...change, indexStatus: null }));
      return { commit, status: cloneStatus(path) };
    },
    async previewAmendCommit(path) {
      return previewMockAmend(path);
    },
    async amendCommit(path, input) {
      const preview = previewMockAmend(path);
      if (input.expectedToken !== preview.token) {
        throw mockError(
          "amend_snapshot_changed",
          "HEAD、当前分支或暂存内容已发生变化，请重新预览后再修改提交",
        );
      }
      if (!preview.canAmend) {
        throw mockError(
          "amend_head_is_published",
          "当前 HEAD 已被本地已知的远端引用或标签引用，安全修改已停止",
        );
      }
      const subject = input.subject.trim();
      if (!subject) throw mockError("invalid_commit_message", "提交标题不能为空");
      const previous = mockCommits.find((commit) => commit.oid === preview.headOid)!;
      const stagedPaths = fileChangesForCommit().flatMap(
        (file) => [file.originalPath, file.path].filter(Boolean) as string[],
      );
      const oid = (++mockAmendSequence).toString(16).padStart(40, "0");
      const commit: CommitSummary = {
        ...previous,
        oid,
        subject,
      };
      mockCommitPaths.set(oid, [
        ...new Set([...(mockCommitPaths.get(previous.oid) ?? []), ...stagedPaths]),
      ]);
      mockCommitBodies.set(oid, input.body.trim());
      mockCommits = [commit, ...mockCommits.filter((candidate) => candidate.oid !== previous.oid)];
      mockBranches = mockBranches.map((branch) => (branch.current ? { ...branch, oid } : branch));
      mockChanges = mockChanges
        .filter((change) => !change.indexStatus || Boolean(change.worktreeStatus))
        .map((change) => ({ ...change, indexStatus: null }));
      return {
        previousOid: previous.oid,
        commit,
        status: cloneStatus(path),
      };
    },
  },
  gitOperations: {
    async subscribe(listener) {
      mockOperationListeners.add(listener);
      return () => mockOperationListeners.delete(listener);
    },
    async cancel(operationId) {
      const timers = mockOperationTimers.get(operationId);
      const meta = mockOperationMeta.get(operationId);
      if (!timers || !meta) return false;
      for (const timer of timers) clearTimeout(timer);
      mockOperationTimers.delete(operationId);
      mockOperationMeta.delete(operationId);
      emitMockOperation({
        operationId,
        repositoryPath: meta.repositoryPath,
        kind: meta.kind,
        state: "cancelled",
        phase: "completed",
        percent: null,
        message: meta.cancelMessage,
      });
      return true;
    },
  },
  updates: {
    async check() {
      return {
        currentVersion: "0.1.0",
        available: false,
        version: null,
        notes: null,
        publishedAt: null,
      };
    },
    async downloadAndInstall() {
      throw mockError("update_not_available", "浏览器预览当前没有可安装的更新");
    },
    async restart() {},
    async subscribeProgress() {
      return () => {};
    },
  },
};
