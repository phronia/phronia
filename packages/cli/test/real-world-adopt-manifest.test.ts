import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_IDS } from "@phronia/core/platform";

const ROOT = path.resolve(__dirname, "../../..");
const MANIFEST = path.join(ROOT, "test/adopt/real-world-projects.json");

interface ProjectExpect {
  preservedPaths?: string[];
  archiveMonths?: Record<string, number>;
  agentsMdMustContain?: string[];
  agentsMdMustNotContain?: string[];
  workflowMustContain?: string[];
  workflowMustNotContain?: string[];
  tasksCommand?: string[];
  tasksCommandMustContain?: string[];
  updateDryRunMustContain?: string[];
}

interface Project {
  name: string;
  repo: string;
  commit: string;
  fromVersion: string;
  platforms: string[];
  expect: ProjectExpect;
}

interface Manifest {
  schemaVersion: number;
  projects: Project[];
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest;
}

describe("real-world adopt manifest", () => {
  it("pins every fixture to a full commit SHA", () => {
    const manifest = readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projects.length).toBeGreaterThan(0);

    const names = new Set<string>();
    for (const project of manifest.projects) {
      expect(project.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(names.has(project.name)).toBe(false);
      names.add(project.name);

      expect(project.repo).toMatch(/^https:\/\/[^\s]+\.git$/);
      expect(project.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(project.fromVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(project.platforms.length).toBeGreaterThan(0);
      for (const platform of project.platforms) {
        expect(PLATFORM_IDS).toContain(platform);
      }
    }
  });

  it("keeps assertions scoped to the migrated tree", () => {
    for (const project of readManifest().projects) {
      const expectBlock = project.expect;
      for (const relativePath of expectBlock.preservedPaths ?? []) {
        expect(relativePath.startsWith(".phronia/")).toBe(true);
        expect(relativePath.includes("..")).toBe(false);
      }
      for (const [month, count] of Object.entries(
        expectBlock.archiveMonths ?? {},
      )) {
        expect(month).toMatch(/^\d{4}-\d{2}$/);
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThan(0);
      }
      if ((expectBlock.tasksCommandMustContain ?? []).length > 0) {
        expect((expectBlock.tasksCommand ?? []).length).toBeGreaterThan(0);
      }
    }
  });
});
