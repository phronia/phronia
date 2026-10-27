/**
 * Minimal filesystem seam for the state layer.
 *
 * Tests inject an in-memory implementation; production uses this wrapper so
 * every read is synchronous, tolerant, and never accidentally writes.
 */

import fs from "node:fs";

export interface FsLike {
  existsSync(target: string): boolean;
  readFileSync(target: string, encoding: "utf8"): string;
  readdirSync(target: string): string[];
  statSync(target: string): { isDirectory(): boolean; isFile(): boolean };
  realpathSync(target: string): string;
}

export const nodeFs: FsLike = {
  existsSync: (target) => fs.existsSync(target),
  readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
  readdirSync: (target) => fs.readdirSync(target),
  statSync: (target) => fs.statSync(target),
  realpathSync: (target) => fs.realpathSync(target),
};

/** Read UTF-8 text, returning null on any failure. */
export function readText(io: FsLike, target: string): string | null {
  try {
    return io.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** Read and parse JSON, returning null on any failure. */
export function readJson<T>(io: FsLike, target: string): T | null {
  const text = readText(io, target);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** List entries, returning [] on any failure. */
export function listDir(io: FsLike, target: string): string[] {
  try {
    return io.readdirSync(target).sort();
  } catch {
    return [];
  }
}

/** True when the path exists and is a directory. */
export function isDirectory(io: FsLike, target: string): boolean {
  try {
    return io.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve symlinks and `..`, returning null on failure. */
export function realPath(io: FsLike, target: string): string | null {
  try {
    return io.realpathSync(target);
  } catch {
    return null;
  }
}
