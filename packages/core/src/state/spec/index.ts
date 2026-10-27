/**
 * Spec scope and index paths.
 *
 * Mirrors `session-start.py:607-694`. Scope selects which packages' index
 * files a session is told about; it never reads spec bodies.
 */

import path from "node:path";
import { LAYOUT } from "../../layout/index.js";
import { diagnostic, type Diagnostic } from "../diagnostics.js";
import { isDirectory, listDir, readText, type FsLike } from "../fs.js";
import type { PackageConfig } from "../config/readers.js";

export interface SpecScopeResult {
  /** null means "scan every package". */
  packages: Set<string> | null;
  diagnostics: readonly Diagnostic[];
}

export function resolveSpecScope(options: {
  packages: Record<string, PackageConfig> | null;
  scope: string | string[] | null;
  taskPackage: string | null;
  defaultPackage: string | null;
}): SpecScopeResult {
  const diagnostics: Diagnostic[] = [];
  const { packages, scope } = options;
  if (!packages) {
    return { packages: null, diagnostics };
  }
  if (scope === null) {
    return { packages: null, diagnostics };
  }
  if (typeof scope === "string" && scope === "active_task") {
    if (options.taskPackage && options.taskPackage in packages) {
      return { packages: new Set([options.taskPackage]), diagnostics };
    }
    if (options.defaultPackage && options.defaultPackage in packages) {
      return { packages: new Set([options.defaultPackage]), diagnostics };
    }
    return { packages: null, diagnostics };
  }
  if (Array.isArray(scope)) {
    const valid = new Set<string>();
    for (const entry of scope) {
      if (entry in packages) {
        valid.add(entry);
      } else {
        diagnostics.push(
          diagnostic(
            "state.spec.unknown_package",
            "info",
            `spec_scope contains unknown package: ${entry}, ignoring`,
          ),
        );
      }
    }
    if (valid.size > 0) {
      if (options.taskPackage && !valid.has(options.taskPackage)) {
        diagnostics.push(
          diagnostic(
            "state.spec.task_out_of_scope",
            "info",
            `active task package '${options.taskPackage}' is out of configured spec_scope`,
          ),
        );
      }
      return { packages: valid, diagnostics };
    }
    diagnostics.push(
      diagnostic(
        "state.spec.scope_fallback",
        "info",
        "all spec_scope entries invalid; falling back to task/default/full",
      ),
    );
    if (options.taskPackage && options.taskPackage in packages) {
      return { packages: new Set([options.taskPackage]), diagnostics };
    }
    if (options.defaultPackage && options.defaultPackage in packages) {
      return { packages: new Set([options.defaultPackage]), diagnostics };
    }
    return { packages: null, diagnostics };
  }
  return { packages: null, diagnostics };
}

export function collectSpecIndexPaths(
  root: string,
  io: FsLike,
  allowedPackages: Set<string> | null,
): readonly string[] {
  const specDir = path.join(root, LAYOUT.paths.spec);
  const paths: string[] = [];
  if (readText(io, path.join(specDir, "guides", "index.md")) !== null) {
    paths.push(`${LAYOUT.paths.spec}/guides/index.md`);
  }
  if (!isDirectory(io, specDir)) {
    return paths;
  }
  for (const entry of listDir(io, specDir)) {
    if (entry.startsWith(".") || entry === "guides") {
      continue;
    }
    const packageDir = path.join(specDir, entry);
    if (!isDirectory(io, packageDir)) {
      continue;
    }
    if (readText(io, path.join(packageDir, "index.md")) !== null) {
      paths.push(`${LAYOUT.paths.spec}/${entry}/index.md`);
      continue;
    }
    if (allowedPackages !== null && !allowedPackages.has(entry)) {
      continue;
    }
    for (const nested of listDir(io, packageDir)) {
      const nestedDir = path.join(packageDir, nested);
      if (!isDirectory(io, nestedDir)) {
        continue;
      }
      if (readText(io, path.join(nestedDir, "index.md")) !== null) {
        paths.push(`${LAYOUT.paths.spec}/${entry}/${nested}/index.md`);
      }
    }
  }
  return paths;
}

/** Warn when a legacy single-repo layout remains beside per-package specs. */
export function legacySpecWarning(
  root: string,
  io: FsLike,
  packages: Record<string, PackageConfig> | null,
): Diagnostic | null {
  if (!packages) {
    return null;
  }
  const specDir = path.join(root, LAYOUT.paths.spec);
  for (const legacy of ["backend", "frontend"]) {
    if (readText(io, path.join(specDir, legacy, "index.md")) === null) {
      continue;
    }
    const hasPackageDir = Object.keys(packages).some((name) =>
      isDirectory(io, path.join(specDir, name)),
    );
    if (!hasPackageDir) {
      return diagnostic(
        "state.spec.legacy_layout",
        "info",
        `legacy spec/${legacy}/ exists but per-package spec directories are missing`,
      );
    }
  }
  return null;
}
