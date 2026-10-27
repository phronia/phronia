/* global process */
// phronia-shim: opencode@v1
// shim-version: 0.6.17
// DO NOT EDIT. Regenerate with: phronia update --regenerate-shims
/**
 * Phronia Session Start Plugin
 *
 * Injects compact SessionStart context into the copy of the latest user
 * message that OpenCode sends to the model. Uses
 * `experimental.chat.messages.transform` so TUI / Web / SQLite history
 * stay untouched (issue #553).
 *
 * Assembly lives in the core (`phronia context`); this file only translates
 * the host payload and applies the returned blocks.
 */

import { blocksText, runContext } from "../lib/phronia-client.js"
import {
  MESSAGES_TRANSFORM_HOOK,
  isPhroniaSubagent,
  platformInputFromMessages,
  prependEphemeralText,
  transcriptHasAssistantMessage,
} from "../lib/context-visibility.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

export default async ({ directory }) => {
  return {
    [MESSAGES_TRANSFORM_HOOK]: async (_input, output) => {
      const messages = output?.messages
      const platformInput = platformInputFromMessages(messages)
      if (!platformInput || isPhroniaSubagent(platformInput)) {
        return
      }
      if (process.env.PHRONIA_HOOKS === "0" || process.env.PHRONIA_DISABLE_HOOKS === "1") {
        return
      }
      if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
        return
      }

      const response = runContext({
        event: "session-start",
        platform: "opencode",
        projectRoot: directory,
        input: platformInput,
      })
      let context = blocksText(response)
      if (!context) {
        return
      }
      if (transcriptHasAssistantMessage(messages)) {
        context = stripFirstReplyNotice(context)
      }
      prependEphemeralText(messages, context)
    },
  }
}
