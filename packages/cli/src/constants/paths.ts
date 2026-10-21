/**
 * Path constants for the Phronia workflow structure.
 *
 * Values come from `@mindfoldhq/trellis-core/layout`, which is the single
 * source of truth. Changing a directory means changing `LAYOUT` and running the
 * generator that produces the Python `layout.json`; editing values here is not
 * supported.
 *
 * The exported names (`DIR_NAMES`, `FILE_NAMES`, `PATHS`) are kept for
 * compatibility with existing call sites.
 */

import { LAYOUT } from "@mindfoldhq/trellis-core/layout";

// Directory names.
export const DIR_NAMES = {
  /** Root workflow directory */
  WORKFLOW: LAYOUT.rootDirName,
  /** Workspace directory (under the workflow root) */
  WORKSPACE: "workspace",
  /** Tasks directory (under the workflow root) */
  TASKS: "tasks",
  /** Archive directory (under tasks/) */
  ARCHIVE: "archive",
  /** Spec/guidelines directory (under the workflow root) */
  SPEC: "spec",
  /** Scripts directory (under the workflow root) */
  SCRIPTS: "scripts",
  /** Channel runtime agent definitions (under the workflow root) */
  AGENTS: "agents",
} as const;

// File names.
export const FILE_NAMES = {
  /** Root agent instructions file */
  AGENTS: "AGENTS.md",
  /** Developer identity file */
  DEVELOPER: ".developer",
  /** Current task pointer (legacy) */
  CURRENT_TASK: ".current-task",
  /** Task metadata */
  TASK_JSON: "task.json",
  /** Requirements document */
  PRD: "prd.md",
  /** Workflow guide */
  WORKFLOW_GUIDE: "workflow.md",
  /** Journal file prefix */
  JOURNAL_PREFIX: "journal-",
} as const;

// Constructed paths (relative to project root).
export const PATHS = {
  /** Workflow root, e.g. `.phronia/` */
  WORKFLOW: LAYOUT.paths.root,
  /** `<root>/workspace/` */
  WORKSPACE: LAYOUT.paths.workspace,
  /** `<root>/tasks/` */
  TASKS: LAYOUT.paths.tasks,
  /** `<root>/spec/` */
  SPEC: LAYOUT.paths.spec,
  /** `<root>/scripts/` */
  SCRIPTS: LAYOUT.paths.scripts,
  /** `<root>/agents/` */
  AGENTS: LAYOUT.paths.agents,
  /** `<root>/.developer` */
  DEVELOPER_FILE: LAYOUT.paths.developer,
  /** `<root>/.current-task` */
  CURRENT_TASK_FILE: LAYOUT.paths.currentTask,
  /** `<root>/workflow.md` */
  WORKFLOW_GUIDE_FILE: LAYOUT.paths.workflow,
} as const;

/**
 * Get developer's workspace directory path
 * @example getWorkspaceDir("john") => ".phronia/workspace/john"
 */
export function getWorkspaceDir(developer: string): string {
  return `${PATHS.WORKSPACE}/${developer}`;
}

/**
 * Get task directory path
 * @example getTaskDir("01-21-my-task") => ".phronia/tasks/01-21-my-task"
 */
export function getTaskDir(taskName: string): string {
  return `${PATHS.TASKS}/${taskName}`;
}

/**
 * Get archive directory path
 * @example getArchiveDir() => ".phronia/tasks/archive"
 */
export function getArchiveDir(): string {
  return `${PATHS.TASKS}/${DIR_NAMES.ARCHIVE}`;
}
