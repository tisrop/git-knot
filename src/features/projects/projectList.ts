import type { Project } from "../../platform/desktop";

export interface ProjectSection {
  key: string;
  label: string;
  projects: Project[];
}

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}

export function filterProjects(projects: Project[], query: string): Project[] {
  const needle = normalized(query);
  if (!needle) return projects;
  return projects.filter((project) =>
    [project.name, project.path, project.group].some((value) => normalized(value).includes(needle)),
  );
}

export function selectProjectIdWhenEmpty(
  currentSelectedId: string | null,
  candidate: Project | null | undefined,
) {
  return currentSelectedId ?? candidate?.id ?? null;
}

export function upsertProject(current: Project[], project: Project) {
  return [
    project,
    ...current.filter((item) => item.id !== project.id && item.path !== project.path),
  ];
}

export function mergeScannedProjects(scanned: Project[], current: Project[]) {
  const scannedPaths = new Set(scanned.map((project) => project.path));
  return [...scanned, ...current.filter((project) => !scannedPaths.has(project.path))];
}

export function groupProjects(projects: Project[], query = ""): ProjectSection[] {
  const filtered = filterProjects(projects, query);
  const sections: ProjectSection[] = [];
  const favorites = filtered.filter((project) => project.favorite);
  if (favorites.length > 0) {
    sections.push({ key: "favorites", label: "收藏", projects: favorites });
  }

  const groups = new Map<string, Project[]>();
  for (const project of filtered) {
    if (project.favorite) continue;
    const key = project.group?.trim() || "__ungrouped__";
    const entries = groups.get(key) ?? [];
    entries.push(project);
    groups.set(key, entries);
  }

  [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "__ungrouped__") return 1;
      if (right === "__ungrouped__") return -1;
      return left.localeCompare(right, "zh-CN");
    })
    .forEach(([key, group]) => {
      sections.push({
        key,
        label: key === "__ungrouped__" ? "未分组" : key,
        projects: group,
      });
    });

  return sections;
}
