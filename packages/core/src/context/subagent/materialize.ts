/**
 * Sub-agent context materialization.
 *
 * Ported from `inject-subagent-context.py`: JSONL manifests select files,
 * per-file/per-artifact/total byte caps apply, binary files degrade to notices,
 * and truncation never splits a UTF-8 sequence.
 */

import fs from "node:fs";
import path from "node:path";
import { diagnostic, type Diagnostic } from "../../state/diagnostics.js";
import type { ContextInjectionLimits } from "../../state/config/readers.js";

export const DEFAULT_LIMITS: ContextInjectionLimits = {
  maxFileBytes: 32768,
  maxArtifactBytes: 65536,
  maxTotalBytes: 131072,
};

export class Budget {
  private used = 0;
  constructor(private readonly maxTotalBytes: number) {}

  hasRoom(size: number): boolean {
    return this.maxTotalBytes <= 0 || this.used + size <= this.maxTotalBytes;
  }

  add(size: number): void {
    this.used += size;
  }

  get total(): number {
    return this.used;
  }
}

export interface JsonlEntry {
  file: string;
  type: "file" | "directory";
  reason: string;
}

export interface MaterializeResult {
  context: string;
  diagnostics: Diagnostic[];
}

export function truncateUtf8(data: Buffer, cap: number): Buffer {
  if (cap <= 0 || data.length <= cap) {
    return data;
  }
  const truncated = data.subarray(0, cap);
  let index = truncated.length;
  while (index > 0 && ((truncated[index - 1] ?? 0) & 0xc0) === 0x80) {
    index -= 1;
  }
  if (index === 0) {
    return Buffer.alloc(0);
  }
  const lead = truncated[index - 1] ?? 0;
  if ((lead & 0x80) !== 0) {
    let sequenceLength = 1;
    if ((lead & 0xe0) === 0xc0) sequenceLength = 2;
    else if ((lead & 0xf0) === 0xe0) sequenceLength = 3;
    else if ((lead & 0xf8) === 0xf0) sequenceLength = 4;
    if (index - 1 + sequenceLength > truncated.length) {
      index -= 1;
    }
  }
  return truncated.subarray(0, index);
}

export function isBinaryContent(data: Buffer): boolean {
  if (data.includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}

export function readFileBytes(
  basePath: string,
  filePath: string,
): Buffer | null {
  const fullPath = path.join(basePath, filePath);
  try {
    const rootReal = fs.realpathSync(basePath);
    const workflowReal = fs.realpathSync(path.join(basePath, ".phronia"));
    const fullReal = fs.realpathSync(fullPath);
    const contained =
      isContained(rootReal, fullReal) || isContained(workflowReal, fullReal);
    if (!contained) {
      return null;
    }
    if (!fs.statSync(fullPath).isFile()) {
      return null;
    }
    return fs.readFileSync(fullPath);
  } catch {
    return null;
  }
}

export function readJsonlEntries(
  basePath: string,
  jsonlPath: string,
  diagnostics: Diagnostic[],
): JsonlEntry[] {
  const fullPath = path.join(basePath, jsonlPath);
  if (!fs.existsSync(fullPath)) {
    diagnostics.push(
      diagnostic(
        "context.subagent.jsonl_missing",
        "warn",
        `${jsonlPath} not found — sub-agent will receive only task artifacts`,
      ),
    );
    return [];
  }
  const entries: JsonlEntry[] = [];
  let sawRealEntry = false;
  const content = fs.readFileSync(fullPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as Record<string, unknown>;
      const filePath = stringField(item.file) ?? stringField(item.path);
      if (!filePath) continue;
      sawRealEntry = true;
      entries.push({
        file: filePath,
        type: item.type === "directory" ? "directory" : "file",
        reason: stringField(item.reason) ?? "-",
      });
    } catch {
      // Malformed lines are skipped, matching the Python reader.
    }
  }
  if (!sawRealEntry) {
    diagnostics.push(
      diagnostic(
        "context.subagent.jsonl_empty",
        "warn",
        `${jsonlPath} has no curated entries (only seed/empty) — sub-agent will receive only task artifacts`,
      ),
    );
  }
  return entries;
}

export function materializeFile(
  basePath: string,
  filePath: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: Budget,
): string | null {
  const data = readFileBytes(basePath, filePath);
  if (!data) {
    return null;
  }
  const size = data.length;
  if (isBinaryContent(data)) {
    const notice = `[Phronia: not inlined (binary file) — ${filePath} (${size} bytes): ${reason}]`;
    budget.add(Buffer.byteLength(notice, "utf8"));
    return notice;
  }
  const truncated = truncateUtf8(data, limits.maxFileBytes);
  let content = truncated.toString("utf8");
  if (truncated.length < size) {
    content += `\n[Phronia: truncated at ${limits.maxFileBytes} bytes — read ${filePath} for the full content]`;
  }
  return budgetedBlock(budget, filePath, filePath, content, reason, size);
}

export function materializeDirectory(
  basePath: string,
  dirPath: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: Budget,
  maxFiles = 20,
): string[] {
  const fullPath = path.join(basePath, dirPath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    return [];
  }
  const blocks: string[] = [];
  const files = fs
    .readdirSync(fullPath)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .slice(0, maxFiles);
  for (const entry of files) {
    const block = materializeFile(
      basePath,
      path.join(dirPath, entry).split(path.sep).join("/"),
      reason,
      limits,
      budget,
    );
    if (block) blocks.push(block);
  }
  return blocks;
}

export function materializeJsonlEntries(
  basePath: string,
  jsonlPath: string,
  limits: ContextInjectionLimits,
  budget: Budget,
  diagnostics: Diagnostic[],
): string[] {
  return materializeJsonlEntriesUnique(
    basePath,
    jsonlPath,
    limits,
    budget,
    diagnostics,
    null,
  );
}

/**
 * Materialize one manifest while skipping paths already emitted by another
 * one. Main-session context reads both implement.jsonl and check.jsonl, and a
 * shared spec file must not consume the budget twice.
 */
export function materializeJsonlEntriesUnique(
  basePath: string,
  jsonlPath: string,
  limits: ContextInjectionLimits,
  budget: Budget,
  diagnostics: Diagnostic[],
  seen: Set<string> | null,
): string[] {
  const blocks: string[] = [];
  for (const entry of readJsonlEntries(basePath, jsonlPath, diagnostics)) {
    const key = path.resolve(basePath, entry.file);
    if (seen?.has(key)) {
      continue;
    }
    seen?.add(key);
    if (entry.type === "directory") {
      blocks.push(
        ...materializeDirectory(basePath, entry.file, entry.reason, limits, budget),
      );
    } else {
      const block = materializeFile(basePath, entry.file, entry.reason, limits, budget);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

export function getAgentContext(
  repoRoot: string,
  taskRef: string,
  agentType: "implement" | "check",
  limits: ContextInjectionLimits,
  budget: Budget,
  diagnostics: Diagnostic[],
): string {
  const jsonlPath = `${taskRef}/${agentType}.jsonl`;
  const blocks = materializeJsonlEntries(
    repoRoot,
    jsonlPath,
    limits,
    budget,
    diagnostics,
  );
  if (blocks.length === 0) {
    return (
      `[Phronia] ${jsonlPath} has no curated entries, so no spec/research ` +
      "context was injected. Before working, read the guidelines relevant " +
      "to the code you will touch under .phronia/spec/, and treat the task " +
      "artifacts below as the only prepared context."
    );
  }
  return blocks.join("\n\n");
}

export function materializeArtifact(
  basePath: string,
  filePath: string,
  headerLabel: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: Budget,
): string | null {
  const data = readFileBytes(basePath, filePath);
  if (!data) {
    return null;
  }
  const size = data.length;
  const truncated = truncateUtf8(data, limits.maxArtifactBytes);
  let content = truncated.toString("utf8");
  if (truncated.length < size) {
    content += `\n[Phronia: truncated at ${limits.maxArtifactBytes} bytes — read ${filePath} for the full content]`;
  }
  return budgetedBlock(budget, headerLabel, filePath, content, reason, size);
}

export function getImplementContext(
  repoRoot: string,
  taskRef: string,
  limits: ContextInjectionLimits,
  diagnostics: Diagnostic[],
): string {
  const budget = new Budget(limits.maxTotalBytes);
  const parts: string[] = [];
  parts.push(getAgentContext(repoRoot, taskRef, "implement", limits, budget, diagnostics));
  appendArtifact(parts, repoRoot, taskRef, "prd.md", "(Requirements)", "Requirements document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "design.md", "(Technical Design)", "Technical design document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "implement.md", "(Execution Plan)", "Execution plan document", limits, budget);
  return parts.join("\n\n");
}

export function getCheckContext(
  repoRoot: string,
  taskRef: string,
  limits: ContextInjectionLimits,
  diagnostics: Diagnostic[],
): string {
  const budget = new Budget(limits.maxTotalBytes);
  const parts: string[] = [];
  parts.push(getAgentContext(repoRoot, taskRef, "check", limits, budget, diagnostics));
  appendArtifact(parts, repoRoot, taskRef, "prd.md", "(Requirements)", "Requirements document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "design.md", "(Technical Design)", "Technical design document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "implement.md", "(Execution Plan)", "Execution plan document", limits, budget);
  return parts.join("\n\n");
}

export function getFinishContext(
  repoRoot: string,
  taskRef: string,
  limits: ContextInjectionLimits,
  diagnostics: Diagnostic[],
): string {
  return getCheckContext(repoRoot, taskRef, limits, diagnostics);
}

export function getSessionContext(
  repoRoot: string,
  taskRef: string,
  limits: ContextInjectionLimits,
  diagnostics: Diagnostic[],
): string {
  const budget = new Budget(limits.maxTotalBytes);
  const parts: string[] = [];

  // The main session sees every task artifact and both curated manifests.
  appendArtifact(parts, repoRoot, taskRef, "prd.md", "(Requirements)", "Requirements document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "info.md", "(Task Information)", "Task information", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "design.md", "(Technical Design)", "Technical design document", limits, budget);
  appendArtifact(parts, repoRoot, taskRef, "implement.md", "(Execution Plan)", "Execution plan document", limits, budget);

  const seen = new Set<string>();
  for (const manifest of ["implement.jsonl", "check.jsonl"]) {
    if (!fs.existsSync(path.join(repoRoot, taskRef, manifest))) {
      continue;
    }
    const blocks = materializeJsonlEntriesUnique(
      repoRoot,
      `${taskRef}/${manifest}`,
      limits,
      budget,
      diagnostics,
      seen,
    );
    if (blocks.length > 0) {
      parts.push(blocks.join("\n\n"));
    }
  }

  return parts.join("\n\n");
}

export function getResearchContext(
  repoRoot: string,
  layout: { rootDirName: string; paths: { spec: string; scripts: string } },
): string {
  const specRoot = path.join(repoRoot, layout.paths.spec);
  const treeLines = [`${layout.paths.spec}/`];
  if (fs.existsSync(specRoot)) {
    const packages = fs
      .readdirSync(specRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    packages.forEach((pkg, index) => {
      const prefix = index === packages.length - 1 ? "└── " : "├── ";
      const layers = fs
        .readdirSync(path.join(specRoot, pkg), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const layerInfo = layers.length > 0 ? ` (${layers.join(", ")})` : "";
      treeLines.push(`${prefix}${pkg}/${layerInfo}`);
    });
  }
  return [
    "## Project Spec Directory Structure",
    "",
    "```",
    ...treeLines,
    "```",
    "",
    `To get structured package info, run: \`python3 ./${layout.paths.scripts}/get_context.py --mode packages\``,
    "",
    "## Search Tips",
    "",
    `- Spec files: \`${layout.paths.spec}/**/*.md\``,
    "- Code search: Use Glob and Grep tools",
    "- Tech solutions: Use mcp__exa__web_search_exa or mcp__exa__get_code_context_exa",
  ].join("\n");
}

function appendArtifact(
  parts: string[],
  repoRoot: string,
  taskRef: string,
  name: string,
  label: string,
  reason: string,
  limits: ContextInjectionLimits,
  budget: Budget,
): void {
  const filePath = `${taskRef}/${name}`;
  const block = materializeArtifact(
    repoRoot,
    filePath,
    `${filePath} ${label}`,
    reason,
    limits,
    budget,
  );
  if (block) parts.push(block);
}

function budgetedBlock(
  budget: Budget,
  header: string,
  plainPath: string,
  content: string,
  reason: string,
  sizeForIndex: number,
): string {
  const block = `=== ${header} ===\n${content}`;
  const blockBytes = Buffer.byteLength(block, "utf8");
  if (!budget.hasRoom(blockBytes)) {
    const notice = `[Phronia: not inlined (total context limit reached) — ${plainPath} (${sizeForIndex} bytes): ${reason}]`;
    budget.add(Buffer.byteLength(notice, "utf8"));
    return notice;
  }
  budget.add(blockBytes);
  return block;
}

function isContained(baseReal: string, targetReal: string): boolean {
  const relative = path.relative(baseReal, targetReal);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
