import { describe, expect, it } from "vitest";
import {
  settingsTemplate,
  getAllAgents,
  getSettingsTemplate,
} from "../../src/templates/claude/index.js";

// =============================================================================
// settingsTemplate — module-level constant
// =============================================================================

describe("settingsTemplate", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(settingsTemplate)).not.toThrow();
  });

  it("is a non-empty string", () => {
    expect(settingsTemplate.length).toBeGreaterThan(0);
  });

  // v0.5.0-beta.8: pin CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 at the project
  // level so Bash tool cwd changes don't leak into subsequent hook invocations.
  // Without this, a user who runs `cd frontend/` via Bash tool leaves cwd stuck
  // in `frontend/`, and the next UserPromptSubmit hook (which resolves
  // `.claude/hooks/inject-workflow-state.py` relative to cwd) crashes with
  // ENOENT. We can't fix this via command-string rewriting because
  // $CLAUDE_PROJECT_DIR doesn't expand on Windows shells (see CC issue #6023).
  // The env-var approach is read by CC internally, identical on all platforms.
  it("sets CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 in env", () => {
    const settings = JSON.parse(settingsTemplate) as {
      env?: Record<string, string>;
    };
    expect(settings.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });
});

// =============================================================================
// settingsTemplate — SessionStart hook matchers
// =============================================================================

describe("settingsTemplate SessionStart matchers", () => {
  const settings = JSON.parse(settingsTemplate);
  const sessionStartEntries = settings.hooks.SessionStart as {
    matcher: string;
    hooks: { type: string; command: string; timeout: number }[];
  }[];

  it("includes startup, clear, and compact matchers", () => {
    const matchers = sessionStartEntries.map((e) => e.matcher);
    expect(matchers).toContain("startup");
    expect(matchers).toContain("clear");
    expect(matchers).toContain("compact");
  });

  it("runs the reset hook only after clear and compact", () => {
    const byMatcher = Object.fromEntries(
      sessionStartEntries.map((entry) => [entry.matcher, entry.hooks]),
    );
    expect(byMatcher.startup.map((hook) => hook.command)).toEqual([
      "{{PYTHON_CMD}} .claude/hooks/session-start.py",
    ]);
    for (const source of ["clear", "compact"]) {
      expect(byMatcher[source].map((hook) => hook.command)).toEqual([
        "{{PYTHON_CMD}} .claude/hooks/session-start.py",
        "{{PYTHON_CMD}} .claude/hooks/inject-spec-context.py",
      ]);
      expect(byMatcher[source][1].timeout).toBe(30);
    }
  });

  it("all SessionStart entries use {{PYTHON_CMD}} placeholder", () => {
    for (const entry of sessionStartEntries) {
      for (const hook of entry.hooks) {
        expect(hook.command).toContain("{{PYTHON_CMD}}");
      }
    }
  });
});

// =============================================================================
// settingsTemplate — PostToolUse spec-injection hook matchers
// =============================================================================

describe("settingsTemplate PostToolUse matchers", () => {
  const settings = JSON.parse(settingsTemplate);
  const postToolUseEntries = settings.hooks.PostToolUse as {
    matcher: string;
    hooks: { type: string; command: string; timeout: number }[];
  }[];

  // R6: ONE entry with a pipe-list matcher (Claude Code's documented
  // list-of-exact-strings semantics), not four separate matcher entries.
  it("is a single entry matching Read|Edit|Write|MultiEdit", () => {
    expect(postToolUseEntries).toHaveLength(1);
    expect(postToolUseEntries[0].matcher).toBe("Read|Edit|Write|MultiEdit");
  });

  it("all PostToolUse entries invoke inject-spec-context.py with timeout 15", () => {
    expect(postToolUseEntries.length).toBeGreaterThan(0);
    for (const entry of postToolUseEntries) {
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe("command");
      expect(entry.hooks[0].command).toContain("inject-spec-context.py");
      expect(entry.hooks[0].timeout).toBe(15);
    }
  });

  it("all PostToolUse entries use {{PYTHON_CMD}} placeholder", () => {
    for (const entry of postToolUseEntries) {
      expect(entry.hooks[0].command).toContain("{{PYTHON_CMD}}");
    }
  });
});

// Commands are now sourced from common/ templates and tested in platforms.test.ts

// =============================================================================
// getAllAgents — reads agent templates
// =============================================================================

describe("getAllAgents", () => {
  it("each agent has name and content", () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.content.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// getSettingsTemplate — returns settings as SettingsTemplate
// =============================================================================

describe("getSettingsTemplate", () => {
  it("returns correct shape with valid JSON", () => {
    const result = getSettingsTemplate();
    expect(result.targetPath).toBe("settings.json");
    expect(result.content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.content)).not.toThrow();
  });
});
