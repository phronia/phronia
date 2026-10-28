/* global process */
// phronia-shim: opencode@v2
// DO NOT EDIT. Regenerate with: pnpm build:shims
/**
 * Phronia plugin for OpenCode v2.
 *
 * The host calls this file through its local plugin loader. The default export
 * is the v2 plugin shape `{ id, setup }`; `Plugin.define` is an identity
 * function, so this file has no runtime dependency on `@opencode/plugin`.
 *
 * Responsibilities are transport only:
 * - translate `session.hook("context")` / `tool.hook("execute.before")` into
 *   the harness-neutral `phronia context` request;
 * - cache per session/prompt so one user turn does not spawn the CLI once per
 *   model request;
 * - apply the returned blocks to the outgoing request only.
 */

import { createHash } from "node:crypto"
import { debugLog } from "./lib/debug.js"
import { blocksText, runContext } from "./lib/phronia-client.js"

const ADAPTER_ID = "opencode@v2"
const PHRONIA_SUBAGENT_RE = /^(?:phronia|trellis)-(?:implement|check|research)$/i
const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g
const ACTIVE_TASK_HINT_RE = /^\s*Active task:\s*(\S+)\s*$/m
const MAX_CACHE_ENTRIES = 32

function disabled() {
  return (
    process.env.PHRONIA_HOOKS === "0" ||
    process.env.PHRONIA_DISABLE_HOOKS === "1" ||
    process.env.OPENCODE_NON_INTERACTIVE === "1"
  )
}

function createCache() {
  return {
    sessionStart: new Map(),
    prompt: new Map(),
    inflight: new Map(),
  }
}

function remember(map, key, value) {
  map.set(key, value)
  if (map.size > MAX_CACHE_ENTRIES) {
    map.delete(map.keys().next().value)
  }
}

function singleFlight(cache, key, factory) {
  const existing = cache.inflight.get(key)
  if (existing) return existing
  const pending = Promise.resolve()
    .then(factory)
    .finally(() => cache.inflight.delete(key))
  cache.inflight.set(key, pending)
  return pending
}

function isSubagent(agent) {
  return typeof agent === "string" && PHRONIA_SUBAGENT_RE.test(agent.trim())
}

function normalizeAgent(agent) {
  if (typeof agent !== "string") return null
  const match = PHRONIA_SUBAGENT_RE.exec(agent.trim())
  return match ? match[0].replace(/^(?:phronia|trellis)-/i, "").toLowerCase() : null
}

function messageText(message) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n\n")
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]
  }
  return null
}

function lastUserText(messages) {
  return messageText(lastUserMessage(messages))
}

function hasAssistantMessage(messages) {
  return Array.isArray(messages) && messages.some(message => message?.role === "assistant")
}

function compactionGeneration(messages) {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === "compaction") count += 1
    }
  }
  return count
}

function hashText(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 24)
}

function stripFirstReplyNotice(text) {
  return text.replace(FIRST_REPLY_NOTICE_RE, "")
}

function activeTaskHint(prompt) {
  if (typeof prompt !== "string" || !prompt) return null
  const match = prompt.match(ACTIVE_TASK_HINT_RE)
  return match ? match[1].trim() : null
}

async function onContext(ctx, event, cache) {
  if (disabled() || !event || isSubagent(event.agent)) return
  const sessionID = event.sessionID
  if (typeof sessionID !== "string" || !sessionID) return

  const messages = Array.isArray(event.messages) ? event.messages : []
  const prompt = lastUserText(messages)
  const generation = compactionGeneration(messages)
  const sessionKey = `${sessionID}#${generation}`

  let sessionContext = cache.sessionStart.get(sessionKey)
  if (sessionContext === undefined) {
    try {
      const response = await singleFlight(cache, `s:${sessionKey}`, () =>
        runContext({
          event: "session-start",
          projectRoot: ctx.location.directory,
          adapter: ADAPTER_ID,
          input: { session_id: sessionID, prompt },
        }),
      )
      sessionContext = blocksText(response)
      if (hasAssistantMessage(messages)) {
        sessionContext = stripFirstReplyNotice(sessionContext)
      }
      remember(cache.sessionStart, sessionKey, sessionContext)
    } catch (error) {
      debugLog("v2-context", "session-start failed:", error.message)
    }
  }
  if (sessionContext && Array.isArray(event.system)) {
    event.system.push({ type: "text", text: sessionContext })
  }

  if (!prompt) return
  const user = lastUserMessage(messages)
  const promptKey = `${sessionID}#${user?.id ?? hashText(prompt)}`
  let breadcrumb = cache.prompt.get(promptKey)
  if (breadcrumb === undefined) {
    try {
      const response = await singleFlight(cache, `p:${promptKey}`, () =>
        runContext({
          event: "user-prompt",
          projectRoot: ctx.location.directory,
          adapter: ADAPTER_ID,
          input: { session_id: sessionID, prompt },
        }),
      )
      breadcrumb = blocksText(response)
      remember(cache.prompt, promptKey, breadcrumb)
    } catch (error) {
      debugLog("v2-context", "user-prompt failed:", error.message)
    }
  }
  if (breadcrumb && Array.isArray(event.messages)) {
    event.messages.push({
      role: "system",
      content: [{ type: "text", text: breadcrumb }],
    })
  }
}

async function onToolBefore(ctx, event) {
  if (disabled()) return
  if (!event || event.tool !== "subagent") return
  const input = event.input
  if (!input || typeof input !== "object") return

  const agentType = normalizeAgent(input.agent)
  if (!agentType) return

  const originalPrompt = typeof input.prompt === "string" ? input.prompt : ""
  try {
    const response = await runContext({
      event: "subagent-spawn",
      projectRoot: ctx.location.directory,
      adapter: ADAPTER_ID,
      input: {
        session_id: event.sessionID,
        agent_type: agentType,
        prompt: originalPrompt,
        ...(activeTaskHint(originalPrompt) ? { task_ref: activeTaskHint(originalPrompt) } : {}),
      },
    })
    const mutation = Array.isArray(response?.mutations) ? response.mutations[0] : null
    if (mutation?.op === "set-prompt" && typeof mutation.value === "string" && mutation.value) {
      // In-place mutation: the v2 tool executes the same input object.
      input.prompt = mutation.value
    }
  } catch (error) {
    debugLog("v2-tool", "subagent context failed:", error.message)
  }
}

export default {
  id: "phronia.opencode.v2",
  async setup(ctx) {
    if (disabled()) return
    const cache = createCache()
    const registrations = []

    const register = async (label, factory) => {
      try {
        const registration = await factory()
        if (registration) registrations.push(registration)
      } catch (error) {
        debugLog("v2-setup", `${label} registration failed:`, error.message)
      }
    }

    if (ctx?.session?.hook) {
      await register("session.context", () =>
        ctx.session.hook("context", event => onContext(ctx, event, cache)),
      )
    }
    if (ctx?.tool?.hook) {
      await register("tool.execute.before", () =>
        ctx.tool.hook("execute.before", event => onToolBefore(ctx, event)),
      )
    }
    if (ctx?.shell?.hook) {
      await register("shell.create.before", () =>
        ctx.shell.hook("create.before", event => {
          event.env.PHRONIA_HOST = "opencode"
        }),
      )
    }
    if (registrations.length === 0) {
      debugLog("v2-setup", "no compatible OpenCode v2 hooks found; plugin is inert")
    }

    return async () => {
      for (const registration of registrations) {
        try {
          await registration?.dispose?.()
        } catch {
          // unload is best-effort
        }
      }
    }
  },
}
