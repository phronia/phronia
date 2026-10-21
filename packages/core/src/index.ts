// Root barrel — re-exports the channel, task, and layout public APIs so callers
// can `import { ... } from "@mindfoldhq/trellis-core"`. Sub-path
// imports (`@mindfoldhq/trellis-core/channel`, `/task`, `/layout`) remain the
// recommended form for tree-shake-friendly consumption.

export * from "./channel/index.js";
export * from "./task/index.js";
export * from "./layout/index.js";
export * from "./layout/env.js";
