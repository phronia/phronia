import chalk from "chalk";
import type { Command } from "commander";

import { isProvider, listProviders, type Provider } from "./adapters/index.js";
import { createChannel } from "./create.js";
import { parseTrace } from "./dev-parse-trace.js";
import { channelKill } from "./kill.js";
import { channelList } from "./list.js";
import { channelMessages } from "./messages.js";
import { channelPrune, channelRm } from "./rm.js";
import { channelSend } from "./send.js";
import { channelRun } from "./run.js";
import { channelSpawn } from "./spawn.js";
import { runSupervisor } from "./supervisor.js";
import { channelWait, parseDuration } from "./wait.js";

export function registerChannelCommand(program: Command): void {
  const channel = program
    .command("channel")
    .description(
      "Multi-agent collaboration runtime — spawn / coordinate / interrupt worker agents through a shared event log",
    );

  channel
    .command("create <name>")
    .description("Create a new channel (collaboration session)")
    .option("--task <path>", "associated Trellis task directory")
    .option("--project <slug>", "project slug")
    .option("--labels <csv>", "comma-separated labels")
    .option("--cwd <path>", "working directory recorded in the create event")
    .option("--by <agent>", "agent name recorded as the creator", "main")
    .option("--force", "overwrite existing channel with the same name")
    .option(
      "--ephemeral",
      "mark as ephemeral — hidden from `channel list` by default and cleanable via `channel prune --ephemeral`",
    )
    .action(
      async (
        name: string,
        opts: {
          task?: string;
          project?: string;
          labels?: string;
          cwd?: string;
          by?: string;
          force?: boolean;
          ephemeral?: boolean;
        },
      ) => {
        try {
          await createChannel(name, opts);
        } catch (err) {
          console.error(
            chalk.red("Error:"),
            err instanceof Error ? err.message : err,
          );
          process.exit(1);
        }
      },
    );

  channel
    .command("send <name>")
    .description("Send a message into the channel")
    .requiredOption("--as <agent>", "agent name sending")
    .option("--kind <tag>", "tag (e.g. interrupt / phase_done / question)")
    .option(
      "--to <agents>",
      "comma-separated target agents (default: broadcast)",
    )
    .option("--stdin", "read message body from stdin")
    .option("--text-file <path>", "read message body from file")
    .argument(
      "[text]",
      "inline text body (otherwise use --stdin / --text-file)",
    )
    .action(
      async (
        name: string,
        text: string | undefined,
        raw: Record<string, unknown>,
      ) => {
        const opts = raw as {
          as: string;
          kind?: string;
          to?: string;
          stdin?: boolean;
          textFile?: string;
        };
        try {
          await channelSend(name, {
            as: opts.as,
            text,
            stdin: opts.stdin,
            textFile: opts.textFile,
            kind: opts.kind,
            to: opts.to,
          });
        } catch (err) {
          console.error(
            chalk.red("Error:"),
            err instanceof Error ? err.message : err,
          );
          process.exit(1);
        }
      },
    );

  channel
    .command("wait <name>")
    .description("Block until an event matching the filter arrives, or timeout")
    .requiredOption("--as <agent>", "agent name waiting")
    .option("--timeout <duration>", "max wait (e.g. 30s, 2m, 1h)")
    .option("--from <agents>", "only wake on events from these agents (CSV)")
    .option("--kind <kind>", "only wake on this event kind")
    .option("--tag <tag>", "only wake on this user tag")
    .option(
      "--to <target>",
      "only wake on events targeted to this name (default: own agent)",
    )
    .option("--include-progress", "also wake on progress events")
    .option(
      "--all",
      "wait until each agent in --from has produced a matching event (default: first match wins)",
    )
    .action(async (name: string, raw: Record<string, unknown>) => {
      const opts = raw as {
        as: string;
        timeout?: string;
        from?: string;
        kind?: string;
        tag?: string;
        to?: string;
        includeProgress?: boolean;
        all?: boolean;
      };
      try {
        await channelWait(name, {
          as: opts.as,
          timeoutMs: parseDuration(opts.timeout),
          from: opts.from,
          kind: opts.kind,
          tag: opts.tag,
          to: opts.to,
          includeProgress: opts.includeProgress,
          all: opts.all,
        });
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("spawn <name>")
    .description(
      "Register a worker (claude/codex) into the channel — the worker stays idle until the first `channel send --to <worker>` arrives",
    )
    .option(
      "--agent <agent-name>",
      "load .trellis/agents/<name>.md (sets default --provider / --model / system prompt)",
    )
    .option(
      "--provider <provider>",
      "worker provider: claude | codex (overrides agent)",
    )
    .option(
      "--as <name>",
      "worker name in the channel (default: <agent-name> if --agent is set)",
    )
    .option("--cwd <path>", "worker working directory (default: process cwd)")
    .option("--model <id>", "model override")
    .option("--resume <id>", "resume an existing session/thread id")
    .option(
      "--timeout <duration>",
      "auto-kill worker after this duration (e.g. 30m, 1h, 7200s)",
    )
    .option(
      "--file <path>",
      "include a file's content as context in the worker's system prompt (glob supported, repeatable)",
      (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      "--jsonl <path>",
      "parse a Trellis jsonl manifest ({file, reason} per line) and include each referenced file (repeatable)",
      (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      "--by <agent>",
      "identity recorded as the spawn author (defaults to TRELLIS_CHANNEL_AS env or 'main')",
    )
    .action(async (name: string, raw: Record<string, unknown>) => {
      const opts = raw as {
        agent?: string;
        provider?: string;
        as?: string;
        cwd?: string;
        model?: string;
        resume?: string;
        timeout?: string;
        file?: string[];
        jsonl?: string[];
        by?: string;
      };
      if (opts.provider !== undefined && !isProvider(opts.provider)) {
        console.error(
          chalk.red("Error:"),
          `--provider must be one of: ${listProviders().join(", ")}`,
        );
        process.exit(1);
      }
      try {
        await channelSpawn(name, {
          agent: opts.agent,
          provider: opts.provider as Provider | undefined,
          as: opts.as,
          cwd: opts.cwd,
          model: opts.model,
          resume: opts.resume,
          timeoutMs: parseDuration(opts.timeout),
          files: opts.file,
          jsonls: opts.jsonl,
          by: opts.by,
        });
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("run [name]")
    .description(
      "One-shot: create ephemeral channel, spawn worker, send prompt, wait done, print final answer, cleanup",
    )
    .option(
      "--agent <agent-name>",
      "load .trellis/agents/<name>.md (sets default --provider / --as / system prompt)",
    )
    .option(
      "--provider <provider>",
      "worker provider: claude | codex (overrides agent)",
    )
    .option("--as <name>", "worker name (default: agent name if --agent set)")
    .option("--cwd <path>", "worker working directory")
    .option("--model <id>", "model override")
    .option(
      "--file <path>",
      "include a file as context (glob supported, repeatable)",
      (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      "--jsonl <path>",
      "parse a Trellis jsonl manifest and include each referenced file (repeatable)",
      (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
      [] as string[],
    )
    .option("--message <text>", "inline prompt text")
    .option("--message-file <path>", "read prompt body from file")
    .option("--stdin", "read prompt body from stdin")
    .option("--tag <tag>", "user tag (e.g. interrupt / phase_done / question)")
    .option(
      "--timeout <duration>",
      "max time to wait for done (e.g. 30s, 5m, 1h; default 5m)",
    )
    .action(async (name: string | undefined, raw: Record<string, unknown>) => {
      const opts = raw as {
        agent?: string;
        provider?: string;
        as?: string;
        cwd?: string;
        model?: string;
        file?: string[];
        jsonl?: string[];
        message?: string;
        messageFile?: string;
        stdin?: boolean;
        tag?: string;
        timeout?: string;
      };
      if (opts.provider !== undefined && !isProvider(opts.provider)) {
        console.error(
          chalk.red("Error:"),
          `--provider must be one of: ${listProviders().join(", ")}`,
        );
        process.exit(1);
      }
      try {
        await channelRun({
          name,
          agent: opts.agent,
          provider: opts.provider as Provider | undefined,
          as: opts.as,
          cwd: opts.cwd,
          model: opts.model,
          files: opts.file,
          jsonls: opts.jsonl,
          message: opts.message,
          textFile: opts.messageFile,
          stdin: opts.stdin,
          tag: opts.tag,
          timeoutMs: parseDuration(opts.timeout),
        });
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("rm <name>")
    .description("Kill workers and delete a channel directory entirely")
    .action(async (name: string) => {
      try {
        await channelRm(name);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("prune")
    .description(
      "Bulk-remove channels by criteria (defaults to dry-run preview)",
    )
    .option("--all", "remove all channels (except live ones and --keep)")
    .option("--empty", "remove channels with no activity (only create event)")
    .option(
      "--idle <duration>",
      "remove channels whose last event is older than this (e.g. 1h, 7d)",
    )
    .option(
      "--ephemeral",
      "remove only channels marked `--ephemeral` at create time",
    )
    .option("--yes", "actually delete (default is dry-run)")
    .option("--dry-run", "show what would be removed without deleting", true)
    .option(
      "--keep <names>",
      "comma-separated channel names to keep regardless",
    )
    .action(async (raw: Record<string, unknown>) => {
      const opts = raw as {
        all?: boolean;
        empty?: boolean;
        idle?: string;
        ephemeral?: boolean;
        yes?: boolean;
        dryRun?: boolean;
        keep?: string;
      };
      try {
        await channelPrune({
          all: opts.all,
          empty: opts.empty,
          idleMs: parseDuration(opts.idle),
          ephemeral: opts.ephemeral,
          yes: opts.yes,
          dryRun: !opts.yes,
          keep: opts.keep
            ? opts.keep
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
        });
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("list")
    .description(
      "List channels in ~/.trellis/channels/ with worker / activity summary",
    )
    .option("--json", "emit JSON instead of a formatted table")
    .option(
      "--project <slug>",
      "filter channels whose `task` field contains this substring",
    )
    .option(
      "--all",
      "include ephemeral channels (default: hide channels marked ephemeral)",
    )
    .option(
      "--all-projects",
      "scan every project bucket (default: only the current cwd's project)",
    )
    .action(async (raw: Record<string, unknown>) => {
      const opts = raw as {
        json?: boolean;
        project?: string;
        all?: boolean;
        allProjects?: boolean;
      };
      try {
        await channelList(opts);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("messages <name>")
    .description("View messages and events in the channel")
    .option("--raw", "print raw JSON (one event per line)")
    .option("--follow", "stream new events as they arrive (Ctrl-C to stop)")
    .option("--last <N>", "show only the last N matching events", (v) =>
      Number.parseInt(v, 10),
    )
    .option("--since <seq>", "only events with seq > N", (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      "--kind <kind>",
      "filter by event kind (e.g. message, done, killed)",
    )
    .option("--from <agents>", "filter by author (CSV)")
    .option("--to <target>", "filter by routing target")
    .option("--tag <tag>", "filter by user tag (e.g. interrupt, final_answer)")
    .option("--no-progress", "hide progress events (tool calls, deltas)")
    .action(async (name: string, raw: Record<string, unknown>) => {
      const opts = raw as {
        raw?: boolean;
        follow?: boolean;
        last?: number;
        since?: number;
        kind?: string;
        from?: string;
        to?: string;
        tag?: string;
        progress?: boolean; // commander negates --no-progress to progress:false
      };
      try {
        await channelMessages(name, {
          raw: opts.raw,
          follow: opts.follow,
          last: opts.last,
          since: opts.since,
          kind: opts.kind,
          from: opts.from,
          to: opts.to,
          tag: opts.tag,
          noProgress: opts.progress === false,
        });
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  channel
    .command("kill <name>")
    .description(
      "Stop a worker in the channel (SIGTERM, or SIGKILL with --force)",
    )
    .requiredOption("--as <agent>", "worker agent name")
    .option("--force", "skip graceful shutdown, send SIGKILL immediately")
    .action(async (name: string, raw: Record<string, unknown>) => {
      const opts = raw as { as: string; force?: boolean };
      try {
        await channelKill(name, opts);
      } catch (err) {
        console.error(
          chalk.red("Error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  // Hidden: supervisor entry point invoked by `channel spawn` via fork.
  channel
    .command("__supervisor <channel> <worker> <config>")
    .description(
      "[internal] supervisor process entry point — do not invoke directly",
    )
    .action(async (channelName: string, worker: string, configPath: string) => {
      try {
        await runSupervisor(channelName, worker, configPath);
      } catch (err) {
        console.error(
          chalk.red("Supervisor error:"),
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });

  // Dev-only: feed a recorded stream-json / wire trace through the matching
  // adapter and print the resulting channel events. Used during adapter
  // development to verify against real-CLI fixtures.
  channel
    .command("__parse-trace <adapter> <file>")
    .description(
      "[dev] Run a recorded trace through the parser and print events",
    )
    .action((adapter: string, file: string) => {
      if (!isProvider(adapter)) {
        console.error(
          chalk.red("Error:"),
          `unknown adapter '${adapter}' (registered: ${listProviders().join(", ")})`,
        );
        process.exit(1);
      }
      parseTrace(adapter, file);
    });
}
