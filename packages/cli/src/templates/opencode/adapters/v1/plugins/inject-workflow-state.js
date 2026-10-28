/* global process */
// phronia-shim: opencode@v1
// shim-version: 0.6.17
// DO NOT EDIT. Regenerate with: phronia update --regenerate-shims
/**
 * Phronia Workflow State Injection Plugin
 *
 * Per-turn UserPromptSubmit equivalent for OpenCode. The breadcrumb text is
 * produced by `phronia context --event user-prompt`; this plugin only reads
 * the latest prompt, calls the core, and prepends the returned block.
 * Stored history and the TUI are not modified (issue #553).
 */

import { blocksText, runContext } from "../lib/phronia-client.js"
import {
  MESSAGES_TRANSFORM_HOOK,
  isPhroniaSubagent,
  latestUserPromptText,
  platformInputFromMessages,
  prependEphemeralText,
} from "../lib/context-visibility.js"

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

      const prompt = latestUserPromptText(messages)
      const response = runContext({
        event: "user-prompt",
        platform: "opencode",
        projectRoot: directory,
        input: { ...platformInput, prompt },
      })
      const breadcrumb = blocksText(response)
      if (!breadcrumb) {
        return
      }
      prependEphemeralText(messages, breadcrumb)
    },
  }
}
