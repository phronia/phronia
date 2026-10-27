/**
 * `phronia context` — the single context entrypoint.
 *
 * Shims pass a harness-neutral request on stdin and either consume the
 * versioned JSON plan or the rendered harness envelope (`--render`).
 */

import fs from "node:fs";
import path from "node:path";
import {
  ContextContractError,
  contextJsonSchema,
  handleContext,
  LAYOUT,
  renderContext,
  runtimeAdapter,
  writeHandshake,
  type ContextEvent,
  type ContextRequest,
} from "@phronia/core";
import { normalizePlatformId } from "@phronia/core/platform";

export interface ContextCommandOptions {
  event: ContextEvent;
  platform: string;
  projectRoot?: string;
  input: string;
  render?: boolean;
  schema?: boolean;
  json?: boolean;
}

const EVENTS: readonly ContextEvent[] = [
  "session-start",
  "user-prompt",
  "pre-tool-use",
  "pre-shell",
  "subagent-spawn",
  "session-end",
];

export function runContextCommand(options: ContextCommandOptions): number {
  if (options.schema) {
    process.stdout.write(`${JSON.stringify(contextJsonSchema(), null, 2)}\n`);
    return 0;
  }
  const platform = normalizePlatformId(options.platform);
  if (!platform) {
    process.stderr.write(`Unknown platform: ${options.platform}\n`);
    return 2;
  }
  if (!EVENTS.includes(options.event)) {
    process.stderr.write(`Unknown event: ${options.event}\n`);
    return 2;
  }

  const raw = readInput(options.input);
  let input: unknown;
  try {
    input = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `Invalid input JSON: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const request: ContextRequest = {
    schemaVersion: 1,
    event: options.event,
    platform: { id: platform },
    projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
    input,
  };

  try {
    const response = handleContext(request);
    // Shims never write the adapter manifest (concurrent runs); this file is
    // proof that the harness actually invoked us. It stores payload keys only.
    if (fs.existsSync(path.join(request.projectRoot, LAYOUT.rootDirName))) {
      writeHandshake(
        request.projectRoot,
        platform,
        request.event,
        runtimeAdapter(platform).id,
        input,
      );
    }
    if (options.render) {
      process.stdout.write(renderContext(response));
    } else {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ContextContractError) {
      process.stderr.write(`Context contract error: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(
      `Context error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 3;
  }
}

function readInput(input: string): string {
  if (input === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return fs.readFileSync(input, "utf8");
}
