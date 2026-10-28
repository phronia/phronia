/* global process, setTimeout, clearTimeout */
// phronia-shim: opencode@v2
// DO NOT EDIT. Regenerate with: pnpm build:shims
/**
 * Bridge to the Phronia core CLI.
 *
 * The v2 hooks are async, so this uses `spawn` instead of `spawnSync`: a
 * blocked event loop would stall every other session served by the same
 * OpenCode process. Input and output are the versioned `phronia context`
 * contract; this file owns no context logic.
 *
 * `--adapter` was added with the v2 shard. A project can briefly run a newer
 * shim against an older globally installed CLI, so the call falls back to the
 * legacy argv shape instead of failing the hook.
 */

import { spawn } from "node:child_process"

export function resolveCli() {
  const explicit = process.env.PHRONIA_CLI_PATH
  if (explicit) {
    return explicit.endsWith(".py")
      ? { command: process.env.PYTHON || "python3", args: [explicit] }
      : { command: process.execPath, args: [explicit] }
  }
  return { command: process.platform === "win32" ? "phronia.cmd" : "phronia", args: [] }
}

function contextArgs(cli, { event, projectRoot, adapter }) {
  return [
    ...cli.args,
    "context",
    "--event",
    event,
    "--platform",
    "opencode",
    ...(adapter ? ["--adapter", adapter] : []),
    "--project-root",
    projectRoot,
    "--input",
    "-",
    "--json",
  ]
}

function spawnContext(cli, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
      // `.cmd` shims need cmd.exe on Windows; POSIX runs argv directly.
      shell: process.platform === "win32",
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`phronia context timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on("data", chunk => {
      stdout += chunk
    })
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.on("error", error => finish(error))
    child.on("close", code => {
      if (code !== 0) {
        finish(new Error(stderr.trim() || `phronia context exited ${code}`))
        return
      }
      try {
        finish(null, JSON.parse(stdout))
      } catch (error) {
        finish(new Error(`phronia context returned invalid JSON: ${error.message}`))
      }
    })
    child.stdin.on("error", () => {
      // The process may exit before reading stdin; the close handler reports it.
    })
    child.stdin.end(JSON.stringify(input ?? {}))
  })
}

function adapterUnsupported(error) {
  return /unknown option.*--adapter|--adapter.*unknown|unknown argument.*--adapter/i.test(
    error?.message ?? "",
  )
}

/**
 * Run `phronia context` and resolve the parsed JSON plan.
 * Rejects on non-zero exit, timeout, or malformed JSON; callers degrade.
 */
export async function runContext({
  event,
  projectRoot,
  input,
  adapter = "opencode@v2",
  timeoutMs = 8000,
}) {
  const cli = resolveCli()
  try {
    return await spawnContext(
      cli,
      contextArgs(cli, { event, projectRoot, adapter }),
      input,
      timeoutMs,
    )
  } catch (error) {
    if (!adapter || !adapterUnsupported(error)) throw error
    return spawnContext(
      cli,
      contextArgs(cli, { event, projectRoot, adapter: null }),
      input,
      timeoutMs,
    )
  }
}

export function blocksText(response) {
  if (!response || !Array.isArray(response.blocks)) return ""
  return response.blocks.map(block => block.text).join("\n\n")
}
