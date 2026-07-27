/**
 * Integration tests for path-scoped on-demand spec injection (v2 ticket-refresh
 * with lifecycle-event reset state).
 *
 * Tests carrying an `F<n>:` prefix pin a fixed audit finding that remains
 * relevant after the transcript clock was removed.
 *
 * Covers four surfaces:
 *   - `src/templates/trellis/scripts/common/spec_match.py` — glob→regex
 *     translation, deny-list glob validation (R6), tolerant frontmatter parsing
 *     (R6), `match_specs_for_file`
 *   - `src/templates/trellis/scripts/common/spec_inject.py` — the pure decision
 *     engine (R7): `decide` truth table, `within_window`, `truncate_chars`,
 *     `assemble_payload`'s hard character ceiling
 *   - `src/templates/shared-hooks/inject-spec-context.py` — PostToolUse and
 *     SessionStart hook E2E: character budgets, lifecycle reset markers,
 *     parent/subagent state, the pid-less locked state file, the unwritable
 *     circuit breaker and scoped GC, stateless ticket wording and tools config
 *   - `get_context.py --mode spec --file <path>` — pull mode
 *
 * Scripts are stamped into a fresh temp dir and exercised through the real
 * `python3` interpreter (no mocking of file I/O or config parsing). Every hook
 * run pins `LC_ALL=C`/`LANG=C` (sibling-hook convention) and
 * `TRELLIS_SPEC_STATE_DIR` under the per-test temp dir, so the user-global
 * (`~/.trellis/spec-inject`) state store is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);
const HOOK_PATH = path.resolve(
  __dirname,
  "../../src/templates/shared-hooks/inject-spec-context.py",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(tmp: string): void {
  fs.mkdirSync(path.join(tmp, ".trellis", "scripts"), { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".trellis", "scripts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmp, ".trellis", "spec"), { recursive: true });
}

function writeConfig(tmp: string, lines: string[]): void {
  fs.writeFileSync(
    path.join(tmp, ".trellis", "config.yaml"),
    lines.join("\n") + "\n",
    "utf-8",
  );
}

/** Write a spec file under .trellis/spec/ and return its absolute path. */
function writeSpec(tmp: string, rel: string, content: string): string {
  const abs = path.join(tmp, ".trellis", "spec", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

/** The out-of-repo, user-global state base for a given fixture repo. Pinned
 * under the temp dir via TRELLIS_SPEC_STATE_DIR so tests never touch
 * ~/.trellis/spec-inject. */
function stateBase(tmp: string): string {
  return path.join(tmp, "spec-inject-state");
}

/** Every *.jsonl state shard under `dir`, recursively (R4: state files live at
 * <base>/<project16>/<identity>.jsonl — one per identity, no pid shards). */
function listJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonl(full));
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

interface StateRecord {
  v: number;
  spec?: string;
  sha256?: string;
  mode?: string;
  ts: number;
  reset?: string;
  complete?: boolean;
}

function readShardRecords(shard: string): StateRecord[] {
  return fs
    .readFileSync(shard, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StateRecord);
}

/** The single state shard the hook wrote; fails loudly when there is not
 * exactly one (R4 pins one file per identity). */
function soleShard(tmp: string): string {
  const shards = listJsonl(stateBase(tmp));
  expect(shards.length, `expected exactly one shard, got ${shards.join(", ")}`).toBe(1);
  return shards[0];
}

/** Run a Python snippet with spec_match helpers preloaded and the repo root
 * available as `REPO_ROOT`. Returns the raw spawn result so callers can
 * assert on stderr warnings too. */
function runSpecProbe(
  tmp: string,
  code: string,
): { status: number | null; stdout: string; stderr: string } {
  const probePath = path.join(tmp, "spec_probe.py");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".trellis", "scripts"))})
from pathlib import Path
from common.spec_match import glob_to_regex, validate_glob, match_specs_for_file
REPO_ROOT = Path(${JSON.stringify(tmp)})
${code}
`;
  fs.writeFileSync(probePath, script, "utf-8");
  const r = spawnSync("python3", [probePath], { cwd: tmp, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** R7: import the pure decision module directly (sibling of runSpecProbe).
 * `Cand` is a structural stand-in for spec_match.SpecMatch. */
function runInjectProbe(
  tmp: string,
  code: string,
): { status: number | null; stdout: string; stderr: string } {
  const probePath = path.join(tmp, "inject_probe.py");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".trellis", "scripts"))})
from pathlib import Path
from common.spec_inject import (
    STATE_VERSION,
    assemble_payload,
    decide,
    make_record,
    render_full,
    render_ticket,
    truncate_chars,
    truncation_notice,
    within_window,
)

class Cand:
    """Structural view of spec_match.SpecMatch (assemble_payload only reads
    spec_path/rel_path/description)."""

    def __init__(self, spec_path, rel_path, description):
        self.spec_path = spec_path
        self.rel_path = rel_path
        self.description = description

REPO_ROOT = Path(${JSON.stringify(tmp)})
${code}
`;
  fs.writeFileSync(probePath, script, "utf-8");
  const r = spawnSync("python3", [probePath], { cwd: tmp, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Evaluate glob→path pairs through glob_to_regex; returns "1"/"0" per pair. */
function globMatches(tmp: string, cases: [string, string][]): string[] {
  const r = runSpecProbe(
    tmp,
    `
cases = ${JSON.stringify(cases)}
for g, p in cases:
    print("1" if glob_to_regex(g).match(p) else "0")
`,
  );
  expect(r.status, `glob probe failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim().split("\n");
}

/** Print `rel_path|description` lines for match_specs_for_file. */
function runMatch(
  tmp: string,
  filePath: string,
): { status: number | null; stdout: string; stderr: string } {
  return runSpecProbe(
    tmp,
    `
for m in match_specs_for_file(REPO_ROOT, ${JSON.stringify(filePath)}):
    print(f"{m.rel_path}|{m.description}")
`,
  );
}

function runHook(
  tmp: string,
  input: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Sibling-hook convention: pin locale so character-oriented assertions are
    // stable across machines.
    LC_ALL: "C",
    LANG: "C",
    // Hermetic state: keep every shard under the per-test temp dir.
    TRELLIS_SPEC_STATE_DIR: stateBase(tmp),
  };
  delete env.TRELLIS_HOOKS;
  delete env.TRELLIS_DISABLE_HOOKS;
  // Identity delegates to common.active_task.resolve_context_key, which also
  // consults env fallbacks (TRELLIS_CONTEXT_ID override plus per-platform
  // *_SESSION_ID / *_CONVERSATION_ID / *_TRANSCRIPT_PATH keys). The dev shell
  // running vitest may carry those (e.g. CLAUDE_CODE_SESSION_ID inside a
  // Claude Code session), so strip every identity-bearing key for hermetic
  // no-identity cases; tests opt back in via extraEnv.
  delete env.TRELLIS_CONTEXT_ID;
  const identityBearing =
    /(_SESSION_?ID|_CONVERSATION_?ID|_TRANSCRIPT_PATH|_THREAD_ID|_RUN_ID)$/i;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !identityBearing.test(key)),
  );
  Object.assign(cleanEnv, extraEnv);
  const r = spawnSync("python3", [HOOK_PATH], {
    cwd: tmp,
    encoding: "utf-8",
    input,
    env: cleanEnv,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface PayloadOpts {
  filePath: string;
  /** session_id; defaults to "sess-1". Pass `null` to omit all identity keys. */
  session?: string | null;
  toolName?: string;
  agentId?: string;
  transcriptPath?: string;
}

function buildPayload(tmp: string, opts: PayloadOpts): string {
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    cwd: tmp,
    tool_name: opts.toolName ?? "Edit",
    tool_input: { file_path: opts.filePath },
  };
  if (opts.session !== null) {
    payload.session_id = opts.session ?? "sess-1";
  }
  if (opts.agentId !== undefined) {
    payload.agent_id = opts.agentId;
  }
  if (opts.transcriptPath !== undefined) {
    payload.transcript_path = opts.transcriptPath;
  }
  return JSON.stringify(payload);
}

function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

/** Extract the 12-hex sha256 attr the FULL/TICKET tags carry; fail loudly if
 * the frozen `sha256="<12hex>"` attribute is missing. */
function requireSha(ctx: string): string {
  const m = /sha256="([0-9a-f]{12})"/.exec(ctx);
  if (!m) {
    throw new Error(`expected sha256 attr in: ${ctx.slice(0, 200)}`);
  }
  return m[1];
}

/** The single <spec-context> block's body (everything between the open tag
 * line and the closing tag). */
function fullBlockBody(ctx: string): string {
  const m = /^<spec-context [^\n>]*>\n([\s\S]*)\n<\/spec-context>$/.exec(ctx);
  if (!m) {
    throw new Error(`expected exactly one <spec-context> block: ${ctx.slice(0, 200)}`);
  }
  return m[1];
}

function runGetContext(
  tmp: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(tmp, ".trellis", "scripts", "get_context.py"), ...args],
    { cwd: tmp, encoding: "utf-8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!hasPython())("spec injection (path-scoped on-demand)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-spec-injection-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("common/spec_match.py: glob semantics", () => {
    it("* matches within a segment and never crosses /", () => {
      expect(
        globMatches(tmp, [
          ["src/commands/*.ts", "src/commands/update.ts"],
          ["src/commands/*.ts", "src/commands/channel/spawn.ts"],
          ["src/*", "src/app.ts"],
          ["src/*", "src/nested/app.ts"],
        ]),
      ).toEqual(["1", "0", "1", "0"]);
    });

    it("** as a whole segment crosses segments, but only strictly under the prefix", () => {
      expect(
        globMatches(tmp, [
          ["packages/**", "packages/cli/src/index.ts"],
          ["packages/**", "packages/index.ts"],
          // gitignore-like: `a/**` does not match `a` itself
          ["packages/**", "packages"],
        ]),
      ).toEqual(["1", "1", "0"]);
    });

    it("** in the middle spans zero or more segments", () => {
      expect(
        globMatches(tmp, [
          ["packages/**/index.ts", "packages/index.ts"],
          ["packages/**/index.ts", "packages/cli/src/index.ts"],
          ["packages/**/index.ts", "packages/cli/src/other.ts"],
        ]),
      ).toEqual(["1", "1", "0"]);
    });

    it("? matches exactly one character within a segment", () => {
      expect(
        globMatches(tmp, [
          ["src/util?.py", "src/utils.py"],
          ["src/util?.py", "src/util.py"],
          ["src/util?.py", "src/utilXY.py"],
          ["a?b", "a/b"],
        ]),
      ).toEqual(["1", "0", "0", "0"]);
    });

    it("trailing / is sugar for /** (matches strictly under the directory)", () => {
      expect(
        globMatches(tmp, [
          ["packages/cli/", "packages/cli/src/index.ts"],
          ["packages/cli/", "packages/cli"],
        ]),
      ).toEqual(["1", "0"]);
    });

    it("** embedded in a segment with other characters degrades to *", () => {
      expect(
        globMatches(tmp, [
          ["src/foo**.ts", "src/foobar.ts"],
          ["src/foo**.ts", "src/foo/bar.ts"],
        ]),
      ).toEqual(["1", "0"]);
    });

    it("literal characters are escaped (dot is not a wildcard)", () => {
      expect(
        globMatches(tmp, [
          ["src/app.ts", "src/app.ts"],
          ["src/app.ts", "src/appxts"],
        ]),
      ).toEqual(["1", "0"]);
    });

    // R6: validation is a deny-list, not a charset whitelist — real repos carry
    // @scope packages, [slug]/(group) route dirs and non-ASCII directories.
    it("accepts real-world path shapes (@scope, [slug], (marketing), non-ASCII dirs)", () => {
      const globs = [
        "packages/@scope/**",
        "app/[slug]/page.tsx",
        "app/(marketing)/**",
        "文档/**",
        "src/{a,b}.ts",
      ];
      const valid = runSpecProbe(
        tmp,
        `
for g in ${JSON.stringify(globs)}:
    print("ok" if validate_glob(g) is None else validate_glob(g))
`,
      );
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout.trim().split("\n")).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);

      // …and they translate to regexes that match the literal path (the
      // special characters are escaped, not interpreted as regex syntax).
      expect(
        globMatches(tmp, [
          ["packages/@scope/**", "packages/@scope/ui/src/index.ts"],
          ["packages/@scope/**", "packages/other/ui/src/index.ts"],
          ["app/[slug]/page.tsx", "app/[slug]/page.tsx"],
          ["app/[slug]/page.tsx", "app/s/page.tsx"],
          ["app/(marketing)/**", "app/(marketing)/about/page.tsx"],
          ["app/(marketing)/**", "app/marketing/about/page.tsx"],
          ["文档/**", "文档/readme.md"],
          ["文档/**", "docs/readme.md"],
          ["src/{a,b}.ts", "src/{a,b}.ts"],
        ]),
      ).toEqual(["1", "0", "1", "0", "1", "0", "1", "0", "1"]);
    });

    it("still rejects absolute paths, .. segments, backslashes and empty globs", () => {
      const r = runSpecProbe(
        tmp,
        `
for g in ["/abs/path.ts", "a/../b.ts", "src\\\\win.ts", "", "src/app.ts"]:
    print("ok" if validate_glob(g) is None else "err")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "err",
        "err",
        "err",
        "err",
        "ok",
      ]);
    });
  });

  describe("common/spec_match.py: frontmatter tolerance (R6)", () => {
    it("a `description: >` block scalar does not disqualify the spec", () => {
      writeSpec(
        tmp,
        "skillish.md",
        [
          "---",
          "name: skillish",
          "description: >",
          "  A long paragraph describing what this spec is for,",
          "  written the way SKILL.md files do it.",
          "paths:",
          "  - src/**",
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      // The block scalar is consumed, the `paths:` key after it still parses.
      expect(r.stdout.trim()).toBe(".trellis/spec/skillish.md|None");
      expect(r.stderr).toBe("");
    });

    it("ignores unknown keys, unrecognized line shapes and stray list items", () => {
      writeSpec(
        tmp,
        "noisy.md",
        [
          "---",
          "title: not a key this parser knows",
          "- a stray list item outside any key",
          "prose without a colon at all",
          "paths:",
          "  - src/**",
          "allowed-tools: Read, Edit",
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/noisy.md|None");
      expect(r.stderr).toBe("");
    });

    // F4: a frontmatter block that never closes cannot be distinguished from
    // one whose closing marker sits past the head bound, so both warn + skip.
    // Routing on a half-read `paths:` list is worse than skipping loudly.
    it("F4: an unclosed frontmatter block warns and skips the file; siblings match", () => {
      writeSpec(
        tmp,
        "unclosed.md",
        "---\npaths:\n  - src/**\n\nSome body prose here.\n",
      );
      writeSpec(tmp, "good.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/good.md|None");
      expect(r.stderr).toContain(
        "malformed frontmatter in .trellis/spec/unclosed.md",
      );
      expect(r.stderr).toContain("never closed within the head bound");
    });

    it("F4: the closing marker must land inside the 16 KiB / 200-line head bound", () => {
      // 250 declared globs push the closing `---` past HEAD_MAX_LINES; a
      // 150-glob sibling closes inside the bound and still parses whole.
      const runaway = Array.from({ length: 250 }, (_, i) => `  - src/g${i}/**`);
      const within = Array.from({ length: 150 }, (_, i) => `  - src/g${i}/**`);
      writeSpec(
        tmp,
        "runaway.md",
        ["---", "paths:", ...runaway, "---", "Body", ""].join("\n"),
      );
      writeSpec(
        tmp,
        "within.md",
        ["---", "paths:", ...within, "---", "Body", ""].join("\n"),
      );

      const r = runMatch(tmp, "src/g149/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/within.md|None");
      expect(r.stderr).toContain(
        "malformed frontmatter in .trellis/spec/runaway.md",
      );
      expect(r.stderr).toContain("never closed within the head bound");
    });

    it("F4: an opening `---` with no recognized key is a horizontal rule, not frontmatter", () => {
      // Prose files that open with an `---` rule are not malformed, so they
      // must stay silent — including the unterminated variant, which the
      // no-recognized-key rule decides before the never-closed rule.
      writeSpec(
        tmp,
        "prose.md",
        [
          "---",
          "",
          "A prose file that opens with a Markdown horizontal rule.",
          "Note: this line even looks like a key, but is not a recognized one.",
          "",
          "---",
          "",
          "More prose.",
          "",
        ].join("\n"),
      );
      writeSpec(
        tmp,
        "prose-unterminated.md",
        "---\nJust prose under a rule, never closed, no recognized key.\n",
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toBe("");
    });

    it("F4: a `paths:` flow sequence parses like a block list", () => {
      writeSpec(
        tmp,
        "flow.md",
        '---\ndescription: flow spec\npaths: [src/app.ts, "src/commands/**"]\n---\nBody\n',
      );

      const first = runMatch(tmp, "src/app.ts");
      expect(first.status).toBe(0);
      expect(first.stdout.trim()).toBe(".trellis/spec/flow.md|flow spec");
      expect(first.stderr).toBe("");

      const second = runMatch(tmp, "src/commands/update.ts");
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe(".trellis/spec/flow.md|flow spec");
    });

    // §12-required parsing cases (F13).
    it("F13 (§12): a UTF-8 BOM before the opening `---` is tolerated", () => {
      writeSpec(
        tmp,
        "bom.md",
        "\uFEFF---\ndescription: bom spec\npaths:\n  - src/**\n---\nBody\n",
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/bom.md|bom spec");
      expect(r.stderr).toBe("");
    });

    it("F13 (§12): quotes and inline comments are stripped from values and globs", () => {
      writeSpec(
        tmp,
        "quoted.md",
        [
          "---",
          'name: "quoted-name"   # the name key',
          "description: 'single quoted description'  # trailing comment",
          "paths:",
          '  - "src/**"   # only the glob survives',
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(
        ".trellis/spec/quoted.md|single quoted description",
      );
      expect(r.stderr).toBe("");
    });

    it("F13 (§12): a block-scalar `paths:` is malformed too (warn + skip)", () => {
      writeSpec(tmp, "blockscalar.md", "---\npaths: >\n  src/**\n---\nBody\n");
      writeSpec(tmp, "good.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/good.md|None");
      expect(r.stderr).toContain(
        "malformed frontmatter in .trellis/spec/blockscalar.md",
      );
      expect(r.stderr).toContain("'paths' must be a list of globs");
    });

    it("still treats an inline-scalar `paths:` as malformed (warn + skip); siblings match", () => {
      writeSpec(tmp, "bad.md", "---\npaths: src/**\n---\nBody\n");
      writeSpec(tmp, "good.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/good.md|None");
      expect(r.stderr).toContain(
        "malformed frontmatter in .trellis/spec/bad.md",
      );
    });
  });

  describe("common/spec_match.py: match_specs_for_file", () => {
    it("ranks exact and narrower globs before broad globs; rel_path breaks ties", () => {
      writeSpec(tmp, "aa-broad.md", "---\npaths:\n  - src/**\n---\nBody\n");
      writeSpec(tmp, "guides/style.md", "# Plain spec without frontmatter\n");
      writeSpec(
        tmp,
        "mm-narrow.md",
        "---\ndescription: command conventions\npaths:\n  - src/commands/*.ts\n---\nBody\n",
      );
      writeSpec(
        tmp,
        "zz-exact.md",
        "---\npaths:\n  - src/commands/update.ts\n---\nBody\n",
      );

      const r = runMatch(tmp, "src/commands/update.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        ".trellis/spec/zz-exact.md|None",
        ".trellis/spec/mm-narrow.md|command conventions",
        ".trellis/spec/aa-broad.md|None",
      ]);

      const miss = runMatch(tmp, "docs/readme.md");
      expect(miss.status).toBe(0);
      expect(miss.stdout.trim()).toBe("");
    });

    it("skips an invalid glob with a stderr warning; the file's remaining globs still apply", () => {
      writeSpec(
        tmp,
        "mixed.md",
        "---\npaths:\n  - /absolute/path.ts\n  - src/**\n---\nBody\n",
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/mixed.md|None");
      expect(r.stderr).toContain("invalid glob");
      expect(r.stderr).toContain("/absolute/path.ts");
    });
  });

  // ===========================================================================
  // F3: one normalization — `normalize_repo_relative` is the canonical path
  // used both for matching and for display
  // ===========================================================================

  describe("common/spec_match.py: canonical normalization (F3)", () => {
    /** rel_path list + the canonical rel for (root, file), one per line. */
    function probeNormalization(pairs: [string, string][]): {
      status: number | null;
      stdout: string;
      stderr: string;
    } {
      return runSpecProbe(
        tmp,
        `
from common.spec_match import normalize_repo_relative
for root, f in ${JSON.stringify(pairs)}:
    matched = match_specs_for_file(Path(root), f)
    print(",".join(m.rel_path for m in matched) or "none")
    print(normalize_repo_relative(Path(root), f))
`,
      );
    }

    it("kills symlink divergence on both sides (/var vs /private/var on macOS)", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\npaths:\n  - src/commands/**\n---\nBody\n",
      );
      // The OS hands the hook whichever form the caller had: the raw temp path
      // (a symlink on macOS) or its realpath. Root and file are resolved on
      // both sides, so the four combinations collapse to one rel string.
      const real = fs.realpathSync(tmp);
      const rawFile = path.join(tmp, "src/commands/update.ts");
      const realFile = path.join(real, "src/commands/update.ts");

      const r = probeNormalization([
        [tmp, realFile],
        [real, rawFile],
        [tmp, rawFile],
        [real, realFile],
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        ".trellis/spec/cli/commands.md",
        "src/commands/update.ts",
        ".trellis/spec/cli/commands.md",
        "src/commands/update.ts",
        ".trellis/spec/cli/commands.md",
        "src/commands/update.ts",
        ".trellis/spec/cli/commands.md",
        "src/commands/update.ts",
      ]);
    });

    it.skipIf(process.platform !== "darwin")(
      "matches a case-variant path on case-insensitive filesystems (darwin)",
      () => {
        // APFS/HFS+ hand out whatever case the caller typed; the glob author
        // wrote one case. Over-injecting is the safe side of the asymmetry.
        writeSpec(
          tmp,
          "cli/commands.md",
          "---\npaths:\n  - src/commands/**\n---\nBody\n",
        );

        const r = runMatch(tmp, "SRC/Commands/Update.ts");
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(".trellis/spec/cli/commands.md|None");
      },
    );

    it("NFC-normalizes the path so an NFD filename matches an NFC glob", () => {
      // macOS hands out decomposed (NFD) filenames while the spec author types
      // the composed (NFC) form — without normalization they are two strings.
      const nfcGlob = "docs/caf\u00E9/**"; // composed
      const nfdFile = "docs/cafe\u0301/notes.ts"; // decomposed
      expect(nfdFile.normalize("NFC")).not.toBe(nfdFile);
      writeSpec(tmp, "docs.md", `---\npaths:\n  - ${nfcGlob}\n---\nBody\n`);

      const r = runMatch(tmp, nfdFile);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/docs.md|None");
    });
  });

  // ===========================================================================
  // R7: pure decision logic, imported directly from common/spec_inject.py
  // ===========================================================================

  describe("common/spec_inject.py: pure decision logic (R7)", () => {
    it("decide() follows the order: stateless → first → sha → reset → window", () => {
      const r = runInjectProbe(
        tmp,
        `
CLOCK = {"reset": "r2", "ts": 1000.0}
SAME = "a" * 64
OTHER = "b" * 64

def last(**kw):
    base = {"v": 2, "spec": "s.md", "sha256": SAME, "mode": "full",
            "ts": 1000.0, "reset": "r2"}
    base.update(kw)
    return base

rows = [
    # stateless wins over everything, even a matching record
    ("stateless-no-record", decide(True, None, SAME, CLOCK, 2700)),
    ("stateless-with-record", decide(True, last(), SAME, CLOCK, 2700)),
    # first sight of this spec in this identity
    ("first-sight", decide(False, None, SAME, CLOCK, 2700)),
    # content changed → re-teach, even deep inside the window
    ("sha-change", decide(False, last(sha256=OTHER), SAME, CLOCK, 2700)),
    # SessionStart(clear/compact) wrote a new reset marker → re-teach
    ("reset-change", decide(False, last(reset="r1"), SAME, CLOCK, 2700)),
    # Legacy v2 emissions have no reset field and are stale after the first reset
    ("legacy-after-reset", decide(False, last(reset=None), SAME, CLOCK, 2700)),
    # Same reset marker and inside the wall-clock window → stay silent
    ("reset-equal", decide(False, last(), SAME, CLOCK, 2700)),
    ("within-window", decide(False, last(ts=900.0), SAME, CLOCK, 2700)),
    # Past the wall-clock window → cheap refresh
    ("past-window", decide(False, last(ts=0.0), SAME, CLOCK, 5)),
    # sha change beats reset and window checks
    ("sha-change-past-window", decide(False, last(ts=0.0, sha256=OTHER), SAME, CLOCK, 5)),
]
for name, value in rows:
    print(f"{name}={value}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "stateless-no-record=ticket",
        "stateless-with-record=ticket",
        "first-sight=full",
        "sha-change=full",
        "reset-change=full",
        "legacy-after-reset=full",
        "reset-equal=silent",
        "within-window=silent",
        "past-window=ticket",
        "sha-change-past-window=full",
      ]);
    });

    it("within_window uses wall-clock seconds; 0 means infinite", () => {
      const r = runInjectProbe(
        tmp,
        `
rows = [
    ("inside", within_window({"ts": 100.0}, {"ts": 1.0}, 2700)),
    ("at-edge", within_window({"ts": 2701.0}, {"ts": 1.0}, 2700)),
    ("past", within_window({"ts": 5000.0}, {"ts": 1.0}, 2700)),
    ("negative", within_window({"ts": 10.0}, {"ts": 5000.0}, 2700)),
    ("window-zero", within_window({"ts": 9e9}, {"ts": 1.0}, 0)),
    ("missing", within_window({"ts": None}, {"ts": None}, 2700)),
]
for name, value in rows:
    print(f"{name}={int(value)}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "inside=1",
        "at-edge=0",
        "past=0",
        "negative=0",
        "window-zero=1",
        "missing=0",
      ]);
    });

    it("truncate_chars slices code points, never bytes; 0 or an oversized cap is a no-op", () => {
      const r = runInjectProbe(
        tmp,
        `
cjk = "宇" * 50
print("exact=%d" % len(truncate_chars(cjk, 10)))
print("bytes=%d" % len(truncate_chars(cjk, 10).encode("utf-8")))
print("replacement=%d" % truncate_chars(cjk, 10).count("\\ufffd"))
print("unlimited=%d" % len(truncate_chars(cjk, 0)))
print("negative=%d" % len(truncate_chars(cjk, -5)))
print("bigger-cap=%d" % len(truncate_chars(cjk, 500)))
print("at-len=%d" % len(truncate_chars(cjk, 50)))
print("notice=%s" % truncation_notice("a/b.md", 10).strip())
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "exact=10",
        // 10 code points of CJK = 30 bytes: a byte cap would have cut at 10.
        "bytes=30",
        "replacement=0",
        "unlimited=50",
        "negative=50",
        "bigger-cap=50",
        "at-len=50",
        "notice=[Trellis: truncated at 10 characters — read a/b.md for the full content]",
      ]);
    });

    it("assemble_payload never exceeds max_total_chars, at any budget (hard ceiling)", () => {
      const r = runInjectProbe(
        tmp,
        `
specs = []
spec_dir = REPO_ROOT / ".trellis" / "spec"
spec_dir.mkdir(parents=True, exist_ok=True)
for i in range(6):
    rel = f".trellis/spec/s{i}.md"
    p = REPO_ROOT / rel
    p.write_text(
        f"---\\ndescription: spec number {i}\\npaths:\\n  - src/app.ts\\n---\\n" + "Z" * 400,
        encoding="utf-8",
    )
    specs.append(Cand(p, rel, f"spec number {i}"))

CLOCK = {"reset": None, "ts": 1.0}
for budget in (0, 50, 120, 200, 300, 500, 800, 1200, 2000, 5000):
    for stateless in (False, True):
        payload, records = assemble_payload(
            "src/app.ts", specs, stateless, {}, CLOCK, 0, budget, 2700
        )
        over = budget > 0 and len(payload) > budget
        print(f"{budget}/{int(stateless)}={'OVER:' + str(len(payload)) if over else 'ok'}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.length).toBe(20);
      expect(lines.filter((l) => l.includes("OVER"))).toEqual([]);
    });

    it("make_record emits the v2 schema with the active reset marker", () => {
      const r = runInjectProbe(
        tmp,
        `
rec = make_record(".trellis/spec/a.md", "f" * 64, "full", {"reset": "r-1", "ts": 12.5})
print(",".join(sorted(rec.keys())))
print(f"v={rec['v']} version={STATE_VERSION} reset={rec['reset']}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "mode,reset,sha256,spec,ts,v",
        "v=2 version=2 reset=r-1",
      ]);
    });
  });

  // ===========================================================================
  // Hook E2E
  // ===========================================================================

  describe("inject-spec-context.py: hook E2E (v2 ticket-refresh)", () => {
    const SPEC_REL = ".trellis/spec/cli/commands.md";
    const EDITED = "src/commands/update.ts";
    const STATEFUL_TICKET_BODY = [
      "You were shown this spec earlier in this session and its content is unchanged.",
      "It still governs edits to matching files. If you no longer remember it, Read",
      `${SPEC_REL} before continuing.`,
    ].join("\n");
    const STATELESS_TICKET_BODY = [
      "This spec governs the file you just touched. If you have not read it in",
      `this session, Read ${SPEC_REL} before continuing.`,
    ].join("\n");

    function writeGoverningSpec(body = "Command spec body.\n"): string {
      return writeSpec(
        tmp,
        "cli/commands.md",
        `---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\n${body}`,
      );
    }

    it("emits a full <spec-context sha256> block on the first touch", () => {
      writeGoverningSpec();

      const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
      expect(r.status).toBe(0);
      const ctx = additionalContext(r.stdout);
      expect(ctx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(requireSha(ctx)).toMatch(/^[0-9a-f]{12}$/);
      expect(ctx).toContain("Command spec body.");
      expect(ctx).toContain("</spec-context>");
    });

    it("goes silent on a second touch of the same session within the refresh window", () => {
      writeGoverningSpec();
      const payload = buildPayload(tmp, { filePath: EDITED });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain("<spec-context");

      // No transcript → wall-clock window (default 2700s); a second touch this
      // soon is well inside it → nothing emitted.
      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe("");

      const shard = soleShard(tmp);
      const record = readShardRecords(shard)[0];
      fs.writeFileSync(
        shard,
        JSON.stringify({ ...record, ts: 0 }) + "\n",
        "utf-8",
      );
      const refresh = runHook(tmp, payload);
      const refreshContext = additionalContext(refresh.stdout);
      expect(refreshContext).toContain("<spec-ticket");
      expect(refreshContext).toContain(STATEFUL_TICKET_BODY);

      // State landed under TRELLIS_SPEC_STATE_DIR, not in the repo's .runtime.
      expect(listJsonl(stateBase(tmp)).length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(tmp, ".trellis", ".runtime"))).toBe(false);
    });

    it("re-teaches the full spec after SessionStart(source=compact)", () => {
      writeGoverningSpec();
      const payload = buildPayload(tmp, { filePath: EDITED });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain("<spec-context");

      const compact = runHook(
        tmp,
        JSON.stringify({
          hook_event_name: "SessionStart",
          source: "compact",
          cwd: tmp,
          session_id: "sess-1",
        }),
      );
      expect(compact.status).toBe(0);
      expect(compact.stdout.trim()).toBe("");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      expect(additionalContext(second.stdout)).toContain("<spec-context");

      const third = runHook(tmp, payload);
      expect(third.status).toBe(0);
      expect(third.stdout.trim()).toBe("");
    });

    it("does not read transcript contents to measure the refresh window", () => {
      writeGoverningSpec();
      const transcript = path.join(tmp, "internal.jsonl");
      fs.writeFileSync(transcript, "opaque internal data\n", "utf-8");
      const payload = buildPayload(tmp, {
        filePath: EDITED,
        transcriptPath: transcript,
      });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain("<spec-context");

      fs.appendFileSync(transcript, "changed\n".repeat(100), "utf-8");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe("");
    });

    it("re-teaches the full spec when its content changes (sha change beats the window)", () => {
      writeGoverningSpec("Original body.\n");
      const payload = buildPayload(tmp, { filePath: EDITED });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      const firstCtx = additionalContext(first.stdout);
      const firstSha = requireSha(firstCtx);
      expect(firstCtx).toContain("Original body.");

      // Rewrite the spec (new sha). Without the change, a second touch this soon
      // would be silent (within window) — a FULL emission proves sha wins.
      writeGoverningSpec("Rewritten body.\n");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      const secondCtx = additionalContext(second.stdout);
      expect(secondCtx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(secondCtx).toContain("Rewritten body.");
      expect(requireSha(secondCtx)).not.toBe(firstSha);
    });

    it("emits ticket-only with no-prior-exposure wording when the payload has no identity (R6)", () => {
      writeGoverningSpec();
      // No session_id/conversation_id/sessionID and no transcript_path → stateless.
      const payload = buildPayload(tmp, { filePath: EDITED, session: null });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      const ctx1 = additionalContext(first.stdout);
      expect(ctx1).toContain(
        `<spec-ticket file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(ctx1).toContain(STATELESS_TICKET_BODY);
      // Never claim prior exposure when there is no state to back the claim.
      expect(ctx1).not.toContain("shown this spec earlier");
      expect(ctx1).not.toContain("Command spec body.");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      const ctx2 = additionalContext(second.stdout);
      expect(ctx2).toContain("<spec-ticket");
      expect(ctx2).toContain(STATELESS_TICKET_BODY);

      // Stateless tier does no state IO: no shards written.
      expect(listJsonl(stateBase(tmp))).toEqual([]);
    });

    it("honors TRELLIS_CONTEXT_ID as identity when the payload carries none (shared-resolver env tier)", () => {
      writeGoverningSpec();
      const payload = buildPayload(tmp, { filePath: EDITED, session: null });
      const env = { TRELLIS_CONTEXT_ID: "explicit-ctx" };

      // With an explicit context override the hook is NOT stateless: first
      // touch teaches in full and records state.
      const first = runHook(tmp, payload, env);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(listJsonl(stateBase(tmp)).length).toBe(1);

      // Second touch within the window: silent, like any stateful identity.
      const second = runHook(tmp, payload, env);
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe("");

      // Payload identity beats the env override: a session_id in the payload
      // resolves to a DIFFERENT identity, so its first touch is full again.
      const other = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, session: "payload-sess" }),
        env,
      );
      expect(other.status).toBe(0);
      expect(additionalContext(other.stdout)).toContain("<spec-context");
    });

    it("keeps agent_id state separate from the same session_id without it (both first touches are full)", () => {
      writeGoverningSpec();

      const parent = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, session: "shared-sess" }),
      );
      expect(parent.status).toBe(0);
      expect(additionalContext(parent.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );

      // Same session_id, now carrying agent_id → independent identity → still
      // first → full (parent and subagent must NOT share dedup state).
      const sub = runHook(
        tmp,
        buildPayload(tmp, {
          filePath: EDITED,
          session: "shared-sess",
          agentId: "sub-7",
        }),
      );
      expect(sub.status).toBe(0);
      expect(additionalContext(sub.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );

      // Two distinct identity shards were written.
      expect(listJsonl(stateBase(tmp)).length).toBe(2);
    });

    it("fires on a Read tool event exactly like Edit (touching a file counts)", () => {
      writeGoverningSpec();

      const r = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Read" }),
      );
      expect(r.status).toBe(0);
      const ctx = additionalContext(r.stdout);
      expect(ctx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(ctx).toContain("Command spec body.");
    });

    it("ignores tools outside Read/Edit/Write/MultiEdit (miss path is a fast exit)", () => {
      writeSpec(tmp, "cli/commands.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runHook(
        tmp,
        buildPayload(tmp, { filePath: "src/app.ts", toolName: "Bash" }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("spec_injection.tools narrows the trigger set: [Edit] silences Read (R6)", () => {
      writeGoverningSpec();
      writeConfig(tmp, ["spec_injection:", "  tools:", "    - Edit"]);

      const read = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Read" }),
      );
      expect(read.status).toBe(0);
      expect(read.stdout.trim()).toBe("");
      expect(listJsonl(stateBase(tmp))).toEqual([]);

      const edit = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Edit" }),
      );
      expect(edit.status).toBe(0);
      expect(additionalContext(edit.stdout)).toContain("<spec-context");
    });

    it("exits 0 with empty stdout when no spec matches the edited file", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\npaths:\n  - src/commands/**\n---\nBody\n",
      );

      const r = runHook(tmp, buildPayload(tmp, { filePath: "README.md" }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("spec_injection.enabled: false disables injection entirely", () => {
      writeSpec(tmp, "cli/commands.md", "---\npaths:\n  - src/**\n---\nBody\n");
      writeConfig(tmp, ["spec_injection:", "  enabled: false"]);

      const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("exits 0 with empty stdout on broken stdin", () => {
      const r = runHook(tmp, "not json{{");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    // -----------------------------------------------------------------------
    // R1: budgets are measured in CHARACTERS, on the assembled payload string
    // -----------------------------------------------------------------------

    describe("R1: character budgets", () => {
      it("injects a 9,353-character CJK spec whole (a byte budget would have cut it)", () => {
        // taosu's review example, to the character. Defaults apply
        // (max_spec_chars 9400 / max_total_chars 9500).
        const header = "---\npaths:\n  - src/app.ts\n---\n";
        const content = header + "宇".repeat(9353 - header.length);
        expect([...content].length).toBe(9353);
        // …and it is ~3x that in bytes, which is exactly what broke before.
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(27000);
        writeSpec(tmp, "cjk.md", content);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect(fullBlockBody(ctx)).toBe(content);
        expect(ctx).not.toContain("[Trellis: truncated at");
        expect(ctx).not.toContain("�");
        // The wrapper still leaves the payload inside the per-event ceiling.
        expect([...ctx].length).toBeLessThanOrEqual(9500);
      });

      it("truncates at exactly max_spec_chars code points and appends the notice", () => {
        const header = "---\npaths:\n  - src/app.ts\n---\n";
        const content = header + "宇".repeat(500);
        writeSpec(tmp, "big.md", content);
        writeConfig(tmp, ["spec_injection:", "  max_spec_chars: 100"]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        const notice =
          "\n[Trellis: truncated at 100 characters — read .trellis/spec/big.md for the full content]";
        const body = fullBlockBody(ctx);
        expect(body.endsWith(notice)).toBe(true);

        const kept = body.slice(0, body.length - notice.length);
        expect([...kept].length).toBe(100);
        expect(kept).toBe([...content].slice(0, 100).join(""));
        // Character slicing can never split a multi-byte sequence.
        expect(ctx).not.toContain("�");
      });

      it("degrades overflow matches to <spec-index> lines once max_total_chars is exhausted", () => {
        // Contract property, not incidental split: when the budget is so
        // tight that no usable body prefix fits (amendment 1), every match
        // degrades to a NAMED index line — nothing is silently dropped and
        // the ceiling still holds.
        writeSpec(
          tmp,
          "aa.md",
          "---\ndescription: first spec\npaths:\n  - src/app.ts\n---\n" +
            "A".repeat(2000) +
            "\n",
        );
        writeSpec(
          tmp,
          "bb.md",
          "---\ndescription: second spec\npaths:\n  - src/app.ts\n---\n" +
            "B".repeat(2000) +
            "\n",
        );
        writeConfig(tmp, [
          "spec_injection:",
          "  max_spec_chars: 0",
          // Too small for any wrapper+notice+body prefix — both specs must
          // fall through to named index lines (which do fit).
          "  max_total_chars: 300",
        ]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(300);
        expect(ctx).not.toContain("<spec-context");
        expect(ctx).toContain("<spec-index>");
        expect(ctx).toContain("- .trellis/spec/aa.md — first spec");
        expect(ctx).toContain("- .trellis/spec/bb.md — second spec");
        expect(ctx).toContain("</spec-index>");
      });

      it("holds the hard ceiling under pathological fan-out and collapses the rest into (+N more)", () => {
        // Many specs matching one file must not push additionalContext past the
        // configured ceiling — separators, the index block and the summary line
        // are all counted against it.
        for (let i = 0; i < 20; i++) {
          const id = String(i).padStart(2, "0");
          const description =
            "governing rule detail ".repeat(18).slice(0, 400) + id;
          writeSpec(
            tmp,
            `many-${id}.md`,
            `---\ndescription: ${description}\npaths:\n  - src/app.ts\n---\n` +
              "X".repeat(300) +
              "\n",
          );
        }
        writeConfig(tmp, [
          "spec_injection:",
          "  max_spec_chars: 0",
          "  max_total_chars: 2000",
        ]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        // EXACT ceiling on the emitted string, not an approximation.
        expect([...ctx].length).toBeLessThanOrEqual(2000);
        expect(ctx).toContain("<spec-index>");
        expect(ctx).toMatch(
          /- \(\+\d+ more governing specs? over budget — run python3 \.\/\.trellis\/scripts\/get_context\.py --mode spec --file src\/app\.ts to list them\)/,
        );
        expect(ctx).toContain("</spec-index>");
      });

      it("amendment 1: a long spec still injects a truncated BODY under the defaults, never index-only", () => {
        // Frozen 9400/9500 made truncation unreachable (body + notice +
        // wrapper > total): specs past ~9,240 chars fell straight to an index
        // line — the rejected index-only mode by another route. The derived
        // cap binary-searches the largest fitting prefix instead.
        writeSpec(
          tmp,
          "big.md",
          "---\ndescription: big spec\npaths:\n  - src/app.ts\n---\n" +
            "R".repeat(30000) +
            "\n",
        );

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(9500);
        expect(ctx).toContain('<spec-context file="src/app.ts"');
        expect(ctx).toContain("truncated at");
        expect(ctx.trim().startsWith("<spec-index>")).toBe(false);
        // The derived body is maximal: the payload sits within one truncation-
        // notice length of the ceiling, not thousands of chars below it.
        expect([...ctx].length).toBeGreaterThan(9000);
      });

      it("amendment 3 / F6: FULL packing reserves room so every pending spec is still named", () => {
        // Greedy derived-cap packing used to eat the whole budget: one
        // 3000-char FULL, nine specs silently gone. The reserve is now sized
        // from the specs' OWN index lines, so the ones that do not fit as
        // bodies are still named (the bare "(+N more)" summary is the
        // fallback for when those named lines blow the reserve cap).
        const specs = Array.from({ length: 10 }, (_, i) => `short-${i}.md`);
        for (const name of specs) {
          writeSpec(
            tmp,
            name,
            `---\ndescription: rules ${name}\npaths:\n  - src/app.ts\n---\n` +
              "Y".repeat(2000) +
              "\n",
          );
        }
        writeConfig(tmp, ["spec_injection:", "  max_total_chars: 3000"]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(3000);
        expect(ctx).toContain("<spec-context");
        // Not one spec is silently dropped: each is either taught in full or
        // named in the index.
        const accounted = specs.filter((name) =>
          ctx.includes(`.trellis/spec/${name}`),
        );
        expect(accounted).toEqual(specs);
        // Plural-agnostic: the summary wording carries a dynamic plural.
        expect(ctx).not.toMatch(/\(\+\d+ more governing spec/);
      });
    });

    describe("SessionStart reset lifecycle", () => {
      it("source=startup leaves existing exposure state intact", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(additionalContext(runHook(tmp, payload).stdout)).toContain(
          "<spec-context",
        );
        const startup = runHook(
          tmp,
          JSON.stringify({
            hook_event_name: "SessionStart",
            source: "startup",
            cwd: tmp,
            session_id: "sess-1",
          }),
        );
        expect(startup.status).toBe(0);
        expect(startup.stdout.trim()).toBe("");
        expect(runHook(tmp, payload).stdout.trim()).toBe("");
        expect(readShardRecords(soleShard(tmp)).every((r) => r.spec)).toBe(
          true,
        );
      });

      it("source=clear re-teaches the full spec on the next touch", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(additionalContext(runHook(tmp, payload).stdout)).toContain(
          "<spec-context",
        );
        const clear = runHook(
          tmp,
          JSON.stringify({
            hook_event_name: "SessionStart",
            source: "clear",
            cwd: tmp,
            session_id: "sess-1",
          }),
        );
        expect(clear.status).toBe(0);
        expect(clear.stdout.trim()).toBe("");

        const second = runHook(tmp, payload);
        expect(additionalContext(second.stdout)).toContain("<spec-context");
        expect(runHook(tmp, payload).stdout.trim()).toBe("");
      });
    });

    it("shares lifecycle resets across parent and subagent exposure histories", () => {
      writeGoverningSpec();
      const parentPayload = buildPayload(tmp, { filePath: EDITED });
      const subagentPayload = buildPayload(tmp, {
        filePath: EDITED,
        agentId: "sub7",
      });

      expect(additionalContext(runHook(tmp, parentPayload).stdout)).toContain(
        "<spec-context",
      );
      expect(additionalContext(runHook(tmp, subagentPayload).stdout)).toContain(
        "<spec-context",
      );

      const reset = runHook(
        tmp,
        JSON.stringify({
          hook_event_name: "SessionStart",
          source: "compact",
          cwd: tmp,
          session_id: "sess-1",
        }),
      );
      expect(reset.status).toBe(0);
      expect(reset.stdout.trim()).toBe("");

      expect(additionalContext(runHook(tmp, parentPayload).stdout)).toContain(
        "<spec-context",
      );
      expect(additionalContext(runHook(tmp, subagentPayload).stdout)).toContain(
        "<spec-context",
      );
      expect(runHook(tmp, parentPayload).stdout.trim()).toBe("");
      expect(runHook(tmp, subagentPayload).stdout.trim()).toBe("");

      const shards = listJsonl(stateBase(tmp));
      expect(shards.map((shard) => path.basename(shard)).sort()).toEqual([
        "session_sess-1+a-sub7.jsonl",
        "session_sess-1.jsonl",
      ]);
      const parentShard = shards.find(
        (shard) => path.basename(shard) === "session_sess-1.jsonl",
      );
      const subagentShard = shards.find(
        (shard) => path.basename(shard) === "session_sess-1+a-sub7.jsonl",
      );
      if (!parentShard || !subagentShard) {
        throw new Error("expected parent and subagent state shards");
      }
      const parent = readShardRecords(parentShard);
      const subagent = readShardRecords(subagentShard);
      const resetId = parent.find((record) => !record.spec)?.reset;
      expect(resetId).toMatch(/^[0-9a-f]{32}$/);
      expect(parent.filter((record) => record.spec).at(-1)?.reset).toBe(
        resetId,
      );
      expect(subagent.filter((record) => record.spec).at(-1)?.reset).toBe(
        resetId,
      );
    });

    // -----------------------------------------------------------------------
    // R4: one append-only JSONL file per identity, v2 records, no pid shards
    // -----------------------------------------------------------------------

    describe("R4: state file layout and schema", () => {
      it("writes <base>/<project16>/<identity>.jsonl — one file, no pid suffix", () => {
        writeGoverningSpec();

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        additionalContext(r.stdout);

        const shard = soleShard(tmp);
        // Identity comes from common.active_task.resolve_context_key
        // ("session_" + sanitized session_id) — and nothing else.
        expect(path.basename(shard)).toBe("session_sess-1.jsonl");
        expect(path.basename(path.dirname(shard))).toMatch(/^[0-9a-f]{16}$/);
        expect(path.dirname(path.dirname(shard))).toBe(stateBase(tmp));
      });

      it("records carry the v2 emission schema without transcript counters", () => {
        writeGoverningSpec();

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        additionalContext(r.stdout);

        const records = readShardRecords(soleShard(tmp));
        expect(records.length).toBe(1);
        const record = records[0];
        expect(Object.keys(record).sort()).toEqual([
          "mode",
          "sha256",
          "spec",
          "ts",
          "v",
        ]);
        expect(record.v).toBe(2);
        expect(record.spec).toBe(SPEC_REL);
        expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.mode).toBe("full");
        expect(typeof record.ts).toBe("number");
        expect(record).not.toHaveProperty("turns");
        expect(record).not.toHaveProperty("boundaries");
        expect(record).not.toHaveProperty("pid");
        expect(record).not.toHaveProperty("lines");
      });

      it("two sequential events share one file and append only for emissions", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(runHook(tmp, payload).status).toBe(0);
        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("");

        // One shard, one record: the silent hit records nothing (fixed window).
        expect(readShardRecords(soleShard(tmp)).length).toBe(1);
      });

      it("ignores foreign schema versions and re-injects (safe direction)", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(runHook(tmp, payload).status).toBe(0);
        const shard = soleShard(tmp);
        const record = readShardRecords(shard)[0];
        // Rewrite the shard as a v1 record for the same spec/sha.
        fs.writeFileSync(
          shard,
          JSON.stringify({ ...record, v: 1 }) + "\n",
          "utf-8",
        );

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(additionalContext(second.stdout)).toContain("<spec-context");
      });
    });

    // -----------------------------------------------------------------------
    // R5: fail-closed gaps — circuit breaker + scoped GC
    // -----------------------------------------------------------------------

    describe("R5: circuit breaker and GC scope", () => {
      it("an unwritable state dir degrades to ticket-only forever, never a FULL loop", () => {
        writeGoverningSpec();
        // A regular file where the state base's parent should be: every mkdir
        // under it fails with NotADirectoryError.
        const blocker = path.join(tmp, "blocker");
        fs.writeFileSync(blocker, "not a directory\n", "utf-8");
        const env = { TRELLIS_SPEC_STATE_DIR: path.join(blocker, "state") };
        const payload = buildPayload(tmp, { filePath: EDITED });

        for (let run = 0; run < 3; run++) {
          const r = runHook(tmp, payload, env);
          expect(r.status).toBe(0);
          const ctx = additionalContext(r.stdout);
          expect(ctx).toContain(`<spec-ticket file="${EDITED}"`);
          // Circuit-breaker tickets use the no-prior-exposure wording too.
          expect(ctx).toContain(STATELESS_TICKET_BODY);
          expect(ctx).not.toContain("<spec-context");
          expect(ctx).not.toContain("Command spec body.");
          expect(r.stderr).toContain("running stateless");
        }

        // Nothing was written anywhere, including the default base.
        expect(listJsonl(stateBase(tmp))).toEqual([]);
        expect(fs.statSync(blocker).isFile()).toBe(true);
      });

      it("GC prunes only conforming shards at the exact <base>/<project16>/ depth", () => {
        writeGoverningSpec();

        const base = stateBase(tmp);
        const projectDir = path.join(base, "0123456789abcdef");
        const nestedDir = path.join(projectDir, "nested");
        fs.mkdirSync(nestedDir, { recursive: true });

        const aged = new Date(Date.now() - 72 * 3600 * 1000);
        const write = (file: string): string => {
          fs.writeFileSync(file, '{"v":2,"spec":"x"}\n', "utf-8");
          fs.utimesSync(file, aged, aged);
          return file;
        };
        // Conforming: current layout, our own legacy pid shard, and a
        // subagent shard (identity carries the `+a-<agent_id>` suffix —
        // contract amendment 2 added `+` to the name class so these prune).
        const pruned = write(path.join(projectDir, "session_old.jsonl"));
        const prunedLegacy = write(
          path.join(projectDir, "session_old.111.jsonl"),
        );
        const prunedSubagent = write(
          path.join(projectDir, "session_old+a-abc123.jsonl"),
        );
        // Same depth, foreign name → never touched.
        const foreign = write(path.join(projectDir, "victim.data.jsonl"));
        // Conforming name at the WRONG depth (one too deep, and one too shallow).
        const tooDeep = write(path.join(nestedDir, "session_deep.jsonl"));
        const tooShallow = write(path.join(base, "session_top.jsonl"));

        // Age the GC marker past 1h so the pass actually fires this run.
        const lastGc = path.join(base, ".last-gc");
        fs.writeFileSync(lastGc, "", "utf-8");
        const hoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
        fs.utimesSync(lastGc, hoursAgo, hoursAgo);

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);

        expect(fs.existsSync(pruned)).toBe(false);
        expect(fs.existsSync(prunedLegacy)).toBe(false);
        expect(fs.existsSync(prunedSubagent)).toBe(false);
        expect(fs.existsSync(foreign)).toBe(true);
        expect(fs.existsSync(tooDeep)).toBe(true);
        expect(fs.existsSync(tooShallow)).toBe(true);
        expect(fs.existsSync(lastGc)).toBe(true);
      });

      it("leaves recent shards alone and skips the pass inside the 1h GC interval", () => {
        writeGoverningSpec();

        const base = stateBase(tmp);
        const projectDir = path.join(base, "fedcba9876543210");
        fs.mkdirSync(projectDir, { recursive: true });
        const agedShard = path.join(projectDir, "session_old.jsonl");
        fs.writeFileSync(agedShard, '{"v":2,"spec":"x"}\n', "utf-8");
        const aged = new Date(Date.now() - 72 * 3600 * 1000);
        fs.utimesSync(agedShard, aged, aged);

        // A FRESH marker means the hourly gate has not elapsed → no GC pass.
        fs.writeFileSync(path.join(base, ".last-gc"), "", "utf-8");

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        expect(fs.existsSync(agedShard)).toBe(true);
      });

      it("F7: a symlinked project dir cannot walk the GC out of its own base", () => {
        writeGoverningSpec();

        const base = stateBase(tmp);
        fs.mkdirSync(base, { recursive: true });
        // A directory OUTSIDE the state base holding a file whose name and age
        // both qualify for pruning — reachable only through a planted symlink
        // that wears a conforming <project16> name.
        const outside = path.join(tmp, "someone-elses-data");
        fs.mkdirSync(outside, { recursive: true });
        const victim = path.join(outside, "session_victim.jsonl");
        fs.writeFileSync(victim, '{"v":2,"spec":"x"}\n', "utf-8");
        const aged = new Date(Date.now() - 72 * 3600 * 1000);
        fs.utimesSync(victim, aged, aged);
        fs.symlinkSync(outside, path.join(base, "0123456789abcdef"), "dir");

        // A same-depth directory with a foreign name is skipped by the name
        // gate even though its shard would otherwise qualify.
        const foreignDir = path.join(base, "not-a-project-dir");
        fs.mkdirSync(foreignDir, { recursive: true });
        const foreignShard = path.join(foreignDir, "session_old.jsonl");
        fs.writeFileSync(foreignShard, '{"v":2,"spec":"x"}\n', "utf-8");
        fs.utimesSync(foreignShard, aged, aged);

        const lastGc = path.join(base, ".last-gc");
        fs.writeFileSync(lastGc, "", "utf-8");
        const hoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
        fs.utimesSync(lastGc, hoursAgo, hoursAgo);

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        expect(additionalContext(r.stdout)).toContain("<spec-context");

        expect(fs.existsSync(victim)).toBe(true);
        expect(fs.existsSync(foreignShard)).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // F2: identity sanitization is injective — a collision that MISSES an
    // injection is the unacceptable failure
    // -----------------------------------------------------------------------

    describe("F2: collision-free identity", () => {
      function shardNames(): string[] {
        return listJsonl(stateBase(tmp))
          .map((s) => path.basename(s))
          .sort();
      }

      it("session ids that differ only past the 80-char head get distinct shards", () => {
        writeGoverningSpec();
        const shared = "x".repeat(130);

        for (const session of [`${shared}-alpha`, `${shared}-beta`]) {
          const r = runHook(
            tmp,
            buildPayload(tmp, { filePath: EDITED, session }),
          );
          expect(r.status).toBe(0);
          // Each is a first sight for its own identity → full teach.
          expect(additionalContext(r.stdout)).toContain("<spec-context");
        }

        const names = shardNames();
        expect(names.length).toBe(2);
        // Readable 80-character head + "-" + 8 hex of sha256(raw key): the
        // suffix is what keeps the mapping injective past the head.
        for (const name of names) {
          expect(name).toMatch(/^session_x{72}-[0-9a-f]{8}\.jsonl$/);
        }
        expect(names[0]).not.toBe(names[1]);
      });

      it("session ids that sanitize to the same head ('a.b' vs 'a_b') get distinct shards", () => {
        writeGoverningSpec();

        for (const session of ["a.b", "a_b"]) {
          const r = runHook(
            tmp,
            buildPayload(tmp, { filePath: EDITED, session }),
          );
          expect(r.status).toBe(0);
          expect(additionalContext(r.stdout)).toContain("<spec-context");
        }

        // The resolver hands the hook "session_<id>"; "." is outside the
        // filename-safe class and is replaced, which arms the hash suffix.
        const digest = createHash("sha256")
          .update("session_a.b")
          .digest("hex")
          .slice(0, 8);
        expect(shardNames()).toEqual([
          `session_a-b-${digest}.jsonl`,
          "session_a_b.jsonl",
        ]);
      });
    });

    // -----------------------------------------------------------------------
    // F3: the canonical repo-relative path, end to end through the payload
    // -----------------------------------------------------------------------

    describe("F3: one normalization (hook payload)", () => {
      it("accepts a realpath-form file_path while cwd is the raw symlinked path", () => {
        writeGoverningSpec();
        // Claude Code reports whichever form the tool call carried; on macOS
        // the temp root is reached through /var → /private/var. Matching and
        // the displayed `file=` attr must agree either way.
        const realFile = path.join(fs.realpathSync(tmp), EDITED);
        const payload = JSON.stringify({
          hook_event_name: "PostToolUse",
          cwd: tmp,
          tool_name: "Edit",
          tool_input: { file_path: realFile },
          session_id: "sess-real",
        });

        const r = runHook(tmp, payload);
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect(ctx).toContain(
          `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
        );
        expect(ctx).toContain("Command spec body.");
      });

      it.skipIf(process.platform !== "darwin")(
        "matches a case-variant payload path on darwin",
        () => {
          writeGoverningSpec();
          const variant = "SRC/Commands/Update.ts";

          const r = runHook(tmp, buildPayload(tmp, { filePath: variant }));
          expect(r.status).toBe(0);
          const ctx = additionalContext(r.stdout);
          expect(ctx).toContain(
            `<spec-context file="${variant}" spec="${SPEC_REL}" sha256="`,
          );
        },
      );
    });

    // -----------------------------------------------------------------------
    // F5: config surface honesty
    // -----------------------------------------------------------------------

    describe("F5: config surface", () => {
      it("tools: [] disables every trigger (no output, no state)", () => {
        writeGoverningSpec();
        writeConfig(tmp, ["spec_injection:", "  tools: []"]);

        for (const toolName of ["Edit", "Read", "Write", "MultiEdit"]) {
          const r = runHook(
            tmp,
            buildPayload(tmp, { filePath: EDITED, toolName }),
          );
          expect(r.status).toBe(0);
          expect(r.stdout.trim()).toBe("");
        }
        expect(listJsonl(stateBase(tmp))).toEqual([]);
      });

      it("a flow-sequence tools list works, and an unknown name warns without breaking the known ones", () => {
        writeGoverningSpec();
        writeConfig(tmp, ["spec_injection:", "  tools: [Edit, Frobnicate]"]);

        const edit = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(edit.status).toBe(0);
        expect(additionalContext(edit.stdout)).toContain("<spec-context");
        expect(edit.stderr).toContain(
          "unknown spec_injection.tools entries ['Frobnicate']",
        );

        // Read is not in the list → still silent.
        const read = runHook(
          tmp,
          buildPayload(tmp, {
            filePath: EDITED,
            toolName: "Read",
            session: "s2",
          }),
        );
        expect(read.status).toBe(0);
        expect(read.stdout.trim()).toBe("");
      });

      it("max_spec_chars: 0 means unlimited — the whole body, and the whole remaining budget", () => {
        const header =
          "---\ndescription: big spec\npaths:\n  - src/app.ts\n---\n";
        const content = header + "R".repeat(30000) + "\n";
        writeSpec(tmp, "big.md", content);

        // No per-spec cap and no per-event cap → the body lands whole.
        writeConfig(tmp, [
          "spec_injection:",
          "  max_spec_chars: 0",
          "  max_total_chars: 0",
        ]);
        const unlimited = runHook(
          tmp,
          buildPayload(tmp, { filePath: "src/app.ts" }),
        );
        expect(unlimited.status).toBe(0);
        const unlimitedCtx = additionalContext(unlimited.stdout);
        expect(fullBlockBody(unlimitedCtx)).toBe(content);
        expect(unlimitedCtx).not.toContain("[Trellis: truncated at");

        // With a per-event ceiling still set, "unlimited" must derive a body
        // that FILLS that ceiling — the pre-F5 search ceiling of 1 collapsed
        // this to a ~180-character payload.
        writeConfig(tmp, ["spec_injection:", "  max_spec_chars: 0"]);
        const capped = runHook(
          tmp,
          buildPayload(tmp, { filePath: "src/app.ts", session: "s2" }),
        );
        expect(capped.status).toBe(0);
        const cappedCtx = additionalContext(capped.stdout);
        expect([...cappedCtx].length).toBe(9500);
        expect(cappedCtx).toContain("[Trellis: truncated at");
      });

      it("a spec over MAX_SPEC_SOURCE_BYTES degrades to an index line with a warn", () => {
        // 10 MiB+ of spec is never inlinable; reading and hashing it on every
        // tool event is the cost the bound exists to refuse.
        const header =
          "---\ndescription: huge spec\npaths:\n  - src/app.ts\n---\n";
        const abs = writeSpec(tmp, "huge.md", header);
        fs.appendFileSync(abs, Buffer.alloc(11 * 1024 * 1024, 0x48));
        expect(fs.statSync(abs).size).toBeGreaterThan(10 * 1024 * 1024);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        expect(additionalContext(r.stdout)).toBe(
          "<spec-index>\n- .trellis/spec/huge.md — huge spec\n</spec-index>",
        );
        expect(r.stderr).toMatch(
          /\.trellis\/spec\/huge\.md is \d+ bytes \(over 10485760\) — degraded to an index line/,
        );
        // Nothing was recorded: the spec stays eligible for a real teach.
        expect(readShardRecords(soleShard(tmp))).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // F6: named-index reserve + honest tickets
    // -----------------------------------------------------------------------

    describe("F6: budget honesty", () => {
      /** Realistic spec shapes: real repo-length rel paths and descriptions. */
      const REALISTIC: [string, string][] = [
        ["cli/backend/commands-workflow.md", "workflow command conventions"],
        ["cli/backend/script-conventions.md", "python script conventions"],
        ["cli/backend/spec-injection.md", "path-scoped spec injection"],
        ["cli/backend/error-handling.md", "hook error handling rules"],
        ["cli/backend/filesystem-safety.md", "filesystem safety rules"],
      ];

      it("names the specs it could not inline instead of collapsing to a bare count", () => {
        const edited = "packages/cli/src/commands/workflow.ts";
        for (const [rel, description] of REALISTIC) {
          writeSpec(
            tmp,
            rel,
            `---\ndescription: ${description}\npaths:\n  - ${edited}\n---\n` +
              "W".repeat(8000) +
              "\n",
          );
        }

        // Defaults (9400 / 9500) — no config at all.
        const r = runHook(tmp, buildPayload(tmp, { filePath: edited }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(9500);

        const taught = REALISTIC.filter(([rel]) =>
          ctx.includes(`spec=".trellis/spec/${rel}" sha256=`),
        );
        const named = REALISTIC.filter(([rel, description]) =>
          ctx.includes(`- .trellis/spec/${rel} — ${description}`),
        );
        // The split between taught and named is budget-derived (it moves with
        // the wrapper cost), so only the partition is pinned: every spec is
        // accounted for exactly once, and the overflow ones are NAMED — the
        // pre-F6 reserve degraded all of them to one anonymous count.
        expect([...taught, ...named].map(([rel]) => rel).sort()).toEqual(
          REALISTIC.map(([rel]) => rel).sort(),
        );
        expect(named.length).toBeGreaterThan(0);
        // Plural-agnostic: the summary wording carries a dynamic plural.
        expect(ctx).not.toMatch(/\(\+\d+ more governing spec/);
      });

      it("a truncated FULL is recorded incomplete and re-taught, never ticketed as if shown whole", () => {
        // "You were shown this spec earlier" must never be a lie: the agent
        // only ever saw a prefix of this spec.
        writeSpec(
          tmp,
          "cli/commands.md",
          "---\ndescription: big command spec\npaths:\n  - src/commands/**\n---\n" +
            "R".repeat(30000) +
            "\n",
        );
        writeConfig(tmp, ["spec_injection:", "  refresh_window_seconds: 1"]);
        const payload = buildPayload(tmp, { filePath: EDITED });

        const first = runHook(tmp, payload);
        expect(first.status).toBe(0);
        const firstCtx = additionalContext(first.stdout);
        expect(firstCtx).toContain("[Trellis: truncated at");
        const shard = soleShard(tmp);
        const record = readShardRecords(shard)[0];
        expect(record.mode).toBe("full");
        expect(record.complete).toBe(false);

        // Past the window: an unqualified ticket would claim prior exposure to
        // a body the agent never saw, so the spec is taught again instead.
        fs.writeFileSync(
          shard,
          JSON.stringify({ ...record, ts: 0 }) + "\n",
          "utf-8",
        );

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        const secondCtx = additionalContext(second.stdout);
        expect(secondCtx).toContain(`<spec-context file="${EDITED}"`);
        expect(secondCtx).not.toContain("<spec-ticket");
        expect(secondCtx).not.toContain("shown this spec earlier");
      });

      it("a body cut by max_spec_chars alone is recorded incomplete too", () => {
        writeSpec(
          tmp,
          "cli/commands.md",
          "---\ndescription: capped\npaths:\n  - src/commands/**\n---\n" +
            "R".repeat(3000) +
            "\n",
        );
        writeConfig(tmp, ["spec_injection:", "  max_spec_chars: 200"]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        expect(additionalContext(r.stdout)).toContain("[Trellis: truncated at");
        const record = readShardRecords(soleShard(tmp))[0] as StateRecord & {
          complete?: boolean;
        };
        expect(record.complete).toBe(false);
      });

      it("a whole body records no completeness flag (absent means complete)", () => {
        writeGoverningSpec();

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        expect(additionalContext(r.stdout)).not.toContain("truncated at");
        expect(Object.keys(readShardRecords(soleShard(tmp))[0])).not.toContain(
          "complete",
        );
      });
    });

    describe("F9: platform-neutral input", () => {
      it("accepts a camelCase toolInput payload (sibling-hook parity)", () => {
        writeGoverningSpec();
        const payload = JSON.stringify({
          hook_event_name: "PostToolUse",
          cwd: tmp,
          toolName: "Edit",
          toolInput: { file_path: EDITED },
          session_id: "camel-1",
        });

        const r = runHook(tmp, payload);
        expect(r.status).toBe(0);
        expect(additionalContext(r.stdout)).toContain(
          `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
        );
      });

      it("reconfigures stderr alongside stdin/stdout on Windows (six-hook parity)", () => {
        // Static assertion: the Windows branch cannot run on this platform,
        // but a warning printed through an un-reconfigured stderr raises
        // UnicodeEncodeError on a non-UTF-8 codepage.
        const source = fs.readFileSync(HOOK_PATH, "utf-8");
        expect(source).toContain(
          'for _stream_name in ("stdin", "stdout", "stderr"):',
        );
      });
    });

    describe("F10: state tie-break", () => {
      it("on an equal ts the LATER record wins (appends are ordered)", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(runHook(tmp, payload).status).toBe(0);
        const shard = soleShard(tmp);
        const record = readShardRecords(shard)[0];
        // Same ts, different sha: the later line is the newer truth, so the
        // spec must look CHANGED and be re-taught.
        const superseding = { ...record, sha256: "0".repeat(64) };
        fs.writeFileSync(
          shard,
          JSON.stringify(record) + "\n" + JSON.stringify(superseding) + "\n",
          "utf-8",
        );

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(additionalContext(second.stdout)).toContain(
          `<spec-context file="${EDITED}"`,
        );
      });
    });

    // -----------------------------------------------------------------------
    // F13: §12-required hook cases
    // -----------------------------------------------------------------------

    describe("F13 (§12): fast-exit paths", () => {
      it("a payload without file_path emits nothing", () => {
        writeGoverningSpec();
        const payload = JSON.stringify({
          hook_event_name: "PostToolUse",
          cwd: tmp,
          tool_name: "Edit",
          tool_input: { content: "no path here" },
          session_id: "sess-1",
        });

        const r = runHook(tmp, payload);
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe("");
        expect(listJsonl(stateBase(tmp))).toEqual([]);
      });

      it("a cwd with no .trellis anywhere above it emits nothing", () => {
        writeGoverningSpec();
        const outside = fs.mkdtempSync(
          path.join(os.tmpdir(), "trellis-no-root-"),
        );
        try {
          const payload = JSON.stringify({
            hook_event_name: "PostToolUse",
            cwd: outside,
            tool_name: "Edit",
            tool_input: { file_path: path.join(outside, EDITED) },
            session_id: "sess-1",
          });

          const r = runHook(tmp, payload);
          expect(r.status).toBe(0);
          expect(r.stdout.trim()).toBe("");
          expect(listJsonl(stateBase(tmp))).toEqual([]);
        } finally {
          fs.rmSync(outside, { recursive: true, force: true });
        }
      });
    });
  });

  describe("get_context.py --mode spec: pull mode", () => {
    it("lists matching specs as `<rel path> — <description>` lines", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\nBody\n",
      );
      writeSpec(tmp, "zz.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "src/commands/update.ts",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        ".trellis/spec/cli/commands.md — command conventions",
        ".trellis/spec/zz.md — (no description)",
      ]);
    });

    it("F13 (§12): dogfoods this repo's own frontmatter for commands/workflow.ts", () => {
      // Runs against the REPO itself (not a fixture): the mapping documented in
      // commands-workflow.md's own `paths:` must actually resolve through the
      // shipped scanner. If that spec's frontmatter is dropped or renamed, the
      // pull mode this test drives is the user-visible symptom.
      const repoRoot = path.resolve(__dirname, "../../../..");
      const r = spawnSync(
        "python3",
        [
          path.join(repoRoot, ".trellis", "scripts", "get_context.py"),
          "--mode",
          "spec",
          "--file",
          "packages/cli/src/commands/workflow.ts",
        ],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        ".trellis/spec/cli/backend/commands-workflow.md — ",
      );
    });

    it("prints the no-match sentence when nothing matches", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\npaths:\n  - src/commands/**\n---\nBody\n",
      );

      const r = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "src/nomatch.ts",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(
        "No spec files declare paths matching src/nomatch.ts.",
      );
    });

    it("returns structured JSON for matches and no matches", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\nBody\n",
      );
      writeSpec(tmp, "zz.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const matched = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "src/commands/update.ts",
        "--json",
      ]);
      expect(matched.status).toBe(0);
      expect(JSON.parse(matched.stdout)).toEqual({
        file: "src/commands/update.ts",
        matches: [
          {
            path: ".trellis/spec/cli/commands.md",
            description: "command conventions",
          },
          {
            path: ".trellis/spec/zz.md",
            description: null,
          },
        ],
      });

      const unmatched = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "outside.txt",
        "--json",
      ]);
      expect(unmatched.status).toBe(0);
      expect(JSON.parse(unmatched.stdout)).toEqual({
        file: "outside.txt",
        matches: [],
      });
    });
  });
});
