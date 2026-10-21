/**
 * `phronia task cross-repo` — minimal cross-repository task links.
 */

import fs from "node:fs";
import path from "node:path";
import {
  attachCrossRepo,
  crossRepoStatus,
  type CrossRepoConsume,
  type CrossRepoTouch,
} from "@phronia/core";

export interface CrossRepoOptions {
  cwd: string;
  json?: boolean;
}

export function runCrossRepoAttach(
  taskRef: string,
  specs: readonly string[],
  options: CrossRepoOptions & { consumes?: readonly string[] },
): number {
  if (specs.length === 0) {
    process.stderr.write("usage: task cross-repo attach <task> <repo=path|remote>...\n");
    return 2;
  }
  const touches: CrossRepoTouch[] = [];
  for (const spec of specs) {
    const index = spec.indexOf("=");
    if (index <= 0) {
      process.stderr.write(`invalid touch (expected repo=path|remote): ${spec}\n`);
      return 2;
    }
    const repo = spec.slice(0, index);
    const target = spec.slice(index + 1);
    const isRemote = /^(git@|https?:\/\/|ssh:\/\/)/.test(target);
    const localPath = isRemote ? undefined : path.resolve(options.cwd, target);
    touches.push({
      repo,
      ...(isRemote ? { remote: target } : { localHint: localPath }),
      state:
        localPath && fs.existsSync(path.join(localPath, ".phronia"))
          ? "active"
          : "external",
      status: "in_progress",
    });
  }
  const consumes: CrossRepoConsume[] = (options.consumes ?? []).map((entry) => {
    const at = entry.lastIndexOf("@");
    const [repo, ...rest] = (at >= 0 ? entry.slice(0, at) : entry).split(":");
    return {
      repo: repo ?? "",
      path: rest.join(":"),
      ref: at >= 0 ? entry.slice(at + 1) : "HEAD",
    };
  });
  try {
    const meta = attachCrossRepo(options.cwd, taskRef, touches, consumes);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
    } else {
      process.stdout.write(
        `attached ${touches.length} repo(s) to ${meta.taskId} (${meta.touches.map((t) => `${t.repo}:${t.state}`).join(", ")})\n`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function runCrossRepoStatus(taskRef: string, options: CrossRepoOptions): number {
  try {
    const report = crossRepoStatus(options.cwd, taskRef);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`task ${report.taskId} — all merged: ${report.allMerged}\n`);
      for (const repo of report.repos) {
        process.stdout.write(
          `  ${repo.repo.padEnd(20)} ${repo.state.padEnd(14)} ${repo.status ?? "-"}` +
            (repo.progress ? `  ${repo.progress}` : "") +
            (repo.reason ? `  (${repo.reason})` : "") +
            "\n",
        );
      }
      for (const consume of report.consumes) {
        process.stdout.write(
          `  consume ${consume.repo}:${consume.path}@${consume.ref} ${consume.drift ? "DRIFT" : "ok"}\n`,
        );
      }
    }
    return report.repos.some((repo) => repo.state === "unresolvable") ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
