# Gateway identity feasibility (research)

Status: unmeasured on live harness versions; this note records the design
constraints and the experiments that must precede implementation.

## Available signals

| Signal | Reliability | Notes |
|---|---|---|
| Per-project listener / path (`/p/<projectKey>/`) | high | identity comes from routing, not inference |
| Injected `<session-context>` / `PHRONIA_CONTEXT_ID` marker | high when present | only on the first request after our injection |
| System-prompt hash | medium-high | stable within a project; changes on harness upgrade |
| Sub-agent system prompt fingerprint | high | agent definitions are stable inputs |
| `Current task:` in `<workflow-state>` | high | absent on turns without the breadcrumb |
| Provider headers (`x-session-id`, etc.) | low | not standardized across harnesses |
| `metadata.user_id` | medium | provider-specific |

## Proposed identity model

1. Project: one listener per project root, so the route decides `projectKey`.
2. Session: extract `PHRONIA_CONTEXT_ID` when present; otherwise derive a
   provisional id from `(projectKey, systemPromptHash, firstUserMessageHash)`
   and label it `provisional`.
3. Sub-agent: system-prompt fingerprint plus a `phronia-*` agent marker.
4. Task: parse the injected breadcrumb. Missing → `unattributed`; never guess
   from branch names or cwd.

## Known failure modes

- Compaction rewrites the conversation prefix, so a hash-based provisional id
  drifts after compaction. The capture must either accept multiple provisional
  ids per session or wait for a harness-level "new session" signal.
- Two windows in the same project with the same system prompt and an identical
  first user message collide; the injected context key is the only
  discriminator.
- A harness that strips our injected text loses exact attribution entirely.

## Experiments required before implementation

1. Record 20 real requests per protocol per harness; compute system-prompt and
   first-user-message hash stability across turns.
2. Measure how often the first request carries `<session-context>` or
   `PHRONIA_CONTEXT_ID`.
3. Measure provisional-id churn across two compactions.
4. Confirm whether sub-agent dispatches carry the agent name in the system
   prompt without relying on our own injected text.

Success bar: exact attribution for ≥ 90% of turns in a single-window session,
and every remaining turn explicitly labelled `provisional` or `unattributed`.
