// Root barrel — re-exports the channel, task, and layout public APIs so callers
// can `import { ... } from "@phronia/core"`. Sub-path
// imports (`@phronia/core/channel`, `/task`, `/layout`) remain the
// recommended form for tree-shake-friendly consumption.

export * from "./channel/index.js";
export * from "./task/index.js";
export * from "./layout/index.js";
export * from "./layout/env.js";
export * from "./state/index.js";
export * from "./platform/index.js";
export * from "./context/index.js";
export * from "./version.js";
