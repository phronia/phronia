/**
 * Regression tests for `truncateUtf8` in the Pi extension template (F12).
 *
 * The Pi TS mirror of the shared-hooks `truncate_utf8` carried the same
 * UTF-8 boundary defect as the Python copies (taosu's PR #468 review):
 * a cap landing exactly after a complete multi-byte sequence backed into
 * the sequence and emitted a broken lead byte. The template is a `.ts.txt`
 * file outside this package's compilation, so the test extracts the
 * function out of `pi/extensions/trellis/index.ts.txt`, transpiles it with
 * the real TypeScript compiler and runs the reviewer's repro cases plus a
 * cap sweep against the evaluated JS (no re-implementation, no mocking).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import vm from "node:vm";
import ts from "typescript";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../../src/templates/pi/extensions/trellis/index.ts.txt",
);

type TruncateUtf8 = (buf: Buffer, cap: number) => Buffer;

/** Extract `function truncateUtf8` from the template source, transpile it
 * with the TypeScript compiler and evaluate the emitted JS. */
function loadTruncateUtf8(templatePath: string): TruncateUtf8 {
  const source = fs.readFileSync(templatePath, "utf-8");
  // From the declaration up to the first closing brace at column 0 — the
  // function body is indented, so that brace is the function's own.
  const match = /function truncateUtf8\([\s\S]*?\n\}/.exec(source);
  if (!match) {
    throw new Error(`truncateUtf8 not found in ${templatePath}`);
  }
  const js = ts.transpileModule(match[0], {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return vm.runInNewContext(`${js}\ntruncateUtf8`, { Buffer }) as TruncateUtf8;
}

function strictDecode(buf: Buffer): string {
  // fatal: true — throws TypeError on any broken byte instead of emitting
  // U+FFFD replacement characters.
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

describe("pi extension template: truncateUtf8 UTF-8 boundary (F12)", () => {
  const truncateUtf8 = loadTruncateUtf8(TEMPLATE_PATH);

  it('keeps a complete trailing sequence whole: "你好世界" capped at 6 bytes is "你好"', () => {
    // Cap lands exactly after the complete 3-byte "好" — must keep it,
    // never emit "你" plus a dangling lead byte (taosu's PR #468 repro).
    const out = truncateUtf8(Buffer.from("你好世界", "utf-8"), 6);
    const decoded = strictDecode(out);
    expect(decoded).toBe("你好");
    expect(decoded).not.toContain("�");
  });

  it('keeps a complete 2-byte sequence at the cap: [0x61, 0xC3, 0xA9, 0x62] capped at 3 is "aé"', () => {
    const out = truncateUtf8(Buffer.from([0x61, 0xc3, 0xa9, 0x62]), 3);
    expect(strictDecode(out)).toBe("aé");
  });

  it("cap sweep 0..30 over mixed 1/2/3/4-byte content: strict decode never throws, positive caps never exceeded", () => {
    // 1 + 2 + 3 + 4 + 1 + 3 + 3 = 17 bytes of mixed-width sequences
    const data = Buffer.from("aé€\u{1f600}z你好", "utf-8");
    expect(data.length).toBe(17);
    for (let cap = 0; cap <= 30; cap++) {
      const out = truncateUtf8(data, cap);
      expect(() => strictDecode(out)).not.toThrow();
      if (cap === 0) {
        // cap <= 0 means unlimited by contract — the full buffer comes back.
        expect(out.equals(data)).toBe(true);
      } else {
        expect(out.length).toBeLessThanOrEqual(cap);
      }
    }
  });
});
