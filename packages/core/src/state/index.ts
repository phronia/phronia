/**
 * Read-only state layer.
 *
 * B2 starts with configuration; task/session/workflow readers land in the same
 * package without changing this entrypoint. Writers stay in the Python runtime
 * until B10 (see ADR-0005).
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { DiagnosticCollector, diagnostic, type Diagnostic } from "./diagnostics.js";
import { nodeFs, isDirectory, type FsLike } from "./fs.js";
import { readConfig, type ConfigView } from "./config/readers.js";
import {
  resolveActiveTask,
  listSessionFiles,
  readSessionFile,
  type ActiveTaskState,
  type RawSessionFile,
} from "./session/active-task.js";
import { resolveContextKey, type ContextKeyResult } from "./session/key.js";
import { lookupShellTicketContextKey } from "./session/tickets.js";
import { readTaskRecord, type TaskRecordView } from "./tasks/record.js";
import {
  countCuratedEntries,
  inspectTaskArtifacts,
  type ContextKind,
  type TaskArtifacts,
} from "./tasks/artifacts.js";
import { listTasks, type ListTasksOptions, type TaskSummary } from "./tasks/list.js";
import {
  parseBreadcrumbs,
  resolveBreadcrumbKey,
  promptHasSkipKeyword,
} from "./workflow/breadcrumb.js";
import { buildWorkflowOverview } from "./workflow/phase.js";
import {
  collectSpecIndexPaths,
  legacySpecWarning,
  resolveSpecScope,
  type SpecScopeResult,
} from "./spec/index.js";
import { readText } from "./fs.js";
import { readDeveloper, readJournal, type DeveloperState, type JournalState } from "./identity.js";
import { readGitState, type GitExec, type GitState } from "./git.js";

export * from "./diagnostics.js";
export * from "./fs.js";
export * from "./config/yaml.js";
export * from "./config/readers.js";
export * from "./platform/env-tables.js";
export * from "./session/key.js";
export * from "./session/tickets.js";
export * from "./session/active-task.js";
export * from "./session/store.js";
export * from "./tasks/refs.js";
export * from "./tasks/record.js";
export * from "./tasks/artifacts.js";
export * from "./tasks/list.js";
export * from "./workflow/breadcrumb.js";
export * from "./workflow/phase.js";
export * from "./spec/index.js";
export * from "./identity.js";
export * from "./git.js";

export interface StateReaderOptions {
  /** Explicit project root. The state layer never infers it from cwd. */
  root: string;
  env?: Readonly<Record<string, string | undefined>>;
  fs?: FsLike;
  /** Process argv for shell-ticket resolution; omit to disable the bridge. */
  argv?: readonly string[];
  /** Injectable clock (epoch seconds) for ticket freshness. */
  now?: () => number;
  /** Injectable git runner (tests). */
  exec?: GitExec;
}

export interface SessionReadOptions {
  platform?: string | null;
  allowSingleSessionFallback?: boolean;
  allowEnvironmentContext?: boolean;
  /** Explicit harness-provided task reference; wins over session state. */
  taskRef?: string | null;
}

export interface StateReader {
  readonly root: string;
  /** True when the explicit root contains a workflow directory. */
  exists(): boolean;
  config(): ConfigView;
  readonly sessions: {
    resolveKey(input: unknown, options?: SessionReadOptions): ContextKeyResult;
    active(input: unknown, options?: SessionReadOptions): ActiveTaskState;
    read(key: string): RawSessionFile | null;
    list(): readonly RawSessionFile[];
  };
  readonly tasks: {
    read(ref: string): TaskRecordView | null;
    artifacts(ref: string): TaskArtifacts;
    curatedCount(ref: string, kind: ContextKind): number;
    list(options?: ListTasksOptions): readonly TaskSummary[];
  };
  readonly workflow: {
    overview(): string;
    breadcrumbs(): Readonly<Record<string, string>>;
    breadcrumbKey(status: string): string;
    shouldSkipPrompt(prompt: string): boolean;
  };
  readonly spec: {
    scope(taskPackage?: string | null): SpecScopeResult;
    indexPaths(taskPackage?: string | null): readonly string[];
    legacyWarning(): Diagnostic | null;
  };
  developer(): DeveloperState;
  git(): GitState;
  journal(): JournalState;
  diagnostics(): readonly Diagnostic[];
}

export function openState(options: StateReaderOptions): StateReader {
  if (!options.root || typeof options.root !== "string") {
    throw new Error("openState requires an explicit project root");
  }
  const root = path.resolve(options.root);
  const io = options.fs ?? nodeFs;
  const collected = new DiagnosticCollector();
  let configCache: ConfigView | null = null;
  let configLoaded = false;

  function configView(): ConfigView {
    if (!configLoaded) {
      const result = readConfig(root, io);
      configCache = result.value;
      collected.addAll(result.diagnostics);
      configLoaded = true;
    }
    return configCache as ConfigView;
  }

  function shellTicketReader(): (() => string | null) | undefined {
    const argv = options.argv;
    if (!argv) {
      return undefined;
    }
    return () => {
      const result = lookupShellTicketContextKey({
        root,
        argv,
        now: options.now?.() ?? Date.now() / 1000,
        io,
      });
      return result.key;
    };
  }

  return {
    root,
    exists(): boolean {
      return isDirectory(io, path.join(root, LAYOUT.rootDirName));
    },
    config(): ConfigView {
      return configView();
    },
    sessions: {
      resolveKey(input: unknown, sessionOptions: SessionReadOptions = {}): ContextKeyResult {
        return resolveContextKey(input, {
          platform: sessionOptions.platform,
          env: options.env,
          allowEnvironmentContext: sessionOptions.allowEnvironmentContext,
          shellTicket: shellTicketReader(),
        });
      },
      active(input: unknown, sessionOptions: SessionReadOptions = {}): ActiveTaskState {
        const state = resolveActiveTask({
          root,
          input,
          platform: sessionOptions.platform,
          env: options.env,
          io,
          argv: options.argv,
          now: options.now?.() ?? Date.now() / 1000,
          allowSingleSessionFallback: sessionOptions.allowSingleSessionFallback,
          allowEnvironmentContext: sessionOptions.allowEnvironmentContext,
          taskRef: sessionOptions.taskRef,
        });
        collected.addAll(state.diagnostics);
        return state;
      },
      read(key: string): RawSessionFile | null {
        return readSessionFile(root, key, io);
      },
      list(): readonly RawSessionFile[] {
        return listSessionFiles(root, io);
      },
    },
    tasks: {
      read(ref: string): TaskRecordView | null {
        const diagnostics: Diagnostic[] = [];
        const record = readTaskRecord(root, ref, io, diagnostics);
        collected.addAll(diagnostics);
        return record;
      },
      artifacts(ref: string): TaskArtifacts {
        return inspectTaskArtifacts(root, ref, io);
      },
      curatedCount(ref: string, kind: ContextKind): number {
        const diagnostics: Diagnostic[] = [];
        const count = countCuratedEntries(root, ref, kind, io, diagnostics);
        collected.addAll(diagnostics);
        return count;
      },
      list(taskOptions: ListTasksOptions = {}): readonly TaskSummary[] {
        const diagnostics: Diagnostic[] = [];
        const tasks = listTasks(root, io, taskOptions, diagnostics);
        collected.addAll(diagnostics);
        return tasks;
      },
    },
    workflow: {
      overview(): string {
        const workflowFile = path.join(root, LAYOUT.paths.workflow);
        const content = readText(io, workflowFile);
        if (content === null) {
          collected.add(
            diagnostic("state.workflow.file_missing", "info", "workflow.md not found", {
              path: workflowFile,
            }),
          );
        }
        return buildWorkflowOverview(content, LAYOUT.paths.workflow);
      },
      breadcrumbs(): Readonly<Record<string, string>> {
        const content = readText(io, path.join(root, LAYOUT.paths.workflow));
        return content === null ? {} : parseBreadcrumbs(content);
      },
      breadcrumbKey(status: string): string {
        return resolveBreadcrumbKey(status, configView().codexDispatchMode);
      },
      shouldSkipPrompt(prompt: string): boolean {
        return promptHasSkipKeyword(
          prompt,
          configView().promptInjection.skipKeyword,
        );
      },
    },
    spec: {
      scope(taskPackage: string | null = null): SpecScopeResult {
        const config = configView();
        const result = resolveSpecScope({
          packages: config.packages,
          scope: config.specScope,
          taskPackage,
          defaultPackage: config.defaultPackage,
        });
        collected.addAll(result.diagnostics);
        return result;
      },
      indexPaths(taskPackage: string | null = null): readonly string[] {
        const config = configView();
        const scope = resolveSpecScope({
          packages: config.packages,
          scope: config.specScope,
          taskPackage,
          defaultPackage: config.defaultPackage,
        });
        collected.addAll(scope.diagnostics);
        return collectSpecIndexPaths(root, io, scope.packages);
      },
      legacyWarning(): Diagnostic | null {
        return legacySpecWarning(root, io, configView().packages);
      },
    },
    developer(): DeveloperState {
      const state = readDeveloper(root, io, { env: options.env, exec: options.exec });
      collected.addAll(state.diagnostics);
      return state;
    },
    git(): GitState {
      return readGitState(root, options.exec);
    },
    journal(): JournalState {
      return readJournal(root, readDeveloper(root, io, { env: options.env, exec: options.exec }).name, io);
    },
    diagnostics(): readonly Diagnostic[] {
      if (!configLoaded) {
        // Force a load so diagnostics are complete.
        configView();
      }
      return collected.all();
    },
  };
}
