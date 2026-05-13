import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChannel } from "../../src/commands/channel/create.js";
import { channelMessages } from "../../src/commands/channel/messages.js";
import { channelSend } from "../../src/commands/channel/send.js";
import { channelThreadPost } from "../../src/commands/channel/threads.js";
import { readChannelEvents } from "../../src/commands/channel/store/events.js";
import { matchesEventFilter } from "../../src/commands/channel/store/filter.js";
import {
  channelRoot,
  eventsPath,
  projectKey,
} from "../../src/commands/channel/store/paths.js";
import { parseCsv } from "../../src/commands/channel/store/schema.js";
import { reduceThreads } from "../../src/commands/channel/store/thread-state.js";

const noop = (): void => undefined;

describe("channel storage and thread channels", () => {
  let tmpDir: string;
  let projectDir: string;
  let oldRoot: string | undefined;
  let oldProject: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-channel-test-"));
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    oldRoot = process.env.TRELLIS_CHANNEL_ROOT;
    oldProject = process.env.TRELLIS_CHANNEL_PROJECT;
    process.env.TRELLIS_CHANNEL_ROOT = path.join(tmpDir, "channels");
    delete process.env.TRELLIS_CHANNEL_PROJECT;
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (oldRoot === undefined) delete process.env.TRELLIS_CHANNEL_ROOT;
    else process.env.TRELLIS_CHANNEL_ROOT = oldRoot;
    if (oldProject === undefined) delete process.env.TRELLIS_CHANNEL_PROJECT;
    else process.env.TRELLIS_CHANNEL_PROJECT = oldProject;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("honors TRELLIS_CHANNEL_ROOT when writing project channels", async () => {
    await createChannel("root-check", { by: "main" });

    expect(channelRoot()).toBe(path.join(tmpDir, "channels"));
    expect(
      fs.existsSync(eventsPath("root-check", projectKey(projectDir))),
    ).toBe(true);
  });

  it("reduces structured thread events into board state", async () => {
    const linkedFile = path.join(tmpDir, "context.md");
    fs.writeFileSync(linkedFile, "# Context\n");

    await createChannel("roadmap", {
      by: "main",
      scope: "global",
      type: "thread",
      description: "Local Trellis feedback board",
      linkedContextFile: [linkedFile],
      linkedContextRaw: ["watch channel UX"],
    });
    await channelThreadPost("roadmap", {
      as: "main",
      scope: "global",
      action: "opened",
      thread: "issue-1",
      title: "Channel thread mode",
      description: "Track thread-channel feedback.",
      labels: "channel,ux",
      assignees: "arch",
    });
    await channelThreadPost("roadmap", {
      as: "arch",
      scope: "global",
      action: "comment",
      thread: "issue-1",
      text: "Reviewed function shape.",
    });
    await channelThreadPost("roadmap", {
      as: "main",
      scope: "global",
      action: "status",
      thread: "issue-1",
      status: "closed",
    });
    await channelThreadPost("roadmap", {
      as: "main",
      scope: "global",
      action: "labels",
      thread: "issue-1",
      labels: "channel,reviewed",
    });
    await channelThreadPost("roadmap", {
      as: "main",
      scope: "global",
      action: "summary",
      thread: "issue-1",
      summary: "Thread channel behavior reviewed.",
    });
    await channelThreadPost("roadmap", {
      as: "main",
      scope: "global",
      action: "processed",
      thread: "issue-1",
    });

    const events = await readChannelEvents("roadmap", "_global");
    const state = reduceThreads(events);

    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      thread: "issue-1",
      title: "Channel thread mode",
      status: "processed",
      labels: ["channel", "reviewed"],
      assignees: ["arch"],
      summary: "Thread channel behavior reviewed.",
      lastSeq: events.at(-1)?.seq,
      comments: 1,
    });

    vi.mocked(console.log).mockClear();
    await channelMessages("roadmap", { scope: "global" });
    const boardOutput = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(boardOutput).toContain("Thread channel: showing threads");
    expect(boardOutput).toContain("issue-1 [processed] Channel thread mode");

    vi.mocked(console.log).mockClear();
    await channelMessages("roadmap", { scope: "global", kind: "create" });
    const createOutput = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(createOutput).toContain("description: Local Trellis feedback board");
    expect(createOutput).toContain(`context:file: ${linkedFile}`);
    expect(createOutput).toContain("context:raw: watch channel UX");

    vi.mocked(console.log).mockClear();
    await channelMessages("roadmap", { scope: "global", thread: "issue-1" });
    const threadOutput = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(threadOutput).toContain(
      "description: Track thread-channel feedback.",
    );
  });

  it("requires explicit scope when a channel exists in global and project scopes", async () => {
    await createChannel("dupe", { by: "main" });
    await createChannel("dupe", { by: "main", scope: "global" });

    await expect(
      channelSend("dupe", { as: "main", text: "ambiguous" }),
    ).rejects.toThrow("Use --scope global or --scope project");

    await channelSend("dupe", {
      as: "main",
      text: "global message",
      scope: "global",
    });

    const events = await readChannelEvents("dupe", "_global");
    expect(events.at(-1)).toMatchObject({
      kind: "message",
      text: "global message",
    });
  });
});

describe("channel shared helpers", () => {
  it("parses CSV values in one shared helper", () => {
    expect(parseCsv(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseCsv(undefined)).toBeUndefined();
    expect(parseCsv(" , ")).toBeUndefined();
  });

  it("uses one event filter for routing, progress, and thread predicates", () => {
    expect(
      matchesEventFilter(
        {
          seq: 1,
          ts: "2026-05-13T00:00:00.000Z",
          kind: "thread",
          by: "arch",
          action: "comment",
          thread: "topic-1",
        },
        {
          kind: "thread",
          from: ["arch"],
          action: "comment",
          thread: "topic-1",
        },
      ),
    ).toBe(true);

    expect(
      matchesEventFilter(
        {
          seq: 2,
          ts: "2026-05-13T00:00:00.000Z",
          kind: "progress",
          by: "arch",
        },
        {},
      ),
    ).toBe(false);

    expect(
      matchesEventFilter(
        {
          seq: 3,
          ts: "2026-05-13T00:00:00.000Z",
          kind: "message",
          by: "main",
          to: ["check"],
        },
        { to: "arch" },
      ),
    ).toBe(false);
  });
});
