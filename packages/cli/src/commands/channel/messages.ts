import fs from "node:fs";

import chalk from "chalk";

import { parseChannelKind, type ChannelEvent } from "./store/events.js";
import { eventsPath, selectExistingChannelProject } from "./store/paths.js";
import { watchEvents } from "./store/watch.js";

export interface MessagesOptions {
  raw?: boolean;
  follow?: boolean;
  last?: number;
  since?: number;
  kind?: string;
  from?: string;
  to?: string;
  noProgress?: boolean;
  tag?: string;
}

export async function channelMessages(
  channelName: string,
  opts: MessagesOptions,
): Promise<void> {
  selectExistingChannelProject(channelName);
  const file = eventsPath(channelName);
  if (!fs.existsSync(file)) {
    throw new Error(`Channel '${channelName}' not found at ${file}`);
  }

  const text = await fs.promises.readFile(file, "utf-8");
  const all: ChannelEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as ChannelEvent);
    } catch {
      continue;
    }
  }

  const fromList = opts.from
    ? opts.from
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  // Validate --kind against whitelist up front so typos fail fast.
  const kindFilter = parseChannelKind(opts.kind);

  const filtered = all.filter((ev) => {
    if (opts.since !== undefined && ev.seq <= opts.since) return false;
    if (kindFilter && ev.kind !== kindFilter) return false;
    if (opts.noProgress && ev.kind === "progress") return false;
    if (fromList && !fromList.includes(ev.by)) return false;
    if (opts.to) {
      // Match watchEvents semantics: events with no `to` (broadcasts)
      // pass through; only an explicit mismatch rejects.
      const evTo = (ev as { to?: string | string[] }).to;
      if (Array.isArray(evTo)) {
        if (!evTo.includes(opts.to)) return false;
      } else if (typeof evTo === "string") {
        if (evTo !== opts.to) return false;
      }
    }
    if (opts.tag !== undefined) {
      const evTag = (ev as { tag?: string }).tag;
      if (evTag !== opts.tag) return false;
    }
    return true;
  });

  const view = opts.last ? filtered.slice(-opts.last) : filtered;
  for (const ev of view) printEvent(ev, opts.raw ?? false);

  if (opts.follow) {
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    for await (const ev of watchEvents(
      channelName,
      {
        kind: kindFilter,
        from: fromList,
        to: opts.to,
        tag: opts.tag,
        includeProgress: !opts.noProgress,
      },
      { signal: abort.signal },
    )) {
      printEvent(ev, opts.raw ?? false);
    }
  }
}

function printEvent(ev: ChannelEvent, raw: boolean): void {
  if (raw) {
    console.log(JSON.stringify(ev));
    return;
  }
  const ts = (ev.ts || "").slice(11, 19);
  const by = colorBy(ev.by);
  switch (ev.kind) {
    case "create": {
      const cwd = (ev as { cwd?: string }).cwd ?? "";
      const task = (ev as { task?: string }).task ?? "";
      printLine(
        `${kindTag("create")} by=${by}  cwd=${cwd}${task ? "  task=" + task : ""}`,
        ts,
      );
      break;
    }
    case "spawned": {
      const as = (ev as { as?: string }).as ?? "?";
      const provider = (ev as { provider?: string }).provider ?? "?";
      const pid = (ev as { pid?: number }).pid ?? "?";
      const agent = (ev as { agent?: string }).agent;
      const files = (ev as { files?: string[] }).files;
      const manifests = (ev as { manifests?: string[] }).manifests;
      const agentStr = agent ? `  agent=${chalk.magenta(agent)}` : "";
      printLine(
        `${kindTag("spawned")} by=${by}  worker=${colorTo(as)} provider=${provider}${agentStr} pid=${pid}`,
        ts,
      );
      if (files && files.length > 0) {
        console.log(`         ${chalk.dim("files:")} ${files.join(", ")}`);
      }
      if (manifests && manifests.length > 0) {
        console.log(
          `         ${chalk.dim("manifests:")} ${manifests.join(", ")}`,
        );
      }
      break;
    }
    case "killed": {
      const reason = (ev as { reason?: string }).reason ?? "?";
      const sig = (ev as { signal?: string }).signal ?? "?";
      printLine(
        `${kindTag("killed")} by=${by}  reason=${reason} signal=${sig}`,
        ts,
      );
      break;
    }
    case "message": {
      const text = ((ev as { text?: string }).text ?? "").replace(
        /\n/g,
        "\n         ",
      );
      const tag = (ev as { tag?: string }).tag;
      const to = (ev as { to?: string | string[] }).to;
      const toStr = to
        ? `  to=${colorTo(Array.isArray(to) ? to.join(",") : to)}`
        : "";
      const tagStr = tag ? `  ${chalk.yellow(`<${tag}>`)}` : "";
      printLine(`${kindTag("message")} by=${by}${toStr}${tagStr}`, ts);
      console.log(`         ${text}`);
      break;
    }
    case "done": {
      const dur = (ev as { duration_ms?: number }).duration_ms;
      printLine(
        `${kindTag("done")} by=${by}${dur !== undefined ? "  duration=" + dur + "ms" : ""}`,
        ts,
      );
      break;
    }
    case "error": {
      const msg = (ev as { message?: string }).message ?? "";
      printLine(`${kindTag("error")} by=${by}  ${msg}`, ts);
      break;
    }
    case "progress": {
      const detail = ((ev as { detail?: Record<string, unknown> }).detail ??
        {}) as Record<string, unknown>;
      const summary = summarizeProgress(detail);
      printLine(`${kindTag("progress")} by=${by}  ${summary}`, ts);
      break;
    }
    default: {
      printLine(`${kindTag(ev.kind)} by=${by}`, ts);
    }
  }
}

/**
 * Print `body` right-padded with `ts` at the terminal's right edge. The ANSI
 * escape codes don't count toward visible width, so we strip them before
 * computing the pad amount.
 */
function printLine(body: string, ts: string): void {
  const width = process.stdout.columns || 100;
  // eslint-disable-next-line no-control-regex
  const visible = body.replace(/\x1b\[[0-9;]*m/g, "").length;
  const tsCols = ts.length; // "HH:MM:SS" = 8
  const gap = Math.max(2, width - visible - tsCols);
  console.log(body + " ".repeat(gap) + chalk.dim(ts));
}

function colorBy(name: string): string {
  if (name === "main") return chalk.magenta(name);
  if (name.startsWith("supervisor:") || name.startsWith("cli:")) {
    return chalk.gray(name);
  }
  return chalk.cyan(name);
}

function colorTo(name: string): string {
  return chalk.greenBright(name);
}

function kindTag(k: string): string {
  const padded = `[${k}]`.padEnd(10);
  switch (k) {
    case "done":
      return chalk.green(padded);
    case "error":
    case "killed":
      return chalk.red(padded);
    case "spawned":
      return chalk.cyan(padded);
    case "respawned":
      return chalk.cyan(padded);
    case "message":
      return chalk.yellow(padded);
    case "progress":
      return chalk.gray(padded);
    case "create":
      return chalk.blueBright(padded);
    default:
      return padded;
  }
}

function summarizeProgress(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["kind", "tool", "tool_name", "server", "status", "cmd"]) {
    if (detail[key] !== undefined) {
      const v = String(detail[key]);
      parts.push(`${key}=${v.length > 60 ? v.slice(0, 60) + "…" : v}`);
    }
  }
  if (detail.text_delta) {
    const t = String(detail.text_delta);
    parts.push(`delta="${t.length > 40 ? t.slice(0, 40) + "…" : t}"`);
  }
  return parts.join(" ");
}
