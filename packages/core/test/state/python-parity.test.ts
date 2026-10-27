import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSimpleYaml } from "../../src/state/config/yaml.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SCRIPTS_DIR = path.join(
  REPO_ROOT,
  "packages/cli/src/templates/workflow/scripts",
);

const pythonAvailable =
  spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" }).status === 0;

const PROBE = [
  "import json, sys",
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
  "from common.trellis_config import parse_simple_yaml",
  "print(json.dumps(parse_simple_yaml(sys.stdin.read()), sort_keys=True))",
].join("\n");

const CASES: Record<string, string> = {
  simple: "a: one\nb: two\n",
  nested: "a:\n  b: one\n  c:\n    d: two\n",
  list: "list:\n  - x\n  - y\nvalues:\n  nested: yes\n",
  quoted: 'a: ""\nb: "hash # inside"\nc: \'# also\'\n',
  comments: "# header\na: value # inline\n\nb: two\n",
  crlf: "a: one\r\nb:\r\n  c: two\r\n",
  empty: "",
  flow: "a: [x, y]\nb: {c: d}\n",
  anchor: "a: &x value\nb: *x\n",
  block: "a: |\n  line one\n  line two\nb: after\n",
  mappingInList: "list:\n  - name: a\n    path: b\n",
};

describe.skipIf(!pythonAvailable)("YAML parser parity", () => {
  for (const [name, content] of Object.entries(CASES)) {
    it(`matches Python for ${name}`, () => {
      const result = spawnSync("python3", ["-c", PROBE], {
        input: content,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const expected = JSON.parse(result.stdout) as unknown;
      const actual = parseSimpleYaml(content).value;
      expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
    });
  }
});
