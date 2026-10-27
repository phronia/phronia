/** User-visible notices — one source for every shim. */

export const FIRST_REPLY_NOTICE_HEAD = `<first-reply-notice>
On the first visible assistant reply in this session, briefly acknowledge that Phronia SessionStart context loaded.`;

export const FIRST_REPLY_NOTICE_TAIL = `Choose the acknowledgment language in this order:
1. Use the language of the user's current request (the user message that triggered this reply).
2. If that request has no clear natural language, use an explicitly established project communication language.
3. If neither provides a language, output the language-neutral fallback exactly: \`Phronia SessionStart ✓\`.
Continue directly with the user's request after the acknowledgment.
The acknowledgment must not alter the language used for the remainder of the response.
This notice is one-shot: do not repeat it after the first visible assistant reply in this session.
</first-reply-notice>`;

export const FIRST_REPLY_NOTICE = `${FIRST_REPLY_NOTICE_HEAD}\n${FIRST_REPLY_NOTICE_TAIL}`;

export function buildFirstReplyNotice(updateHint: string | null | undefined): string {
  if (!updateHint) {
    return FIRST_REPLY_NOTICE;
  }
  return `${FIRST_REPLY_NOTICE_HEAD}\nAlso relay this Phronia maintenance notice on its own line in that same reply: ${updateHint}\n${FIRST_REPLY_NOTICE_TAIL}`;
}

export const SESSION_CONTEXT = `<session-context>
Phronia compact SessionStart context. Use it to orient the session; load details on demand.
</session-context>`;

export const READY = `<ready>
Context loaded. Follow <task-status>. Load workflow/spec/task details only when needed.
</ready>`;

export const CONTEXT_ORDER =
  "Task context order for implementation/check: jsonl entries -> `prd.md` -> `design.md if present` -> `implement.md if present`. Missing optional artifacts are skipped for lightweight tasks.";
