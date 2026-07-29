# OpenCode 1.17.18 capability: path-scoped dynamic spec injection

## Scope and version boundary

This note evaluates the official OpenCode `v1.17.18` release, whose tag resolves to commit
[`b1fc8113948b518835c2a39ece49553cffe9b30c`](https://github.com/anomalyco/opencode/tree/b1fc8113948b518835c2a39ece49553cffe9b30c).
The release and both `opencode` and `@opencode-ai/plugin` package versions are pinned to
`1.17.18`:

- [Official v1.17.18 release](https://github.com/anomalyco/opencode/releases/tag/v1.17.18)
- [`packages/opencode/package.json`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/package.json#L1-L5)
- [`packages/plugin/package.json`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/package.json#L1-L18)

The relevant API at this version is the stable root import, `@opencode-ai/plugin`.
Although `v1.17.18` exports `/v2/effect` and `/v2/promise`, their `PluginContext` contains
agent, AI SDK, catalog, command, integration, plugin, reference, and skill domains only.
It does **not** contain tool or session hooks:

- [`v2/effect/context.ts`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/v2/effect/context.ts#L12-L22)
- [`v2/promise/context.ts`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/v2/promise/context.ts#L12-L22)

Therefore, newer online documentation for the beta V2 plugin API must not be treated as
evidence for the `v1.17.18` `/v2` entry points.

## Local 1.17.18 verification

The installed executable was verified independently of the source checkout:

```text
$ command -v opencode
/opt/homebrew/bin/opencode
$ opencode --version
1.17.18
$ ls -l /opt/homebrew/bin/opencode
/opt/homebrew/bin/opencode -> ../Cellar/opencode/1.17.18/bin/opencode
```

A black-box probe then ran that binary with isolated `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, and `XDG_CACHE_HOME`, a temporary project plugin, and a local
OpenAI-compatible mock server. No configured external model or credentials were used. The
mock issued deterministic `write`, `edit`, and `apply_patch` calls and inspected the next
provider request.

| Probe | Observed result |
| --- | --- |
| `write` before hook | Received `tool: "write"` plus the exact absolute `args.filePath`; throwing produced a tool part with `status: "error"` and the target did not exist. |
| `edit` before hook | Received `tool: "edit"` plus `args.filePath`, `oldString`, and `newString`; throwing produced a tool error and the target did not exist. |
| `apply_patch` before hook | Received `tool: "apply_patch"` plus the complete `args.patchText`; throwing produced a tool error and the patch target did not exist. |
| Throw + `experimental.chat.system.transform` | The same session immediately made another model request. The mock found the injected `SPEC_SENTINEL` in that request's system content and returned `SYSTEM=true`. |
| `tool.execute.after` mutation | Appending `AFTER_SENTINEL` to `output.output` changed the persisted tool result. The next model request contained it and the mock returned `AFTER=true`. |
| Before hook + SDK `client.session.prompt({ noReply: true })` + throw | The SDK call returned HTTP 200 inside the hook; the next model request contained the inserted `MESSAGE_SENTINEL` user message and the mock returned `MESSAGE=true`. The blocked file was not written. |
| After hook + SDK `client.session.prompt({ noReply: true })` | The tool completed, the SDK call returned HTTP 200, and the next model request contained the inserted user message. |

Representative CLI output for the pre-tool system-context case was:

```text
tool=write status=error error=BLOCKED_FOR_SPEC_INJECTION
step_finish reason=tool-calls
step_start
text="SYSTEM=true;AFTER=false"
```

This verifies the important distinction: OpenCode continues the main session after a normal
plugin rejection, but it does so as a **new model step**, not by resuming the rejected tool
call.

## Executive verdict

| Question | v1.17.18 verdict |
| --- | --- |
| Can a pre-tool hook see the target path? | **Yes.** `write` and `edit` expose raw `output.args.filePath`. `apply_patch` exposes raw `output.args.patchText`; the plugin must parse all patch marker paths itself. |
| Can `tool.execute.before` return additional context or a message to the model? | **No direct return channel.** Its only mutable output is `{ args }`, its callback returns `Promise<void>`, and the runtime discards callback return values. A subsequent request can receive context through the experimental system/messages transforms, a model-visible thrown error, or a separately inserted `noReply` user message. |
| Can the current tool call be cancelled? | **No first-class cancellation field. Yes via rejection.** Throwing from `tool.execute.before` prevents the actual tool from running and records a tool error. This is the official blocking idiom. |
| Does the model continue after a rejected ordinary tool call? | **Yes.** The error is persisted as model-visible tool output and the main session loop starts another model turn. Permission/question rejection is a special stop case; an ordinary plugin `Error` is not. |
| Can a post-tool hook inject model-visible content? | **Yes.** Mutating `output.output` changes the next turn's tool result. Calling the SDK's synchronous prompt endpoint with `noReply: true` also inserts an independent user message that the next turn sees. Neither is a typed `tool.execute.after` message field. |
| Is strict pre-mutation path-scoped injection possible in the same tool call? | **No.** Once the target is known in `tool.execute.before`, there is no supported “add context, re-enter the model, then resume this same call” operation. |
| Can Trellis still enforce “spec before mutation”? | **Yes, with a block-and-retry gate.** Reject the first call, inject the applicable spec into the next model turn, and allow the retried call only after that context has been delivered. |

## 1. Target-path visibility before execution

The stable plugin type exposes the tool name, session ID, call ID, and raw arguments:

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```

Source: [`packages/plugin/src/index.ts` lines 266–269](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/index.ts#L266-L269).

The hook is awaited before the built-in tool:

```ts
yield* plugin.trigger("tool.execute.before", ..., { args })
const result = yield* item.execute(args, ctx)
...
yield* plugin.trigger("tool.execute.after", ..., output)
return output
```

Source: [`packages/opencode/src/session/tools.ts` lines 102–129](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/tools.ts#L102-L129).

The raw path shapes are:

- `write`: `output.args.filePath`, defined by
  [`WriteTool.Parameters`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/tool/write.ts#L20-L25).
- `edit`: `output.args.filePath`, defined by
  [`EditTool.Parameters`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/tool/edit.ts#L47-L56).
- `apply_patch`, not `patch`: `output.args.patchText`, defined by
  [`ApplyPatchTool.Parameters`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/tool/apply_patch.ts#L18-L24).
  The official tool documentation states that paths are embedded in
  `*** Add File:`, `*** Update File:`, `*** Move to:`, and `*** Delete File:`
  markers and are relative to the project root:
  [`tools.mdx` lines 177–195](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/web/src/content/docs/tools.mdx#L177-L195).

These are pre-normalization arguments. `write` and `edit` resolve relative paths only inside
their later `execute` functions. A Trellis plugin must resolve them against the plugin's
`directory`/`worktree`, normalize them, and treat every path in a patch as an independent
scope-resolution input.

One implementation detail matters if Trellis also rewrites arguments: the wrapper later calls
`item.execute(args, ctx)` with the original `args` object. Mutating a property in place is
reliable; assigning an entirely new object to `output.args` is not. The official `.env`
example also reads/mutates the existing argument object:
[`plugins.mdx` lines 243–257](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/web/src/content/docs/plugins.mdx#L243-L257).

## 2. No direct `additionalContext` or message result from `tool.execute.before`

The type above limits the mutable output to `{ args }`. It has no `additionalContext`,
`message`, `decision`, `cancel`, or `continue` field. The plugin callback returns
`Promise<void>`.

The runtime reinforces that contract:

```ts
for (const hook of s.hooks) {
  const fn = hook[name]
  if (!fn) continue
  yield* Effect.promise(async () => fn(input, output))
}
return output
```

Source: [`packages/opencode/src/plugin/index.ts` lines 280–293](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/plugin/index.ts#L280-L293).

Returning a value from the callback is discarded. Attaching undeclared fields to the
before-hook output has no consumer. The hook cannot retroactively add context to the
already-generated tool call and resume that exact call.

The stable v1 API does expose two separate experimental model-request hooks:

```ts
"experimental.chat.messages.transform"?: (..., output: { messages: ...[] }) => Promise<void>
"experimental.chat.system.transform"?: (..., output: { system: string[] }) => Promise<void>
```

Sources:

- [Hook types](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/index.ts#L282-L296)
- [`messages.transform` before model-message conversion](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/prompt.ts#L1252-L1286)
- [`system.transform` before provider request assembly](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/llm/request.ts#L56-L78)

They can inject model-visible context on a **subsequent model request**, using plugin state
keyed by `sessionID`, but they are not a return channel from the current tool hook. A system
transform addition is request-local, so Trellis must re-add still-active specs on every
relevant request or persist the content through a model-visible tool result/message.

### Independent user-message injection through the SDK

The stable plugin input includes an OpenCode SDK `client`:

- [Plugin input type](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/index.ts#L56-L66)
- [Official plugin documentation](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/web/src/content/docs/plugins.mdx#L104-L125)

That client exposes the session prompt endpoint, whose request supports `noReply`:

- [`client.session.prompt()`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/sdk/js/src/gen/sdk.gen.ts#L612-L624)
- [`SessionPromptData.noReply`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/sdk/js/src/gen/types.gen.ts#L2588-L2613)
- [The server creates the user message and returns before starting a loop when `noReply === true`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/prompt.ts#L1055-L1071)

Consequently, either tool hook can do:

```ts
await client.session.prompt({
  path: { id: input.sessionID },
  query: { directory },
  body: {
    noReply: true,
    parts: [{ type: "text", text: resolvedSpec }],
  },
})
```

The local probe verified that this message is present in the next model request. It is a real,
persisted user message, not hidden additional context: it changes session history and may be
visible in clients. It is therefore a compatibility carrier, not the preferred semantic role
for Trellis rules/specs.

`noReply: true` is essential inside a hook. Without it, the prompt service starts the same
session loop. A running session's `ensureRunning` waits for the current run to finish, while
the current run is waiting for the hook, producing a circular wait. This is a source-derived
concurrency warning:

- [Normal prompt starts `loop()`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/prompt.ts#L1068-L1071)
- [`loop()` uses `ensureRunning`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/prompt.ts#L1343-L1347)
- [`ensureRunning` waits for an existing run](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/effect/runner.ts#L115-L138)

## 3. Rejecting the current call and continuing the main session

There is no typed cancellation primitive. Throwing from `tool.execute.before` is nevertheless
an officially documented veto mechanism:

```js
if (input.tool === "read" && output.args.filePath.includes(".env")) {
  throw new Error("Do not read .env files")
}
```

Source: [official `.env protection` plugin example](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/web/src/content/docs/plugins.mdx#L243-L257).

Because the hook is awaited immediately before `item.execute`, throwing prevents the actual
mutation and skips `tool.execute.after`. The failure then follows this source path:

1. The AI SDK adapter maps it to an OpenCode `tool-error` event:
   [`session/llm/ai-sdk.ts` lines 249–260](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/llm/ai-sdk.ts#L249-L260).
2. The processor persists the error on the tool part. Only permission/question rejection sets
   the loop's `blocked` flag; an ordinary plugin `Error` does not:
   [`session/processor.ts` lines 186–205](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/processor.ts#L186-L205).
3. With no blocked flag or assistant-level error, the processor returns `continue`:
   [`session/processor.ts` lines 627–682](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/processor.ts#L627-L682).
4. The next model-message conversion emits the stored failure as `output-error` with
   `errorText`:
   [`session/message-v2.ts` lines 325–347](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/message-v2.ts#L325-L347).
5. The main session loop starts its next model turn:
   [`session/prompt.ts` lines 1319–1335](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/prompt.ts#L1319-L1335).

This gives Trellis two workable carriers:

1. **Minimal, non-experimental carrier:** include the applicable spec and retry instruction in
   the thrown error. OpenCode persists it as a model-visible tool error, then continues.
2. **Cleaner presentation, experimental carrier:** store the resolved spec in per-session
   plugin state, throw a short blocking error, and inject the active spec through
   `experimental.chat.system.transform` on the next request. Allow the retried mutation only
   after that spec is active for the session.
3. **Stable SDK compatibility carrier:** synchronously insert a `noReply` user message, then
   throw. This is model-visible and locally verified, but it pollutes persistent chat history
   with a synthetic user turn.

Neither carrier resumes the same tool call. The model must generate a new call after receiving
the context.

## 4. Post-tool model-visible injection

The after-hook contract is:

```ts
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: {
    title: string
    output: string
    metadata: any
  },
) => Promise<void>
```

Source: [`packages/plugin/src/index.ts` lines 274–281](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/plugin/src/index.ts#L274-L281).

For OpenCode built-in and plugin tools, the after hook receives the same `output` object later
returned by the wrapper. Therefore, appending to `output.output` changes the standard tool
result:

- [Wrapper passes `output` through the after hook and returns it](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/tools.ts#L111-L129)
- [Processor extracts and persists `result.value.output`](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/processor.ts#L257-L276)
- [Completed output becomes model-visible `output-available` content](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/message-v2.ts#L290-L323)

This is model-visible content, but it is part of the tool result, not an independent chat,
user, or system message. `title` and `metadata` are not substituted for tool-result text.
Adding undeclared `message` or `additionalContext` fields has no supported consumer. If an
independent message is required, `client.session.prompt({ noReply: true })` works from the
after hook as described above and was also verified locally.

This after-hook technique is too late to protect the write that just finished. It can guide
subsequent work, provide diagnostics, or record newly activated context. Enforcement of
“spec before mutation” must happen in the before hook.

The conclusion above is deliberately limited to standard OpenCode tools returning
`{ title, output, metadata }`. In `v1.17.18`, the MCP branch passes a raw MCP
`CallToolResult` to the after hook and later rebuilds text from `result.content`; this does
not match the stable v1 after-hook type:
[`session/tools.ts` lines 395–430](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/session/tools.ts#L395-L430).

## Recommended Trellis capability boundary

OpenCode `1.17.18` supports a reliable Trellis main-session workflow only with an explicit
gate:

```text
model proposes write/edit/apply_patch
  -> before hook extracts and normalizes every target path
  -> scope resolver finds required spec versions
  -> if the required context is not active: record it and throw
  -> OpenCode persists a model-visible tool error and continues
  -> next model request receives the specs
  -> model retries
  -> before hook verifies the same spec versions are active
  -> mutation executes
```

Key the gate by at least `sessionID + normalized target path + spec version` so a retry does not
loop forever and a spec update invalidates an earlier decision. For `apply_patch`, evaluate the
union of scopes for every marker path before allowing any hunk to execute.

Use `experimental.chat.system.transform` as the primary carrier because rules/specs belong in
system context and it does not create fake user turns. Keep the entire active spec set in
session-keyed plugin state and append it on every request; request-local system additions do
not persist automatically. The smallest stable fallback is to put the spec in the thrown tool
error. Use a `noReply` SDK message only when a distinct persistent message is explicitly
required.

Operational limitations:

- Both system and message transforms are explicitly experimental in `1.17.18`; an OpenCode
  upgrade must re-run this contract probe.
- `tool.execute.after` is reached only after a successful `item.execute`; a tool that throws
  before returning has no after-hook injection opportunity.
- `apply_patch` may contain multiple source/destination paths. A move must resolve both the
  `*** Update File:` source and `*** Move to:` destination before the all-or-nothing call is
  allowed.
- OpenCode selects `apply_patch` only for certain GPT model IDs and otherwise selects
  `edit`/`write`, so the plugin must intercept all three names:
  [`tool/registry.ts` lines 286–298](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/opencode/src/tool/registry.ts#L286-L298).
- These three hooks do not cover file mutation through `bash`, custom tools, MCP tools, or
  subagents. A complete governance claim requires separate controls for those paths.

The product claim should be:

> Trellis can enforce path-scoped spec delivery before a file mutation by intercepting and
> retrying the call.

It should not be:

> OpenCode can add context inside `tool.execute.before` and resume the same tool call.

Transparent cancellation, a typed `additionalContext` response, or an independent
model-visible message emitted directly from a tool hook would require an upstream OpenCode API
addition or a core/custom-tool wrapper.
