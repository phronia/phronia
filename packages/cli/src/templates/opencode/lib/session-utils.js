/* global process */
/**
 * Persisted-context markers for OpenCode message parts.
 *
 * The context assembly that used to live here moved to `phronia context`.
 * What remains is the small metadata contract used to detect an already
 * injected session-start in persisted history.
 */

import { debugLog } from "./phronia-context.js"

function getTrellisMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {}
  }
  // `phronia` is current; `trellis` is read for sessions that started before
  // the rename (persisted parts outlive the upgrade).
  const trellis = metadata.phronia ?? metadata.trellis
  if (!trellis || typeof trellis !== "object") {
    return {}
  }
  return trellis
}

function hasSessionStartMarker(part) {
  if (!part || part.type !== "text" || typeof part.text !== "string") {
    return false
  }
  return getTrellisMetadata(part.metadata).sessionStart === true
}

export function hasInjectedTrellisContext(messages) {
  if (!Array.isArray(messages)) {
    return false
  }
  return messages.some(message => {
    if (!message?.info || message.info.role !== "user" || !Array.isArray(message.parts)) {
      return false
    }
    return message.parts.some(hasSessionStartMarker)
  })
}

export async function hasPersistedInjectedContext(client, directory, sessionID) {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
      throwOnError: true,
    })
    return hasInjectedTrellisContext(response.data || [])
  } catch (error) {
    debugLog(
      "session",
      "Failed to read session history for dedupe:",
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
