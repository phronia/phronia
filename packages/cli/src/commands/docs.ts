/**
 * `phronia docs generate` — regenerate the deterministic knowledge layer.
 * `architecture.md` and `product.md` are narrative and never generated.
 */

import { writeRequirements } from "@phronia/core";

export interface DocsOptions {
  cwd: string;
  check?: boolean;
  json?: boolean;
}

export function runDocsGenerate(options: DocsOptions): number {
  const result = writeRequirements(options.cwd, { check: options.check });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ path: result.path, changed: result.changed }, null, 2)}\n`,
    );
  } else if (result.changed) {
    process.stdout.write(
      options.check
        ? `docs/requirements.md is stale; run \`phronia docs generate\`.\n`
        : `Wrote ${result.path}.\n`,
    );
  } else {
    process.stdout.write("docs/requirements.md is current.\n");
  }
  return options.check && result.changed ? 1 : 0;
}
