import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adopt } from "../../src/commands/adopt.js";
import { VERSION } from "../../src/constants/version.js";
import { computeHash } from "../../src/utils/template-hash.js";

describe("adopt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phronia-adopt-"));
    seedLegacyProject(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("moves the workflow root, regenerates pristinely-owned files, and preserves local edits", async () => {
    const backupRoot = path.join(tmpDir, "backups");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot,
    });

    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".phronia"))).toBe(true);
    expect(report.platforms).toContain("claude-code");

    // Pristine generated file was replaced by the current template path.
    expect(
      fs.existsSync(path.join(tmpDir, ".claude/commands/trellis/continue.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, ".claude/commands/phronia/continue.md")),
    ).toBe(true);

    // User edit survived as `.pre-adopt`.
    expect(
      fs.readFileSync(
        path.join(tmpDir, ".claude/hooks/session-start.py.pre-adopt"),
        "utf8",
      ),
    ).toBe("# user customization\n");
    expect(report.needsReview).toContain(".claude/hooks/session-start.py");

    // Manifest upgraded and backed up.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".phronia/.template-hashes.json"), "utf8"),
    ) as { __version: number; brand?: string };
    expect(manifest.__version).toBe(3);
    expect(manifest.brand).toBe("phronia");
    expect(report.backupDir?.startsWith(backupRoot)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".phronia/adopt-report.md"))).toBe(true);

    // User data is untouched.
    expect(
      fs.readFileSync(
        path.join(tmpDir, ".phronia/spec/backend/index.md"),
        "utf8",
      ),
    ).toBe("# User spec\n");
    expect(
      fs.readFileSync(path.join(tmpDir, ".phronia/tasks/01-01-user/task.json"), "utf8"),
    ).toContain("user task");
  });

  it("refreshes the workflow tree in the same run", async () => {
    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    // Legacy occurrences of `.trellis` inside generated scripts/workflow docs
    // are replaced, so a follow-up `update` is not required.
    expect(
      fs.readFileSync(path.join(tmpDir, ".phronia/scripts/common/paths.py"), "utf8"),
    ).toContain("layout.json");
    expect(
      fs.readFileSync(path.join(tmpDir, ".phronia/scripts/common/paths.py"), "utf8"),
    ).not.toContain('".trellis"');
    const workflow = fs.readFileSync(path.join(tmpDir, ".phronia/workflow.md"), "utf8");
    expect(workflow).toContain("Phronia");
    expect(workflow).not.toContain(".trellis/");
    expect(fs.readFileSync(path.join(tmpDir, ".phronia/.version"), "utf8")).toBe(
      `${VERSION}\n`,
    );

    // Locally edited config/workflow files survive beside the fresh template.
    expect(
      fs.readFileSync(path.join(tmpDir, ".phronia/config.yaml.pre-adopt"), "utf8"),
    ).toBe("session_auto_commit: false\n");
    expect(
      fs.readFileSync(path.join(tmpDir, ".phronia/workflow.md.pre-adopt"), "utf8"),
    ).toBe("# Workflow\n");
    expect(report.needsReview).toContain(".phronia/config.yaml");
    expect(report.needsReview).toContain(".phronia/workflow.md");

    // AGENTS.md gains the managed block and .gitattributes is added.
    expect(fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf8")).toContain(
      "<!-- PHRONIA:START -->",
    );
    expect(fs.existsSync(path.join(tmpDir, ".gitattributes"))).toBe(true);
  });

  it("refuses ambiguous states", async () => {
    fs.mkdirSync(path.join(tmpDir, ".phronia"), { recursive: true });
    await expect(adopt({ cwd: tmpDir, force: true })).rejects.toThrow(
      /Both \.trellis\/ and \.phronia\//,
    );
  });

  it("dry-run changes nothing", async () => {
    const report = await adopt({ cwd: tmpDir, force: true, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".phronia"))).toBe(false);
  });

  it("adopts a Copilot project whose managed set includes a file", async () => {
    // Regression: `.github/copilot-instructions.md` is a managed *file*.
    // Walking it as a directory threw ENOTDIR and stranded the workflow root.
    seedManifestEntry(
      tmpDir,
      ".github/prompts/continue.prompt.md",
      "# old prompt\n",
    );

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    expect(report.platforms).toContain("copilot");
    expect(fs.existsSync(path.join(tmpDir, ".phronia/.version"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".github/copilot-instructions.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".github/skills/phronia-check/SKILL.md")),
    ).toBe(true);
  });

  it("adopts a Snow project whose managed set includes a file", async () => {
    seedManifestEntry(tmpDir, ".snow/skills/trellis-check/SKILL.md", "# old\n");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    expect(report.platforms).toContain("snow");
    expect(fs.existsSync(path.join(tmpDir, ".snow/SNOW.md"))).toBe(true);
  });

  it("does not infer a platform from the shared .agents/skills root", async () => {
    seedManifestEntry(tmpDir, ".agents/skills/trellis-check/SKILL.md", "# old\n");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    // Several platforms write `.agents/skills`; it cannot identify any of them.
    for (const shared of ["gemini", "pi", "kimi", "dsh", "codex"]) {
      expect(report.platforms).not.toContain(shared);
    }
    expect(report.platforms).toContain("claude-code");
  });

  it("prunes an empty legacy trellis-* directory instead of reporting it", async () => {
    seedManifestEntry(tmpDir, ".cursor/skills/trellis-check/SKILL.md", "# old\n");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    expect(fs.existsSync(path.join(tmpDir, ".cursor/skills/trellis-check"))).toBe(
      false,
    );
    expect(report.needsReview).not.toContain(".cursor/skills/trellis-check");
    expect(
      fs.existsSync(path.join(tmpDir, ".cursor/skills/phronia-check/SKILL.md")),
    ).toBe(true);
  });

  it("renames a legacy directory that still holds user content", async () => {
    seedManifestEntry(tmpDir, ".kiro/skills/trellis-seed/SKILL.md", "# seed\n");
    writeFile(tmpDir, ".kiro/skills/trellis-custom/notes.md", "# notes\n");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    expect(fs.existsSync(path.join(tmpDir, ".kiro/skills/trellis-custom"))).toBe(
      false,
    );
    expect(
      fs.readFileSync(
        path.join(tmpDir, ".kiro/skills/phronia-custom/notes.md"),
        "utf8",
      ),
    ).toBe("# notes\n");
    expect(report.regenerated).toContain(".kiro/skills/phronia-custom");
  });

  it("keeps and reports a legacy directory whose phronia-* target exists", async () => {
    seedManifestEntry(tmpDir, ".kiro/skills/trellis-seed/SKILL.md", "# seed\n");
    writeFile(tmpDir, ".kiro/skills/trellis-check/notes.md", "# notes\n");

    const report = await adopt({
      cwd: tmpDir,
      force: true,
      backupRoot: path.join(tmpDir, "backups"),
    });

    expect(
      fs.readFileSync(
        path.join(tmpDir, ".kiro/skills/trellis-check/notes.md"),
        "utf8",
      ),
    ).toBe("# notes\n");
    expect(report.needsReview).toContain(".kiro/skills/trellis-check");
  });

  it("predicts legacy retirement in dry-run without touching the tree", async () => {
    seedManifestEntry(tmpDir, ".cursor/skills/trellis-check/SKILL.md", "# old\n");

    const report = await adopt({ cwd: tmpDir, force: true, dryRun: true });

    expect(report.dropped).toContain(".cursor/skills/trellis-check");
    expect(
      fs.existsSync(path.join(tmpDir, ".cursor/skills/trellis-check/SKILL.md")),
    ).toBe(true);
  });

  it("restores the workflow root when adoption fails after the rename", async () => {
    // A file where the regenerated tree expects a directory makes
    // writeWorkflowFiles throw after `.trellis` was already renamed.
    writeFile(tmpDir, ".trellis/scripts", "not a directory\n");

    const backupRoot = path.join(tmpDir, "backups");
    let message = "";
    try {
      await adopt({ cwd: tmpDir, force: true, backupRoot });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("adopt failed after moving .trellis/ to .phronia/");
    expect(message).toContain("restored to .trellis/");
    expect(message).toContain(`Backup: ${path.join(backupRoot)}`);
    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".phronia"))).toBe(false);
  });
});

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** Seed a legacy file and record it as pristine in the legacy manifest. */
function seedManifestEntry(
  root: string,
  relativePath: string,
  content: string,
): void {
  writeFile(root, relativePath, content);
  const manifestPath = path.join(root, ".trellis/.template-hashes.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    __version: number;
    hashes: Record<string, string>;
  };
  manifest.hashes[relativePath] = computeHash(content);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function seedLegacyProject(root: string): void {
  const legacy = path.join(root, ".trellis");
  fs.mkdirSync(path.join(legacy, "spec/backend"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "tasks/01-01-user"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.yaml"), "session_auto_commit: false\n");
  fs.writeFileSync(path.join(legacy, "workflow.md"), "# Workflow\n");
  fs.writeFileSync(path.join(legacy, ".version"), "0.6.17");
  fs.writeFileSync(path.join(legacy, "spec/backend/index.md"), "# User spec\n");
  fs.writeFileSync(
    path.join(legacy, "tasks/01-01-user/task.json"),
    JSON.stringify({ id: "user", title: "user task" }),
  );

  const pristine = ".claude/commands/trellis/continue.md";
  const pristineFull = path.join(root, pristine);
  fs.mkdirSync(path.dirname(pristineFull), { recursive: true });
  fs.writeFileSync(pristineFull, "# old continue command\n");

  const modified = ".claude/hooks/session-start.py";
  const modifiedFull = path.join(root, modified);
  fs.mkdirSync(path.dirname(modifiedFull), { recursive: true });
  fs.writeFileSync(modifiedFull, "# user customization\n");

  fs.writeFileSync(
    path.join(legacy, ".template-hashes.json"),
    JSON.stringify(
      {
        __version: 2,
        hashes: {
          [pristine]: computeHash("# old continue command\n"),
          [modified]: computeHash("# original hook\n"),
        },
      },
      null,
      2,
    ),
  );
}
