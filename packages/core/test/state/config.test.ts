import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSimpleYaml } from "../../src/state/config/yaml.js";
import {
  DEFAULT_MAX_JOURNAL_LINES,
  readConfig,
} from "../../src/state/config/readers.js";
import { openState } from "../../src/state/index.js";
import type { FsLike } from "../../src/state/fs.js";

describe("simple YAML subset", () => {
  it("parses scalars, nested mappings, and lists", () => {
    const { value, warnings } = parseSimpleYaml(
      [
        "name: demo",
        "nested:",
        "  a: one",
        "  b:",
        "    - x",
        "    - y",
        "list:",
        "  - p",
        "  - q",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(value).toEqual({
      name: "demo",
      nested: { a: "one", b: ["x", "y"] },
      list: ["p", "q"],
    });
  });

  it("strips inline comments outside quotes", () => {
    const { value } = parseSimpleYaml(
      ['a: value # comment', 'b: "hash # inside"', "c: '# also inside'"].join(
        "\n",
      ),
    );
    expect(value).toEqual({
      a: "value",
      b: "hash # inside",
      c: "# also inside",
    });
  });

  it("keeps quoted empty strings and empty mappings", () => {
    const { value } = parseSimpleYaml(['a: ""', "b:"].join("\n"));
    expect(value).toEqual({ a: "", b: {} });
  });

  it("warns and skips unsupported constructs", () => {
    const { value, warnings } = parseSimpleYaml(
      [
        "block: |",
        "  not parsed",
        "anchor: &x value",
        "alias: *x",
        "merge:",
        "  <<: *x",
        "flow: [a, b]",
        "mapping: {a: b}",
      ].join("\n"),
    );
    expect(value).toEqual({ merge: {} });
    expect(warnings.map((warning) => warning.reason)).toEqual(
      expect.arrayContaining([
        "block scalars are not supported",
        "YAML anchors are not supported",
        "YAML aliases are not supported",
        "YAML merge keys are not supported",
        "flow sequences are not supported (use `- ` list items)",
        "flow mappings are not supported (use an indented mapping)",
      ]),
    );
  });

  it("warns on a mapping nested inside a list instead of hoisting it", () => {
    const { value, warnings } = parseSimpleYaml(
      ["list:", "  - name: a", "    path: b"].join("\n"),
    );
    expect(value).toEqual({ list: ["name: a"] });
    expect(warnings[0]?.reason).toMatch(/mappings inside a list/);
  });

  it("handles CRLF input", () => {
    const { value } = parseSimpleYaml("a: one\r\nb:\r\n  c: two\r\n");
    expect(value).toEqual({ a: "one", b: { c: "two" } });
  });
});

describe("config readers", () => {
  it("returns defaults when the file is missing", () => {
    const result = readConfig("/repo", memFs({}));
    expect(result.value).toMatchObject({
      sessionCommitMessage: "chore: record journal",
      maxJournalLines: DEFAULT_MAX_JOURNAL_LINES,
      sessionAutoCommit: true,
      codexDispatchMode: "auto",
      contextInjection: {
        maxFileBytes: 32768,
        maxArtifactBytes: 65536,
        maxTotalBytes: 131072,
      },
      promptInjection: { skipKeyword: "no-trellis" },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("reads platform adapter pins and the zcode path", () => {
    const result = readConfig(
      "/repo",
      memFs({
        ".phronia/config.yaml": [
          "platforms:",
          "  opencode:",
          "    adapter: opencode@v1",
          "  zcode:",
          "    path: bridge",
        ].join("\n"),
      }),
    );
    expect(result.value.adapterPins).toEqual({ opencode: "opencode@v1" });
    expect(result.value.zcodePath).toBe("bridge");
  });

  it("parses valid values", () => {
    const result = readConfig(
      "/repo",
      memFs({
        ".phronia/config.yaml": [
          "session_commit_message: custom",
          "max_journal_lines: 42",
          "session_auto_commit: off",
          "codex:",
          "  dispatch_mode: sub-agent",
          "context_injection:",
          "  max_file_bytes: 1000",
          "  max_artifact_bytes: 0",
          "  max_total_bytes: 2000",
          "prompt_injection:",
          "  skip_keyword: quiet",
        ].join("\n"),
      }),
    );
    expect(result.value).toMatchObject({
      sessionCommitMessage: "custom",
      maxJournalLines: 42,
      sessionAutoCommit: false,
      codexDispatchMode: "auto",
      contextInjection: {
        maxFileBytes: 1000,
        maxArtifactBytes: 0,
        maxTotalBytes: 2000,
      },
      promptInjection: { skipKeyword: "quiet" },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("warns and falls back on invalid values", () => {
    const result = readConfig(
      "/repo",
      memFs({
        ".phronia/config.yaml": [
          "session_auto_commit: maybe",
          "codex:",
          "  dispatch_mode: weird",
          "context_injection:",
          "  max_file_bytes: -1",
        ].join("\n"),
      }),
    );
    expect(result.value.sessionAutoCommit).toBe(true);
    expect(result.value.codexDispatchMode).toBe("inline");
    expect(result.value.contextInjection.maxFileBytes).toBe(32768);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "state.config.invalid_value",
      "state.config.invalid_value",
      "state.config.invalid_value",
    ]);
  });
});

describe("openState", () => {
  it("requires an explicit root", () => {
    expect(() => openState({ root: "" })).toThrow(/explicit project root/);
  });

  it("reads config once and exposes diagnostics", () => {
    const reader = openState({
      root: "/repo",
      fs: memFs({ ".phronia/config.yaml": "session_auto_commit: nope\n" }),
    });
    expect(reader.exists()).toBe(true);
    expect(reader.config().sessionAutoCommit).toBe(true);
    expect(reader.diagnostics()).toHaveLength(1);
  });
});

function memFs(files: Readonly<Record<string, string>>): FsLike {
  const absolute: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    absolute[path.join("/repo", key)] = value;
  }
  return {
    existsSync: (target) => target in absolute,
    readFileSync: (target) => {
      const content = absolute[target];
      if (content === undefined) {
        throw new Error(`missing ${target}`);
      }
      return content;
    },
    readdirSync: () => [],
    statSync: (target) => ({
      isDirectory: () => target in absolute || path.extname(target) === "",
      isFile: () => target in absolute,
    }),
    realpathSync: (target) => target,
  };
}
