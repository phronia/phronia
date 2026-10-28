import "./env-compat.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import { init } from "../commands/init.js";
import { update } from "../commands/update.js";
import { upgrade } from "../commands/upgrade.js";
import { uninstall } from "../commands/uninstall.js";
import { adopt, printAdoptReport } from "../commands/adopt.js";
import { runContextCommand } from "../commands/context.js";
import { runHookCommand } from "../commands/hook.js";
import { runDoctorCommand, runZcodeDetectCommand } from "../commands/doctor.js";
import {
  runRulesCompile,
  runRulesGate,
  runRulesList,
  runRulesVerdict,
} from "../commands/rules.js";
import {
  runWorktreeAdd,
  runWorktreeList,
  runWorktreeAttach,
  runWorktreeRemove,
  runWorktreePrune,
} from "../commands/worktree.js";
import {
  runParallelPlan,
  runParallelStatus,
  runWorkspacePrepare,
  runWorkspaceEnsure,
  runWorkspaceBind,
  runWorkspaceRelease,
  runWorkspaceReclaim,
} from "../commands/parallel.js";
import {
  runLeaseAcquire,
  runLeaseRelease,
  runLeaseStatus,
} from "../commands/lease.js";
import { runTaskCommit } from "../commands/commit.js";
import { runTaskIntegrate } from "../commands/integrate.js";
import { runTaskDispatch } from "../commands/dispatch.js";
import { runCoordinatorStatus } from "../commands/coordinator.js";
import { runTaskFootprintSet } from "../commands/footprint.js";
import {
  runSpecBootstrap,
  runSpecSetStatus,
  runSpecStatus,
} from "../commands/spec.js";
import { runDocsGenerate } from "../commands/docs.js";
import { runOnboard } from "../commands/onboard.js";
import {
  runCrossRepoAttach,
  runCrossRepoStatus,
} from "../commands/cross-repo.js";
import { SessionStore } from "@phronia/core";
import { ablate, restore } from "../commands/ablate.js";
import { runMem } from "../commands/mem.js";
import {
  runWorkflowCommand,
  WorkflowCommandError,
} from "../commands/workflow.js";
import { registerChannelCommand } from "../commands/channel/index.js";
import { DIR_NAMES } from "../constants/paths.js";
import { PACKAGE_NAME, VERSION } from "../constants/version.js";
import { compareVersions } from "../utils/compare-versions.js";
import { getConfiguredPlatforms } from "../configurators/index.js";
import { AI_TOOLS, getManagedPaths } from "../types/ai-tools.js";
import {
  CAPABILITIES,
  PLATFORM_IDS,
  validateCapabilities,
} from "@phronia/core";
import {
  checkMatrixStructure,
  renderMatrixMarkdown,
  renderMatrixTable,
} from "./platform-matrix.js";

// Re-export for backwards compatibility (consumers should prefer constants/version.js)
export { VERSION, PACKAGE_NAME };

/**
 * Check if a Phronia update is available (compare project version with CLI version)
 */
function checkForUpdates(cwd: string): void {
  const versionFile = path.join(cwd, DIR_NAMES.WORKFLOW, ".version");

  if (!fs.existsSync(versionFile)) return;

  const projectVersion = fs.readFileSync(versionFile, "utf-8").trim();
  const cliVersion = VERSION;
  const comparison = compareVersions(cliVersion, projectVersion);

  if (comparison > 0) {
    // CLI is newer than project - update available.
    // stderr only: commands such as `context --json` are parsed by hooks, so
    // the notice must never share stdout with the machine-readable payload.
    process.stderr.write(
      chalk.yellow(
        `\n⚠️  Phronia update available: ${projectVersion} → ${cliVersion}\n`,
      ),
    );
    process.stderr.write(chalk.gray(`   Run: phronia update\n`));
  } else if (comparison < 0) {
    // CLI is older than project - CLI needs updating
    process.stderr.write(
      chalk.yellow(
        `\n⚠️  Your CLI (${cliVersion}) is older than project (${projectVersion})\n`,
      ),
    );
    process.stderr.write(chalk.gray(`   Run: phronia upgrade\n`));
  }
}

// `trellis` remains a one-major compatibility alias.
const invokedAs = path.basename(process.argv[1] ?? "");
if (invokedAs === "trellis" || invokedAs === "trellis.js") {
  process.stderr.write(
    "ℹ️  `trellis` is a manual legacy compatibility entry point; use `phronia`.\n",
  );
}

// Check for updates at CLI startup (only if .phronia exists). Hook-driven
// context calls run on every prompt; skip them entirely instead of emitting
// stderr noise into the harness log.
const cliArgs = process.argv.slice(2);
const hookContextInvocation =
  cliArgs[0] === "context" ||
  cliArgs[0] === "hook" ||
  cliArgs.includes("--render");
const cwd = process.cwd();
if (
  !hookContextInvocation &&
  fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW))
) {
  checkForUpdates(cwd);
}

const program = new Command();

program
  .name("phronia")
  .description(
    "Phronia — an AI-assisted development workflow framework for Cursor, Claude Code, and more",
  )
  .version(VERSION, "-v, --version", "output the version number");

program
  .command("init")
  .description("Initialize Phronia in the current project")
  .option("--cursor", "Include Cursor commands")
  .option("--claude", "Include Claude Code commands")
  .option("--opencode", "Include OpenCode commands")
  .option("--codex", "Include Codex skills")
  .option("--kilo", "Include Kilo CLI commands")
  .option("--kiro", "Include Kiro Code skills")
  .option("--gemini", "Include Gemini CLI commands")
  .option("--antigravity", "Include Antigravity workflows")
  .option("--devin", "Include Devin workflows")
  .option("--windsurf", "Deprecated alias for --devin (Windsurf was renamed)")
  .option("--qoder", "Include Qoder commands")
  .option("--codebuddy", "Include CodeBuddy commands")
  .option("--copilot", "Include GitHub Copilot hooks")
  .option("--droid", "Include Factory Droid commands")
  .option("--dsh", "Include DeepSeek Harness (dsh) skills")
  .option("--pi", "Include Pi Agent extension assets")
  .option("--reasonix", "Include Reasonix skills")
  .option("--zcode", "Include ZCode commands")
  .option("--omp", "Include Oh My Pi extension assets")
  .option("--trae", "Include Trae IDE commands")
  .option("--grok", "Include Grok Build skills and agents")
  .option("--kimi", "Include Kimi Code skills")
  .option("--snow", "Include Snow CLI skills and commands")
  .option(
    "--with-statusline",
    "Install the Phronia statusLine for Claude Code (off by default)",
  )
  .option("-y, --yes", "Skip prompts and use defaults")
  .option(
    "-u, --user <name>",
    "Initialize developer identity with specified name",
  )
  .option("-f, --force", "Overwrite existing files without asking")
  .option("-s, --skip-existing", "Skip existing files without asking")
  .option("--monorepo", "Force monorepo mode")
  .option("--no-monorepo", "Skip monorepo detection")
  .option(
    "-t, --template <name>",
    "Use a remote spec template (e.g., electron-fullstack)",
  )
  .option(
    "--overwrite",
    "Overwrite existing spec directory when using template",
  )
  .option("--append", "Only add missing files when using template")
  .option(
    "-r, --registry <source>",
    "Use a custom template registry (e.g., gh:myorg/myrepo/specs)",
  )
  .option(
    "--workflow <id>",
    "Workflow template id for .phronia/workflow.md (default: native; e.g., tdd, channel-driven-subagent-dispatch)",
  )
  .option(
    "--workflow-source <source>",
    "Custom marketplace source for the --workflow lookup (e.g., gh:myorg/myrepo/marketplace)",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      // Deprecated alias: --windsurf → --devin (Windsurf was renamed to Devin).
      if (options.windsurf) {
        console.log(
          chalk.yellow(
            "⚠ --windsurf is deprecated (Windsurf was renamed to Devin). Use --devin instead.",
          ),
        );
        options.devin = true;
        delete options.windsurf;
      }
      await init(options);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Update Phronia configuration and commands to latest version")
  .option("--dry-run", "Preview changes without applying them")
  .option("-f, --force", "Overwrite all changed files without asking")
  .option("-s, --skip-all", "Skip all changed files without asking")
  .option("-n, --create-new", "Create .new copies for all changed files")
  .option("--allow-downgrade", "Allow downgrading to an older version")
  .option("--migrate", "Apply pending file migrations (renames/deletions)")
  .action(async (options: Record<string, unknown>) => {
    try {
      await update({
        dryRun: options.dryRun as boolean,
        force: options.force as boolean,
        skipAll: options.skipAll as boolean,
        createNew: options.createNew as boolean,
        allowDowngrade: options.allowDowngrade as boolean,
        migrate: options.migrate as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("upgrade")
  .description("Upgrade the global Phronia CLI package")
  .option(
    "--tag <tag>",
    "npm dist-tag or version to install (default follows current channel: latest, beta, or rc)",
  )
  .option("--dry-run", "Print the install command without running it")
  .action(async (options: Record<string, unknown>) => {
    try {
      await upgrade({
        tag: options.tag as string | undefined,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("adopt")
  .description(
    "Adopt an upstream Phronia project (rename the workflow root and regenerate platform files)",
  )
  .option("--dry-run", "Report what would change without touching files")
  .option("--force", "Proceed even when the git working tree is dirty")
  .option("--json", "Print the adoption report as JSON")
  .option(
    "--backup-root <dir>",
    "Root directory for the pre-adoption backup (default: ~/.phronia/backups)",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      const report = await adopt({
        cwd: process.cwd(),
        dryRun: options.dryRun as boolean,
        force: options.force as boolean,
        json: options.json as boolean,
        backupRoot: options.backupRoot as string | undefined,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printAdoptReport(report);
      }
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("uninstall")
  .description(
    "Remove all Phronia files (managed platform files + .phronia/) from this project",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "List what would be removed without changing anything")
  .action(async (options: Record<string, unknown>) => {
    try {
      await uninstall({
        yes: options.yes as boolean,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("ablate")
  .description(
    "Temporarily remove all project Phronia surfaces with an external recovery transaction",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "Preview full ablation without changing files or state")
  .action(async (options: Record<string, unknown>) => {
    try {
      await ablate({
        yes: options.yes as boolean,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("restore")
  .description("Restore the exact project state saved by `phronia ablate`")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "Preview restoration and check conflicts")
  .action(async (options: Record<string, unknown>) => {
    try {
      await restore({
        yes: options.yes as boolean,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("mem")
  .description(
    "Search/recall AI conversation history across Claude Code, Codex, OpenCode, Pi (run 'phronia mem help' for subcommands and flags)",
  )
  .allowUnknownOption(true)
  .helpOption(false)
  .argument(
    "[args...]",
    "subcommand and arguments (list|search|context|extract|projects|help)",
  )
  .action((args: string[] = []) => {
    try {
      runMem(args);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("workflow")
  .description(
    "List or switch the project's .phronia/workflow.md template (native, tdd, channel-driven-subagent-dispatch, or marketplace)",
  )
  .option(
    "-t, --template <id>",
    "Workflow template id (e.g., native, tdd, channel-driven-subagent-dispatch)",
  )
  .option(
    "-m, --marketplace <source>",
    "Custom marketplace source (e.g., gh:myorg/myrepo/marketplace)",
  )
  .option("--list", "List available workflow templates and exit")
  .option("-f, --force", "Overwrite a modified workflow.md without asking")
  .option(
    "-n, --create-new",
    "Write .phronia/workflow.md.new instead of replacing the active workflow",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      await runWorkflowCommand({
        template: options.template as string | undefined,
        marketplace: options.marketplace as string | undefined,
        list: options.list as boolean | undefined,
        force: options.force as boolean | undefined,
        createNew: options.createNew as boolean | undefined,
      });
    } catch (error) {
      if (error instanceof WorkflowCommandError) {
        console.error(chalk.red("Error:"), error.message);
        process.exit(1);
      }
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("context")
  .description("Build harness-neutral context for an event (session-start, user-prompt, ...)")
  .option("--event <event>", "Context event")
  .option("--platform <id>", "Platform id (claude-code, cursor, opencode, ...)")
  .option("--adapter <id>", "Adapter id observed by the shim (opencode@v2, ...)")
  .option("--project-root <path>", "Explicit project root")
  .option("--input <path>", "Input JSON file, or - for stdin", "-")
  .option("--render", "Render the harness envelope instead of JSON")
  .option("--schema", "Print the context JSON Schema and exit")
  .option("--json", "Output the versioned JSON plan (default)")
  .action((options: Record<string, unknown>) => {
    const exitCode = runContextCommand({
      event: (options.event as never) ?? ("session-start" as never),
      platform: (options.platform as string) ?? "",
      adapter: options.adapter as string | undefined,
      projectRoot: options.projectRoot as string | undefined,
      input: (options.input as string) ?? "-",
      render: Boolean(options.render),
      schema: Boolean(options.schema),
      json: Boolean(options.json),
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

program
  .command("doctor")
  .description("Report platform capability and environment feature availability")
  .option("--platform <id>", "Inspect one platform instead of configured ones")
  .option("--json", "Output machine-readable JSON")
  .option("--no-probe", "Skip `harness --version` probes")
  .option("--refresh-manifest", "Rewrite .phronia/manifest.json from this run")
  .option("--no-fix", "Do not install or repair the project-local ZCode plugin")
  .option("--check", "Exit non-zero on unsupported or schema-drift adapters")
  .action((options: Record<string, unknown>) => {
    const exitCode = runDoctorCommand({
      cwd,
      platform: options.platform as string | undefined,
      json: Boolean(options.json),
      probe: options.probe !== false,
      refreshManifest: Boolean(options.refreshManifest),
      check: Boolean(options.check),
      fix: options.fix !== false,
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

const specCommand = program
  .command("spec")
  .description("Inspect and manage spec status");

specCommand
  .command("status")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    process.exitCode = runSpecStatus({ cwd, json: Boolean(options.json) });
  });

specCommand
  .command("verify <paths...>")
  .option("--by <name>", "Who verified the spec")
  .option("--json", "Output machine-readable JSON")
  .action((paths: string[], options: Record<string, unknown>) => {
    process.exitCode = runSpecSetStatus("verified", paths, {
      cwd,
      by: options.by as string | undefined,
      json: Boolean(options.json),
    });
  });

specCommand
  .command("deprecate <paths...>")
  .option("--json", "Output machine-readable JSON")
  .action((paths: string[], options: Record<string, unknown>) => {
    process.exitCode = runSpecSetStatus("deprecated", paths, {
      cwd,
      json: Boolean(options.json),
    });
  });

specCommand
  .command("bootstrap")
  .option("--dry-run", "Only report missing index files")
  .option("--write", "Create draft index files for missing layers")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    process.exitCode = runSpecBootstrap({
      cwd,
      dryRun: Boolean(options.dryRun),
      write: Boolean(options.write),
      json: Boolean(options.json),
    });
  });

program
  .command("docs")
  .description("Knowledge-layer operations")
  .command("generate")
  .option("--check", "Exit non-zero when docs/requirements.md is stale")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    process.exitCode = runDocsGenerate({
      cwd,
      check: Boolean(options.check),
      json: Boolean(options.json),
    });
  });

program
  .command("onboard")
  .description("Print or write a project onboarding brief")
  .option("--write", "Write docs/onboarding.md")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    process.exitCode = runOnboard({
      cwd,
      write: Boolean(options.write),
      json: Boolean(options.json),
    });
  });

const sessionCommand = program
  .command("session")
  .description("Session runtime operations");

sessionCommand
  .command("gc")
  .option("--ttl-days <n>", "Delete entries older than N days", "30")
  .option("--dry-run", "Report without deleting")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const report = new SessionStore(cwd).gc({
      ttlDays: Number(options.ttlDays ?? 30),
      dryRun: Boolean(options.dryRun),
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `${report.dryRun ? "would remove" : "removed"} ${report.removed.length} session(s); kept ${report.kept}.`,
    );
    for (const file of report.removed) console.log(`  ${file}`);
  });

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

const taskCommand = program
  .command("task")
  .description("Task-scoped operations");

const worktreeCommand = taskCommand
  .command("worktree")
  .description("Create, list, attach, prune, and remove per-task git worktrees");

worktreeCommand
  .command("add <task-ref>")
  .option("--path <dir>", "Worktree directory")
  .option("--branch <name>", "Branch to create or reuse")
  .option("--base <ref>", "Base revision for a new branch")
  .option("--copy <path>", "Copy a path into the worktree (repeatable)", collect, [])
  .option("--post-create <cmd>", "Run a command in the worktree (repeatable)", collect, [])
  .option("--force", "Allow a dirty main checkout")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runWorktreeAdd(taskRef, {
      cwd,
      path: options.path as string | undefined,
      branch: options.branch as string | undefined,
      base: options.base as string | undefined,
      force: Boolean(options.force),
      copy: options.copy as string[],
      postCreate: options.postCreate as string[],
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

worktreeCommand
  .command("list")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runWorktreeList({ cwd, json: Boolean(options.json) });
    if (code !== 0) process.exitCode = code;
  });

worktreeCommand
  .command("attach <task-ref>")
  .option("--path <dir>", "Existing platform worktree")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runWorktreeAttach(taskRef, {
      cwd,
      path: options.path as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

worktreeCommand
  .command("prune")
  .option("--dry-run", "Show what would be removed")
  .option("--older-than <duration>", "Only consider worktrees older than e.g. 7d/12h")
  .option("--delete-branch", "Delete branches after removal")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runWorktreePrune({
      cwd,
      dryRun: Boolean(options.dryRun),
      olderThan: options.olderThan as string | undefined,
      deleteBranch: Boolean(options.deleteBranch),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const crossRepoCommand = taskCommand
  .command("cross-repo")
  .description("Link tasks across repositories (git as transport)");

crossRepoCommand
  .command("attach <task-ref> <repos...>")
  .option("--consume <repo:path@ref>", "Record a spec dependency (repeatable)", (value, previous: string[] = []) => [...previous, value], [])
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, repos: string[], options: Record<string, unknown>) => {
    process.exitCode = runCrossRepoAttach(taskRef, repos, {
      cwd,
      json: Boolean(options.json),
      consumes: options.consume as string[],
    });
  });

crossRepoCommand
  .command("status <task-ref>")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    process.exitCode = runCrossRepoStatus(taskRef, {
      cwd,
      json: Boolean(options.json),
    });
  });

worktreeCommand
  .command("remove <task-ref>")
  .option("--force", "Remove even with uncommitted changes")
  .option("--delete-branch", "Delete the task branch after removal")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runWorktreeRemove(taskRef, {
      cwd,
      force: Boolean(options.force),
      deleteBranch: Boolean(options.deleteBranch),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const parallelCommand = taskCommand
  .command("parallel")
  .description("Plan and inspect parallel task batches");

parallelCommand
  .command("plan [refs...]")
  .option("--include-planning", "Include planning tasks")
  .option("--max <n>", "Maximum tasks per wave", (value) => Number(value))
  .option("--allow-unknown", "Allow tasks with unknown footprints to share a wave")
  .option("--explain", "Print the reason for every wave decision")
  .option("--json", "Output machine-readable JSON")
  .action((refs: string[], options: Record<string, unknown>) => {
    const code = runParallelPlan({
      cwd,
      refs,
      includePlanning: Boolean(options.includePlanning),
      max: options.max as number | undefined,
      allowUnknown: Boolean(options.allowUnknown),
      explain: Boolean(options.explain),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

parallelCommand
  .command("status")
  .option("--platform <id>", "Harness id for the coordinator capability gate")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runParallelStatus({
      cwd,
      platform: options.platform as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

parallelCommand
  .command("dispatch")
  .description("Emit a coordinator dispatch manifest (Phronia starts no agent process)")
  .requiredOption("--batch <id>", "Batch id recorded in the shared runtime")
  .option("--wave <n>", "1-based wave to dispatch", (value) => Number(value))
  .option("--max <n>", "Maximum tasks per wave", (value) => Number(value))
  .option("--include-planning", "Include planning tasks")
  .option("--dry-run", "Show the manifest without creating worktrees or leases")
  .option("--platform <id>", "Override harness detection")
  .option("--session-key <key>", "Coordinator session key")
  .option("--owner-id <id>", "Lease owner id recorded for dispatched tasks")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runTaskDispatch({
      cwd,
      batch: options.batch as string,
      wave: options.wave as number | undefined,
      max: options.max as number | undefined,
      includePlanning: Boolean(options.includePlanning),
      dryRun: Boolean(options.dryRun),
      platform: options.platform as string | undefined,
      sessionKey: options.sessionKey as string | undefined,
      ownerId: options.ownerId as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const workspaceCommand = taskCommand
  .command("workspace")
  .description("Prepare, bind, release, and reclaim task workspaces");

workspaceCommand
  .command("prepare")
  .option("--for-new-task <title>", "Create a provisional workspace when main is occupied")
  .option("--force", "Accept a dirty/occupied main checkout")
  .option("--reuse-dirty", "Reuse a dirty main checkout")
  .option("--session-key <key>", "Override the session identity")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runWorkspacePrepare({
      cwd,
      forNewTask: options.forNewTask as string | undefined,
      force: Boolean(options.force),
      reuseDirty: Boolean(options.reuseDirty),
      sessionKey: options.sessionKey as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

workspaceCommand
  .command("ensure <task-ref>")
  .option("--path <dir>", "Attach an existing (platform) worktree")
  .option("--force", "Accept a dirty main checkout")
  .option("--reuse-dirty", "Reuse a dirty main checkout")
  .option("--copy-task", "Copy the task directory instead of requiring a scoped commit")
  .option("--copy <path>", "Copy a path into the worktree (repeatable)", collect, [])
  .option("--post-create <cmd>", "Run a command in the worktree (repeatable)", collect, [])
  .option("--session-key <key>", "Override the session identity")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runWorkspaceEnsure(taskRef, {
      cwd,
      path: options.path as string | undefined,
      force: Boolean(options.force),
      reuseDirty: Boolean(options.reuseDirty),
      copyTask: Boolean(options.copyTask),
      copy: options.copy as string[],
      postCreate: options.postCreate as string[],
      sessionKey: options.sessionKey as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

workspaceCommand
  .command("bind <task-ref>")
  .option("--path <dir>", "Provisional worktree path (defaults to cwd)")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runWorkspaceBind(taskRef, {
      cwd,
      path: options.path as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

workspaceCommand
  .command("release")
  .option("--force", "Release another session's claim")
  .option("--session-key <key>", "Override the session identity")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runWorkspaceRelease({
      cwd,
      force: Boolean(options.force),
      sessionKey: options.sessionKey as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

workspaceCommand
  .command("reclaim")
  .option("--force", "Reclaim even when checks would otherwise refuse")
  .option("--session-key <key>", "Override the session identity")
  .option("--ttl <seconds>", "Claim TTL for the new claim", (value) => Number(value))
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runWorkspaceReclaim({
      cwd,
      force: Boolean(options.force),
      sessionKey: options.sessionKey as string | undefined,
      ttlSeconds: options.ttl as number | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const leaseCommand = taskCommand
  .command("lease")
  .description("Acquire, release, and inspect task leases");

leaseCommand
  .command("acquire <task-ref>")
  .option("--owner-type <type>", "session | subagent | task", "session")
  .option("--owner-id <id>", "Owner identity")
  .option("--session-key <key>", "Session key recorded on the lease")
  .option("--workspace <dir>", "Workspace recorded on the lease")
  .option("--ttl <seconds>", "Lease TTL", (value) => Number(value))
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runLeaseAcquire(taskRef, {
      cwd,
      ownerType: options.ownerType as "session" | "subagent" | "task",
      ownerId: options.ownerId as string | undefined,
      sessionKey: options.sessionKey as string | undefined,
      workspace: options.workspace as string | undefined,
      ttlSeconds: options.ttl as number | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

leaseCommand
  .command("release <task-ref>")
  .option("--session-key <key>", "Session key that owns the lease")
  .option("--force", "Release another session's lease")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runLeaseRelease(taskRef, {
      cwd,
      sessionKey: options.sessionKey as string | undefined,
      force: Boolean(options.force),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

leaseCommand
  .command("status <task-ref>")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runLeaseStatus(taskRef, { cwd, json: Boolean(options.json) });
    if (code !== 0) process.exitCode = code;
  });

const footprintCommand = taskCommand
  .command("footprint")
  .description("Declare the paths/globs a parallel task may change");

footprintCommand
  .command("set <task-ref> [paths...]")
  .option("--clear", "Clear the declared footprint")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, paths: string[], options: Record<string, unknown>) => {
    const code = runTaskFootprintSet(taskRef, {
      cwd,
      paths,
      clear: Boolean(options.clear),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const coordinatorCommand = taskCommand
  .command("coordinator")
  .description("Inspect coordinator batches and capability status");

coordinatorCommand
  .command("status")
  .option("--batch <id>", "Limit the report to a dispatched batch")
  .option("--platform <id>", "Override harness detection")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const code = runCoordinatorStatus({
      cwd,
      batch: options.batch as string | undefined,
      platform: options.platform as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

taskCommand
  .command("integrate [task-ref]")
  .description("Land a task locally or hand it off to a remote forge")
  .option("--mode <mode>", "auto | local | remote", "auto")
  .option("--base <branch>", "Integration branch (defaults to the task/base branch)")
  .option("--queue", "Enqueue when the integration lock or main claim is busy")
  .option("--wait", "Wait for this task's queue turn and the integration lock")
  .option("--drain", "Process queued integrations in FIFO order")
  .option("--verify <cmd>", "Verification command (repeatable)", collect, [])
  .option("--no-verify", "Skip verification explicitly")
  .option("--timeout <duration>", "Wait/verification timeout (e.g. 30m)")
  .option("--interactive", "Always ask for the integration mode")
  .option("--yes", "Skip mode confirmation")
  .option("--handoff", "Write an integration handoff report on failure")
  .option("--dry-run", "Show the resolved mode and planned git commands")
  .option("--recover", "Recover an interrupted integration")
  .option("--rollback", "Roll back to preLandSha after explicit confirmation")
  .option("--force", "Reclaim a TTL-expired claim owned by an active task")
  .option("--sync", "Remote only: fetch the base and detect a merged change request")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string | undefined, options: Record<string, unknown>) => {
    // Commander stores `--no-verify` as `verify === false`; it shares the key
    // with the repeatable `--verify <cmd>` option.
    const verify = options.verify;
    const code = runTaskIntegrate(taskRef ?? null, {
      cwd,
      mode: options.mode as "auto" | "local" | "remote",
      base: options.base as string | undefined,
      queue: Boolean(options.queue),
      wait: Boolean(options.wait),
      drain: Boolean(options.drain),
      verify: Array.isArray(verify) ? (verify as string[]) : undefined,
      noVerify: verify === false,
      timeout: options.timeout as string | undefined,
      interactive: Boolean(options.interactive),
      yes: Boolean(options.yes),
      handoff: Boolean(options.handoff),
      dryRun: Boolean(options.dryRun),
      recover: Boolean(options.recover),
      rollback: Boolean(options.rollback),
      force: Boolean(options.force),
      sync: Boolean(options.sync),
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

taskCommand
  .command("commit <task-ref>")
  .description("Commit all changes inside a task worktree")
  .option("-m, --message <message>", "Commit message")
  .option("--json", "Output machine-readable JSON")
  .action((taskRef: string, options: Record<string, unknown>) => {
    const code = runTaskCommit(taskRef, {
      cwd,
      message: options.message as string | undefined,
      json: Boolean(options.json),
    });
    if (code !== 0) process.exitCode = code;
  });

const rulesCommand = program
  .command("rules")
  .description("Compile and inspect the specification rule ledger");

rulesCommand
  .command("compile")
  .option("--json", "Output machine-readable JSON")
  .option("--check", "Exit non-zero when the ledger has errors")
  .action((options: Record<string, unknown>) => {
    const exitCode = runRulesCompile({ cwd, ...options });
    if (exitCode !== 0) process.exit(exitCode);
  });

rulesCommand
  .command("gate")
  .option("--changed", "Check changed paths against protected scopes")
  .option("--task <ref>", "Task whose check-results.json provides verdicts")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const exitCode = runRulesGate({
      cwd,
      changed: Boolean(options.changed),
      task: options.task as string | undefined,
      json: Boolean(options.json),
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

rulesCommand
  .command("verdict")
  .requiredOption("--task <ref>", "Task directory reference")
  .requiredOption("--input <file>", "Verdict JSON file, or - for stdin")
  .option("--check", "Exit non-zero on unknown rules or a failed verdict")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const exitCode = runRulesVerdict({
      cwd,
      task: options.task as string,
      input: options.input as string,
      check: Boolean(options.check),
      json: Boolean(options.json),
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

rulesCommand
  .command("list")
  .option("--severity <level>", "Filter by severity")
  .option("--status <status>", "Filter by status")
  .option("--json", "Output machine-readable JSON")
  .option("--check", "Exit non-zero when the ledger has errors")
  .action((options: Record<string, unknown>) => {
    const exitCode = runRulesList({ cwd, ...options });
    if (exitCode !== 0) process.exit(exitCode);
  });

program
  .command("hook", { hidden: true })
  .description("Internal harness hook bridge (resolves the project root from cwd)")
  .requiredOption("--platform <id>", "Harness platform")
  .requiredOption("--event <event>", "Hook event")
  .action((options: Record<string, unknown>) => {
    const exitCode = runHookCommand({
      platform: String(options.platform),
      event: String(options.event),
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

program
  .command("zcode")
  .description("Inspect the ZCode integration path selected for this machine")
  .command("detect")
  .option("--json", "Output machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const exitCode = runZcodeDetectCommand({
      cwd,
      json: Boolean(options.json),
    });
    if (exitCode !== 0) process.exit(exitCode);
  });

program
  .command("platforms")
  .description(
    "Show which AI platforms are configured (active) in the current project",
  )
  .option("--json", "Output machine-readable JSON")
  .option("--matrix", "Print the full capability matrix")
  .option("--markdown", "Print the capability matrix as Markdown (for docs)")
  .option("--detect", "Probe harness versions and rewrite .phronia/manifest.json")
  .option("--check", "Validate capability coverage and exit non-zero on failure")
  .action((options: Record<string, unknown>) => {
    try {
      if (options.detect) {
        const exitCode = runDoctorCommand({
          cwd,
          json: Boolean(options.json),
          refreshManifest: true,
        });
        if (exitCode !== 0) process.exit(exitCode);
        return;
      }
      if (options.check) {
        const problems = checkMatrixStructure().problems;
        for (const violation of validateCapabilities()) {
          problems.push(`${violation.platform}: ${violation.message}`);
        }
        const templatesRoot = fileURLToPath(
          new URL("../templates", import.meta.url),
        );
        for (const id of PLATFORM_IDS) {
          const tool = AI_TOOLS[id];
          for (const dir of tool.templateDirs) {
            if (dir === "common") continue;
            if (!fs.existsSync(path.join(templatesRoot, dir))) {
              problems.push(`${id}: template directory missing: ${dir}`);
            }
          }
          const managed = getManagedPaths(id);
          if (new Set(managed).size !== managed.length) {
            problems.push(`${id}: duplicate managed path`);
          }
          if (managed.some((entry) => !entry)) {
            problems.push(`${id}: empty managed path`);
          }
        }
        const docsFile = path.join(cwd, "docs", "platform-matrix.md");
        if (fs.existsSync(docsFile)) {
          const expected = renderMatrixMarkdown();
          const actual = fs.readFileSync(docsFile, "utf8");
          if (actual !== expected) {
            problems.push(
              "docs/platform-matrix.md is stale; run `phronia platforms --matrix --markdown > docs/platform-matrix.md`",
            );
          }
        }
        if (problems.length > 0) {
          for (const problem of problems) console.error(chalk.red(`  ${problem}`));
          process.exit(1);
        }
        console.log(chalk.green(`Capability matrix covers ${PLATFORM_IDS.length} platforms.`));
        return;
      }

      if (options.matrix) {
        const matrix = PLATFORM_IDS.map((id) => ({
          id,
          displayName: AI_TOOLS[id].name,
          ...CAPABILITIES[id],
        }));
        if (options.json) {
          console.log(JSON.stringify({ platforms: matrix }, null, 2));
          return;
        }
        if (options.markdown) {
          process.stdout.write(renderMatrixMarkdown());
          return;
        }
        console.log(renderMatrixTable());
        return;
      }

      const configured = getConfiguredPlatforms(cwd);
      const platforms = [...configured].map((id) => ({
        id,
        displayName: AI_TOOLS[id].name,
        configDir: AI_TOOLS[id].configDir,
      }));

      if (options.json) {
        console.log(JSON.stringify({ platforms }, null, 2));
        return;
      }

      if (platforms.length === 0) {
        console.log(chalk.gray("No platforms configured in this project."));
        return;
      }

      console.log(chalk.bold("Configured platforms:"));
      for (const p of platforms) {
        console.log(`  ${p.displayName} (${p.id}) — ${p.configDir}`);
      }
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (process.env.DEBUG || process.env.PHRONIA_DEBUG) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });



registerChannelCommand(program);

program.parse();
