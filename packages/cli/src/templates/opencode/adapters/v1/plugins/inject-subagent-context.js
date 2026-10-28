/* global process */
// phronia-shim: opencode@v1
// shim-version: 0.6.17
// DO NOT EDIT. Regenerate with: phronia update --regenerate-shims
/**
 * Phronia sub-agent context plugin for OpenCode.
 *
 * `tool.execute.before` is the only OpenCode surface that can rewrite a Task
 * prompt in place and inject a shell identity. The assembly (active task,
 * JSONL materialization, role prompt) lives in `phronia context`; this file
 * only extracts the host payload, forwards an explicit `Active task:` hint,
 * and applies the returned mutation.
 */

import { createHash } from "node:crypto"
import { debugLog } from "../lib/debug.js"
import { runContext } from "../lib/phronia-client.js"

const AGENTS_ALL = ["implement", "check", "research"]
const ACTIVE_TASK_HINT_RE = /^\s*Active task:\s*(\S+)\s*$/m

function sanitizeKey(raw) {
  const safe = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
  return safe ? safe.slice(0, 160) : ""
}

function hashValue(raw) {
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 24)
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function lookupString(input, keys) {
  if (!input || typeof input !== "object") return null
  for (const key of keys) {
    const value = stringValue(input[key])
    if (value) return value
  }
  return null
}

function contextKey(input) {
  const override = stringValue(process.env.PHRONIA_CONTEXT_ID)
  if (override) return sanitizeKey(override) || hashValue(override)
  const sessionId = lookupString(input, ["session_id", "sessionId", "sessionID"])
  if (sessionId) {
    const safe = sanitizeKey(sessionId)
    return safe ? `opencode_${safe}` : `opencode_${hashValue(sessionId)}`
  }
  const transcript = lookupString(input, ["transcript_path", "transcriptPath", "transcript"])
  return transcript ? `opencode_transcript_${hashValue(transcript)}` : null
}

function activeTaskHint(prompt) {
  if (typeof prompt !== "string" || !prompt) return null
  const match = prompt.match(ACTIVE_TASK_HINT_RE)
  return match ? match[1].trim() : null
}

// OpenCode exposes no session identity to Bash. The plugin receives it, so a
// command prefix is the only channel by which task.py sees this session.
function envValue(env, key) {
  const value = env?.[key]
  return typeof value === "string" && value ? value : null
}

function shellBasename(value) {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || ""
}

function isWindowsPosixShell(env = process.env) {
  if (envValue(env, "MSYSTEM")) return true
  if (envValue(env, "MINGW_PREFIX")) return true
  if (envValue(env, "OPENCODE_GIT_BASH_PATH")) return true
  const ostype = envValue(env, "OSTYPE")?.toLowerCase() || ""
  if (/(msys|mingw|cygwin)/.test(ostype)) return true
  return /^(bash|sh|zsh)(\.exe)?$/.test(shellBasename(envValue(env, "SHELL") || ""))
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function contextPrefix(key, hostPlatform = process.platform, env = process.env) {
  if (hostPlatform === "win32" && !isWindowsPosixShell(env)) {
    return `$env:PHRONIA_CONTEXT_ID = ${powershellQuote(key)}; `
  }
  return `export PHRONIA_CONTEXT_ID=${shellQuote(key)}; `
}

function commandKey(args) {
  if (!args || typeof args !== "object") return null
  if (typeof args.command === "string") return "command"
  if (typeof args.cmd === "string") return "cmd"
  return null
}

function commandHasContext(command) {
  const first = command.trimStart().split(/[;&|]/, 1)[0].trimStart()
  return (
    /^PHRONIA_CONTEXT_ID\s*=/.test(first) ||
    /^export\s+PHRONIA_CONTEXT_ID\s*=/.test(first) ||
    /^env\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*PHRONIA_CONTEXT_ID\s*=/.test(first) ||
    /^\$env:PHRONIA_CONTEXT_ID\s*=/i.test(first)
  )
}

function injectBashContext(input, output, hostPlatform, env) {
  const args = output?.args
  const key = commandKey(args)
  if (!key) return false
  const command = args[key]
  if (!command?.trim() || commandHasContext(command)) return false
  const sessionKey = contextKey(input)
  if (!sessionKey) return false
  args[key] = `${contextPrefix(sessionKey, hostPlatform, env)}${command}`
  return true
}

function normalizeAgentType(value) {
  const name = String(value || "").replace(/^phronia-/, "").toLowerCase()
  return AGENTS_ALL.includes(name) ? name : null
}

function denyError(mutation) {
  const next = Array.isArray(mutation.next) ? mutation.next.join("\n") : ""
  const error = new Error(`[${mutation.code}] ${mutation.reason}\n${next}`)
  error.name = "PhroniaDispatchDenied"
  return error
}

// OpenCode plugin factory: `export default async (input) => hooks`.
// OpenCode 1.2.x iterates every module export and invokes it as a function;
// the old `{ id, server }` object shape failed with `fn is not a function`.
export default async ({ directory, platform: hostPlatform = process.platform, env = process.env }) => {
  debugLog("inject", "Plugin loaded, directory:", directory)

  const hook = async (input, output) => {
    try {
      if (process.env.PHRONIA_HOOKS === "0" || process.env.PHRONIA_DISABLE_HOOKS === "1") {
        return
      }
      const toolName = input?.tool?.toLowerCase()
      if (toolName === "bash") {
        if (injectBashContext(input, output, hostPlatform, env)) {
          debugLog("inject", "Injected PHRONIA_CONTEXT_ID into Bash command")
        }
        return
      }
      if (toolName !== "task") return

      const args = output?.args
      if (!args) return
      const agentType = normalizeAgentType(args.subagent_type)
      if (!agentType) {
        debugLog("inject", "Skipping - unsupported subagent_type")
        return
      }

      const originalPrompt = typeof args.prompt === "string" ? args.prompt : ""
      const sessionId = lookupString(input, ["session_id", "sessionId", "sessionID"])
      const hint = activeTaskHint(originalPrompt)

      const response = runContext({
        event: "subagent-spawn",
        platform: "opencode",
        projectRoot: directory,
        input: {
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(hint ? { task_ref: hint } : {}),
          subagent_type: agentType,
          prompt: originalPrompt,
        },
      })

      const mutation = Array.isArray(response?.mutations) ? response.mutations[0] : null
      // A deny must abort the tool call: the outer catch only reports and
      // swallows transport errors, so use a named error and rethrow it below.
      if (mutation?.op === "deny") throw denyError(mutation)
      if (!mutation || typeof mutation.value !== "string" || !mutation.value) {
        debugLog("inject", "No context to inject")
        return
      }

      // Mutate args in place: the runtime holds a local reference to it.
      args.prompt = mutation.value
      debugLog("inject", "Injected context for", agentType, "length:", mutation.value.length)
    } catch (error) {
      if (error?.name === "PhroniaDispatchDenied") throw error
      debugLog("inject", "Error in tool.execute.before:", error.message, error.stack)
    }
  }

  return { "tool.execute.before": hook }
}
