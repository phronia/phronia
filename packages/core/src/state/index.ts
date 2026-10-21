/**
 * Read-only state layer.
 *
 * B2 starts with configuration; task/session/workflow readers land in the same
 * package without changing this entrypoint. Writers stay in the Python runtime
 * until B10 (see ADR-0005).
 */

import path from "node:path";
import { LAYOUT } from "../layout/index.js";
import { DiagnosticCollector, type Diagnostic } from "./diagnostics.js";
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

export * from "./diagnostics.js";
export * from "./fs.js";
export * from "./config/yaml.js";
export * from "./config/readers.js";
export * from "./platform/env-tables.js";
export * from "./session/key.js";
export * from "./session/tickets.js";
export * from "./session/active-task.js";
export * from "./tasks/refs.js";

export interface StateReaderOptions {
  /** Explicit project root. The state layer never infers it from cwd. */
  root: string;
  env?: Readonly<Record<string, string | undefined>>;
  fs?: FsLike;
  /** Process argv for shell-ticket resolution; omit to disable the bridge. */
  argv?: readonly string[];
  /** Injectable clock (epoch seconds) for ticket freshness. */
  now?: () => number;
}

export interface SessionReadOptions {
  platform?: string | null;
  allowSingleSessionFallback?: boolean;
  allowEnvironmentContext?: boolean;
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
      if (!configLoaded) {
        const result = readConfig(root, io);
        configCache = result.value;
        collected.addAll(result.diagnostics);
        configLoaded = true;
      }
      return configCache as ConfigView;
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
    diagnostics(): readonly Diagnostic[] {
      if (!configLoaded) {
        // Force a load so diagnostics are complete.
        this.config();
      }
      return collected.all();
    },
  };
}
