# Gateway protocol notes (research)

Status: research only. No gateway runtime is shipped.

## Scope

The gateway would sit between a harness and its model provider, see the wire
protocol, and capture turns for `mem`. This note records what the three
protocols require and where parsing is allowed to be lossy.

## Protocols

| Protocol | Entry | Required fields | Streaming | Unknown-field rule |
|---|---|---|---|---|
| Anthropic Messages | `POST /v1/messages` | `model`, `system`, `messages`, `max_tokens`, `stream` | SSE `message_start`, `content_block_delta`, `message_stop` | pass through untouched |
| OpenAI Responses | `POST /v1/responses` | `model`, `input`, `instructions`, `stream` | SSE `response.output_text.delta`, `response.completed` | pass through |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `model`, `messages`, `stream` | SSE `choices[].delta` + `[DONE]` | pass through |

## Capture rules

- Parse only `model`, system/instructions, messages/input, tools, `stream`,
  and `usage`.
- A parse failure must forward the original bytes and record one
  `capture-parse-failed` event. It must never fail the request.
- Tool calls are captured as requests, not results: the harness's next
  request is the only evidence that a tool finished.
- Streaming capture buffers per response and flushes on the terminal event;
  an interrupted stream stores what arrived with `partial: true`.

## Prompt cache discipline

- Phase 1 is read-only. It must not rewrite system prompts, tool definitions,
  or middle-of-conversation content.
- Any future tail injection changes the cache prefix and needs a separate
  review with measured hit-rate loss.

## Open questions

- Whether Anthropic `metadata.user_id` is populated by the harnesses we care
  about (unverified).
- Whether any harness lets users set a custom base URL without a proxy
  shim; this decides whether the gateway is usable at all.
- SSE event names drift between provider minor versions; fixtures must be
  recorded from real traffic before implementation.
