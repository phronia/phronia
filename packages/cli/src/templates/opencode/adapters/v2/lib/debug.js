/* global process */
// phronia-shim: opencode@v2
// DO NOT EDIT. Regenerate with: pnpm build:shims
/**
 * Debug log for the generated shim. Writes only when PHRONIA_DEBUG or DEBUG
 * is set, and never blocks the host on a logging failure.
 */

import { appendFileSync } from "node:fs"
import { platform } from "node:os"
import { join } from "node:path"

const DEBUG_LOG = join(
  process.env.TMPDIR || (platform() === "win32" ? "." : "/tmp"),
  "phronia-plugin-debug.log",
)

export function debugLog(prefix, ...args) {
  if (!process.env.PHRONIA_DEBUG && !process.env.DEBUG) return
  const timestamp = new Date().toISOString()
  const msg = `[${timestamp}] [${prefix}] ${args
    .map(value => (typeof value === "object" ? JSON.stringify(value) : value))
    .join(" ")}`
  try {
    appendFileSync(DEBUG_LOG, `${msg}\n`)
  } catch {
    // debug output must never break a hook
  }
}
