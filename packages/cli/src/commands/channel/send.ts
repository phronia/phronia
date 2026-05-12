import fs from "node:fs";

import { appendEvent } from "./store/events.js";
import { selectExistingChannelProject } from "./store/paths.js";

export interface SendOptions {
  as: string;
  text?: string;
  stdin?: boolean;
  textFile?: string;
  kind?: string; // tag
  to?: string; // CSV
}

async function readText(opts: SendOptions): Promise<string> {
  if (opts.text !== undefined && opts.text !== "") return opts.text;
  if (opts.textFile) return fs.readFileSync(opts.textFile, "utf-8");
  if (opts.stdin) {
    return await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.on(
        "data",
        (chunk: Buffer) => (buf += chunk.toString("utf-8")),
      );
      process.stdin.on("end", () => resolve(buf));
    });
  }
  throw new Error("No text provided (use <text> arg, --stdin, or --text-file)");
}

export async function channelSend(
  channelName: string,
  opts: SendOptions,
): Promise<void> {
  selectExistingChannelProject(channelName);
  const text = (await readText(opts)).trimEnd();
  if (!text) throw new Error("Empty message");

  const to = opts.to
    ? opts.to
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const event = await appendEvent(channelName, {
    kind: "message",
    by: opts.as,
    text,
    ...(opts.kind ? { tag: opts.kind } : {}),
    ...(to ? { to: to.length === 1 ? to[0] : to } : {}),
  });
  console.log(JSON.stringify(event));
}
