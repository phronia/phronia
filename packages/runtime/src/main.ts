/**
 * Runtime entrypoint.
 *
 * All behaviour lives in @phronia/cli and @phronia/core. This file exists so
 * a bundler has a stable entry; importing the CLI runs its commander program.
 */
import "../../cli/dist/cli/index.js";
