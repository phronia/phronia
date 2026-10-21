/**
 * `phronia mem doctor` data: where each enhancer looks, whether it is
 * readable, and what schema it exposes. The memory floor is reported
 * separately because it never depends on a harness store.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_PROJECTS,
  CODEX_SESSIONS,
  GROK_SESSIONS,
  PI_AGENT_DIR,
  ZCODE_DB,
  devinCliDbPath,
  opencodeDataDir,
} from "./internal/paths.js";
import { openSqliteReadOnly } from "./internal/sqlite-readonly.js";
import type { MemSourceKind, MemWarning } from "./types.js";

export interface MemSourceStatus {
  platform: MemSourceKind | "phronia";
  path: string;
  kind: "directory" | "database" | "workflow";
  exists: boolean;
  readable: boolean;
  /** Sorted table names for databases, `null` for file/directory sources. */
  schema: string[] | null;
  warnings: MemWarning[];
}

const PATHS: {
  platform: MemSourceKind;
  kind: "directory" | "database";
  path: () => string;
}[] = [
  { platform: "claude", kind: "directory", path: () => CLAUDE_PROJECTS },
  { platform: "codex", kind: "directory", path: () => CODEX_SESSIONS },
  { platform: "grok", kind: "directory", path: () => GROK_SESSIONS },
  { platform: "pi", kind: "directory", path: () => PI_AGENT_DIR },
  { platform: "zcode", kind: "database", path: () => ZCODE_DB },
  { platform: "opencode", kind: "database", path: () => opencodeDataDir() },
  {
    platform: "devin",
    kind: "database",
    path: () => devinCliDbPath() ?? "",
  },
];

export function memDoctor(root: string): MemSourceStatus[] {
  const statuses: MemSourceStatus[] = [
    {
      platform: "phronia",
      path: path.join(root, ".phronia"),
      kind: "workflow",
      exists: fs.existsSync(path.join(root, ".phronia")),
      readable: isReadable(path.join(root, ".phronia")),
      schema: null,
      warnings: [],
    },
  ];

  for (const entry of PATHS) {
    const target = entry.path();
    const warnings: MemWarning[] = [];
    if (!target) {
      statuses.push({
        platform: entry.platform,
        path: "",
        kind: entry.kind,
        exists: false,
        readable: false,
        schema: null,
        warnings: [
          {
            code: "mem.doctor.no_path",
            message: `${entry.platform}: this platform has no configured store path`,
          },
        ],
      });
      continue;
    }
    const exists = fs.existsSync(target);
    let schema: string[] | null = null;
    if (entry.kind === "database") {
      const dbPath = databaseFile(target);
      if (dbPath) {
        try {
          const db = openSqliteReadOnly(dbPath);
          schema = db.listTables().map((table) => table.name).sort();
          db.close();
        } catch (error) {
          warnings.push({
            code: "mem.doctor.schema_unreadable",
            message: `${entry.platform}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    statuses.push({
      platform: entry.platform,
      path: target,
      kind: entry.kind,
      exists,
      readable: entry.kind === "database" ? Boolean(databaseFile(target)) : isReadable(target),
      schema,
      warnings,
    });
  }
  return statuses;
}

function databaseFile(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return target;
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  for (const candidate of fs.readdirSync(target)) {
    if (candidate.endsWith(".db") || candidate.endsWith(".sqlite")) {
      const full = path.join(target, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function isReadable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
