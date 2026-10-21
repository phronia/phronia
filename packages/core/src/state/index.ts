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

export * from "./diagnostics.js";
export * from "./fs.js";
export * from "./config/yaml.js";
export * from "./config/readers.js";

export interface StateReaderOptions {
  /** Explicit project root. The state layer never infers it from cwd. */
  root: string;
  env?: Readonly<Record<string, string | undefined>>;
  fs?: FsLike;
}

export interface StateReader {
  readonly root: string;
  /** True when the explicit root contains a workflow directory. */
  exists(): boolean;
  config(): ConfigView;
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
    diagnostics(): readonly Diagnostic[] {
      if (!configLoaded) {
        // Force a load so diagnostics are complete.
        this.config();
      }
      return collected.all();
    },
  };
}
