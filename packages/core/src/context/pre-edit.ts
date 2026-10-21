/**
 * Just-in-time rule injection for file edits.
 *
 * Instead of dumping every spec into the system prompt, an Edit/Write tool
 * call receives only the verified rules whose scope matches the target path.
 */

import path from "node:path";
import {
  compileRules,
  readCompiledRules,
  rulesForPath,
  type Rule,
} from "../rules/index.js";
import { CORE_VERSION } from "../version.js";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBlock,
  type ContextRequest,
  type ContextResponse,
} from "./types.js";

const EDIT_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "applypatch",
  "apply_patch",
]);

export function isEditTool(toolName: string | null): boolean {
  return toolName !== null && EDIT_TOOLS.has(toolName.toLowerCase());
}

export function buildPreEdit(request: ContextRequest): ContextResponse {
  const root = path.resolve(request.projectRoot);
  const filePath = readFilePath(request);
  const rules = loadRules(root);
  const matched = filePath ? rulesForPath(rules, filePath) : [];
  const blocks: ContextBlock[] = matched.length
    ? [{ id: "rules-for-path", text: renderRules(filePath ?? "", matched), priority: 0 }]
    : [];

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    coreVersion: CORE_VERSION,
    event: "pre-tool-use",
    platform: request.platform.id,
    projectRoot: root,
    session: {
      key: null,
      keySource: "none",
      task: null,
      taskSource: "none",
      taskStale: false,
    },
    blocks,
    mutations: [],
    effects: [],
    envelope: "none",
    degraded: false,
    diagnostics: [],
  };
}

function loadRules(root: string): Rule[] {
  const cached = readCompiledRules(root);
  if (cached?.diagnostics.every((item) => item.severity !== "error")) {
    return cached.rules;
  }
  return compileRules(root).rules;
}

function renderRules(filePath: string, rules: readonly Rule[]): string {
  const lines = [`<rules-for-path path="${filePath}">`];
  for (const rule of rules) {
    lines.push(
      `- [${rule.id}] ${rule.severity} (${rule.check}/${rule.fix}): ${rule.statement}` +
        (rule.rationale ? ` — ${rule.rationale}` : ""),
    );
  }
  lines.push("</rules-for-path>");
  return lines.join("\n");
}

function readFilePath(request: ContextRequest): string | null {
  if (typeof request.hints?.filePath === "string" && request.hints.filePath.trim()) {
    return normalize(request.projectRoot, request.hints.filePath);
  }
  const input = request.input;
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  for (const container of [data.tool_input, data.toolInput, data.input]) {
    if (!container || typeof container !== "object") continue;
    for (const key of ["file_path", "filePath", "path", "file"]) {
      const value = (container as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return normalize(request.projectRoot, value);
      }
    }
  }
  for (const key of ["file_path", "filePath", "path"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return normalize(request.projectRoot, value);
    }
  }
  return null;
}

function normalize(root: string, value: string): string {
  return path.isAbsolute(value)
    ? path.relative(root, value).split(path.sep).join("/")
    : value.replace(/\\/g, "/").replace(/^\.\//, "");
}
