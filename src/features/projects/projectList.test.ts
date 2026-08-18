import { describe, expect, it } from "vitest";
import {
  filterProjects,
  groupProjects,
  mergeScannedProjects,
  selectProjectIdWhenEmpty,
  upsertProject,
} from "./projectList";
import type { Project } from "../../platform/desktop";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "one",
    name: "Alpha",
    path: "/work/alpha",
    addedAt: 1,
    favorite: false,
    group: null,
    ...overrides,
  };
}

describe("project list filtering", () => {
  it("searches project name, path and group without case sensitivity", () => {
    const projects = [
      project(),
      project({ id: "two", name: "Beta", path: "/work/beta", group: "客户" }),
    ];
    expect(filterProjects(projects, "ALP").map((item) => item.id)).toEqual(["one"]);
    expect(filterProjects(projects, "客户").map((item) => item.id)).toEqual(["two"]);
    expect(filterProjects(projects, "/work/b").map((item) => item.id)).toEqual(["two"]);
  });
});

describe("project list grouping", () => {
  it("pins favorites and groups the remaining projects", () => {
    const projects = [
      project({ id: "ungrouped", name: "Zeta" }),
      project({ id: "customer", name: "Beta", group: "客户" }),
      project({ id: "favorite", name: "Alpha", favorite: true, group: "客户" }),
      project({ id: "internal", name: "Gamma", group: "内部" }),
    ];

    expect(groupProjects(projects).map((section) => section.label)).toEqual([
      "收藏",
      "客户",
      "内部",
      "未分组",
    ]);
    expect(groupProjects(projects)[0].projects.map((item) => item.id)).toEqual(["favorite"]);
    expect(
      groupProjects(projects)
        .at(1)
        ?.projects.map((item) => item.id),
    ).toEqual(["customer"]);
  });

  it("does not create empty sections for a search with no matches", () => {
    expect(groupProjects([project()], "missing")).toEqual([]);
  });
});

describe("scanned project merging", () => {
  it("puts scanned repositories first and removes path duplicates", () => {
    const current = [
      project({ id: "existing", path: "/work/existing" }),
      project({ id: "keep", path: "/work/keep" }),
    ];
    const scanned = [
      project({ id: "existing-new", name: "Existing", path: "/work/existing" }),
      project({ id: "new", name: "New", path: "/work/new" }),
    ];

    expect(mergeScannedProjects(scanned, current).map((item) => item.path)).toEqual([
      "/work/existing",
      "/work/new",
      "/work/keep",
    ]);
  });
});

describe("project insertion and selection", () => {
  it("upserts only the completed clone and preserves concurrent project state", () => {
    const current = [
      project({ id: "active", path: "/work/active", favorite: true }),
      project({ id: "scanned", path: "/work/scanned" }),
    ];
    const cloned = project({ id: "clone", name: "Clone", path: "/work/clone" });

    expect(upsertProject(current, cloned)).toEqual([cloned, ...current]);

    const refreshedClone = { ...cloned, favorite: true };
    expect(upsertProject([cloned, ...current], refreshedClone)).toEqual([
      refreshedClone,
      ...current,
    ]);
  });

  it("only selects a scanned or cloned project when no project is selected", () => {
    const candidate = project({ id: "new", path: "/work/new" });

    expect(selectProjectIdWhenEmpty("active", candidate)).toBe("active");
    expect(selectProjectIdWhenEmpty(null, candidate)).toBe("new");
    expect(selectProjectIdWhenEmpty(null, undefined)).toBeNull();
  });
});
