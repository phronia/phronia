/**
 * `phronia onboard` — a project brief for a new contributor.
 *
 * Reads config, workflow, platform matrix, and spec status. It never creates
 * a fake `00-join-*` task.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITIES,
  LAYOUT,
  nodeFs,
  readConfig,
  readSpecStatuses,
} from "@phronia/core";
import { getConfiguredPlatforms } from "../configurators/index.js";
import { AI_TOOLS } from "../types/ai-tools.js";

export interface OnboardOptions {
  cwd: string;
  write?: boolean;
  json?: boolean;
}

export function runOnboard(options: OnboardOptions): number {
  const root = path.resolve(options.cwd);
  const configured = [...getConfiguredPlatforms(root)].sort();
  const spec = readSpecStatuses(root);
  let config = "not initialized";
  try {
    const view = readConfig(root, nodeFs).value;
    config = view.packages ? `${Object.keys(view.packages).length} package(s)` : "single repo";
  } catch {
    config = "not initialized";
  }

  const report = {
    projectRoot: root,
    workflowRoot: LAYOUT.paths.root,
    config,
    platforms: configured.map((id) => ({
      id,
      name: AI_TOOLS[id].name,
      loopControl: CAPABILITIES[id].loopControl,
    })),
    spec: spec.counts,
  };

  const markdown = renderOnboarding(report);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, markdown }, null, 2)}\n`);
    return 0;
  }
  if (options.write) {
    const target = path.join(root, "docs", "onboarding.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, "utf8");
    process.stdout.write(`Wrote ${target}.\n`);
    return 0;
  }
  process.stdout.write(markdown);
  return 0;
}

function renderOnboarding(report: {
  projectRoot: string;
  workflowRoot: string;
  config: string;
  platforms: { id: string; name: string; loopControl: string }[];
  spec: { verified: number; draft: number; deprecated: number };
}): string {
  return [
    "# Onboarding",
    "",
    `Project: \`${report.projectRoot}\``,
    `Workflow root: \`${report.workflowRoot}\``,
    `Configuration: ${report.config}`,
    "",
    "## Workflow",
    "",
    "1. Plan: create or resume a task; write `prd.md` and `design.md`.",
    "2. Execute: `/phronia:continue`, implement, and check against spec.",
    "3. Finish: `/phronia:finish-work`, archive the task, open a PR.",
    "",
    "## Platforms",
    "",
    report.platforms.length > 0
      ? report.platforms
          .map(
            (platform) =>
              `- ${platform.name} (\`${platform.id}\`) — loop control: ${platform.loopControl}`,
          )
          .join("\n")
      : "- No platform configured yet; run `phronia init`.",
    "",
    "## Spec",
    "",
    `${report.spec.verified} verified, ${report.spec.draft} draft, ${report.spec.deprecated} deprecated.`,
    "Draft specs are advisory; verify them with `phronia spec verify <path> --by <name>`.",
    "",
    "## Commands",
    "",
    "```bash",
    "phronia doctor                 # capabilities, adapters, handshakes",
    "phronia task worktree add <ref> # isolated serial workspace",
    "phronia mem floor <query>      # journals/tasks/spec recall",
    "phronia rules compile          # refresh the rule ledger",
    "```",
    "",
  ].join("\n");
}
