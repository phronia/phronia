/**
 * Spec status frontmatter.
 *
 * Old spec files have no frontmatter and remain `verified` so the upgrade
 * does not disable the whole ruleset. New bootstrap/update-spec output is
 * `draft` until a human verifies it; check reports draft rules as advisory.
 */

import fs from "node:fs";
import path from "node:path";
import { LAYOUT } from "../layout/index.js";

export type SpecStatus = "draft" | "verified" | "deprecated";

export interface SpecFileStatus {
  path: string;
  status: SpecStatus;
  owner?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  source?: string;
}

export interface SpecStatusSummary {
  files: SpecFileStatus[];
  counts: Record<SpecStatus, number>;
}

export function readSpecStatuses(root: string): SpecStatusSummary {
  const specRoot = path.join(root, LAYOUT.paths.spec);
  const files: SpecFileStatus[] = [];
  for (const file of walkMarkdown(specRoot)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const content = fs.readFileSync(file, "utf8");
    files.push({ path: relative, ...parseFrontmatter(content) });
  }
  const counts: Record<SpecStatus, number> = {
    draft: 0,
    verified: 0,
    deprecated: 0,
  };
  for (const file of files) counts[file.status] += 1;
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), counts };
}

export function parseFrontmatter(content: string): Omit<SpecFileStatus, "path"> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return { status: "verified" };
  const block = match[1] ?? "";
  const phronia: Record<string, string> = {};
  let inPhronia = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^phronia:\s*$/.test(line)) {
      inPhronia = true;
      continue;
    }
    if (inPhronia && /^\S/.test(line)) {
      inPhronia = false;
    }
    if (!inPhronia) continue;
    const field = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (field) phronia[field[1] ?? ""] = (field[2] ?? "").trim();
  }
  const status =
    phronia.status === "draft" || phronia.status === "deprecated"
      ? phronia.status
      : "verified";
  return {
    status,
    ...(phronia.owner ? { owner: phronia.owner } : {}),
    ...(phronia.verified_by ? { verifiedBy: phronia.verified_by } : {}),
    ...(phronia.verified_at ? { verifiedAt: phronia.verified_at } : {}),
    ...(phronia.source ? { source: phronia.source } : {}),
  };
}

/** Rewrite (or add) the phronia frontmatter block without touching the body. */
export function writeSpecStatus(
  root: string,
  relativePath: string,
  status: SpecStatus,
  options: { by?: string; at?: string } = {},
): boolean {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  const at = options.at ?? new Date().toISOString().slice(0, 10);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body = match ? content.slice(match[0].length) : content;
  const lines = [
    "---",
    "phronia:",
    `  status: ${status}`,
    ...(options.by ? [`  verified_by: ${options.by}`, `  verified_at: ${at}`] : []),
    "---",
    "",
  ];
  fs.writeFileSync(file, `${lines.join("\n")}${body}`, "utf8");
  return true;
}

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}
