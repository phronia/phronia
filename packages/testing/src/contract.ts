/**
 * Contract fixture replay.
 *
 * A fixture records a harness payload and a minimal project. Replaying it
 * through `phronia context` checks three things the unit tests cannot:
 * the shim's request shape, the response envelope keys, and whether the
 * harness payload drifted (new or missing keys) since the fixture was
 * recorded.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeProject, readFixture, type FixtureContents } from "./fixtures.js";

export interface ShapeDiff {
  missing: string[];
  extra: string[];
}

export interface ContractReplayResult {
  fixture: FixtureContents;
  status: number | null;
  response: unknown;
  payloadShape: ShapeDiff;
  responseShape: ShapeDiff;
  stderr: string;
}

const RESPONSE_KEYS = [
  "blocks",
  "coreVersion",
  "degraded",
  "diagnostics",
  "effects",
  "envelope",
  "event",
  "mutations",
  "platform",
  "projectRoot",
  "schemaVersion",
  "session",
];

/** Sorted dotted key paths; arrays are represented by their first element. */
export function shapeOf(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [`${prefix}[]`] : [];
    return shapeOf(value[0], `${prefix}[]`);
  }
  if (!value || typeof value !== "object") {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    const childShape = shapeOf(child, childPrefix);
    keys.push(...(childShape.length > 0 ? childShape : [childPrefix]));
  }
  return [...new Set(keys)].sort();
}

export function diffShape(expected: readonly string[], actual: readonly string[]): ShapeDiff {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: [...expectedSet].filter((key) => !actualSet.has(key)).sort(),
    extra: [...actualSet].filter((key) => !expectedSet.has(key)).sort(),
  };
}

export async function replayFixture(
  fixtureDir: string,
  options: { cliPath: string; keepProject?: boolean },
): Promise<ContractReplayResult> {
  const fixture = await readFixture(fixtureDir);
  const temp = await mkdtemp(path.join(os.tmpdir(), "phronia-contract-"));
  try {
    const { root } = await materializeProject(fixtureDir, temp);
    const request = (fixture.request ?? {
      schemaVersion: 1,
      event: fixture.meta.event,
      platform: { id: fixture.meta.platform },
      projectRoot: root,
      input: fixture.input,
    }) as Record<string, unknown>;
    const projectRoot = String(request.projectRoot ?? root).replace(
      "<PROJECT_ROOT>",
      root,
    );
    const adapterId = (request.platform as { adapterId?: string } | undefined)
      ?.adapterId;
    const result = spawnSync(
      process.execPath,
      [
        options.cliPath,
        "context",
        "--event",
        String(request.event ?? fixture.meta.event),
        "--platform",
        String(
          (request.platform as { id?: string } | undefined)?.id ??
            fixture.meta.platform,
        ),
        ...(adapterId ? ["--adapter", adapterId] : []),
        "--project-root",
        projectRoot,
        "--input",
        "-",
        "--json",
      ],
      {
        input: JSON.stringify(request.input ?? fixture.input),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: path.join(temp, "home") },
      },
    );

    let response: unknown = null;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      response = null;
    }

    const payloadKeys = fixture.meta.payloadKeys ?? shapeOf(fixture.input);
    return {
      fixture,
      status: result.status,
      response,
      payloadShape: diffShape(payloadKeys, shapeOf(fixture.input)),
      // The envelope contract is top-level: nested block/diagnostic shapes are
      // covered by the core contract tests, not by every fixture.
      responseShape: diffShape(
        RESPONSE_KEYS,
        response && typeof response === "object"
          ? Object.keys(response as Record<string, unknown>)
          : [],
      ),
      stderr: result.stderr ?? "",
    };
  } finally {
    if (!options.keepProject) {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

export async function readExpectedShape(fixtureDir: string): Promise<string[]> {
  return JSON.parse(
    await readFile(path.join(fixtureDir, "expected-shape.json"), "utf8"),
  ) as string[];
}
