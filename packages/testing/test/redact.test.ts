import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

describe("redact", () => {
  it("replaces the project root and home directory", () => {
    const result = redact(
      {
        cwd: "/repo/project/.phronia",
        transcript_path: "/home/alice/.claude/session.jsonl",
      },
      { projectRoot: "/repo/project", homeDir: "/home/alice" },
    );

    expect(result.value).toEqual({
      cwd: "<PROJECT_ROOT>/.phronia",
      transcript_path: "<HOME>/.claude/session.jsonl",
    });
    expect(result.replacements).toBeGreaterThanOrEqual(2);
  });

  it("maps identity values to stable aliases", () => {
    const first = redact(
      { session_id: "abc-123", nested: { sessionId: "abc-123" } },
      { projectRoot: "/repo", homeDir: "/home/alice" },
    );
    const second = redact(
      { session_id: "abc-123" },
      { projectRoot: "/repo", homeDir: "/home/alice" },
    );

    expect(first.value).toEqual({
      session_id: "id_fixture_5942d94f5248",
      nested: { sessionId: "id_fixture_5942d94f5248" },
    });
    expect(second.value).toEqual({ session_id: "id_fixture_5942d94f5248" });
  });

  it("replaces email addresses", () => {
    const result = redact(
      { note: "contact alice@example.com" },
      { projectRoot: "/repo", homeDir: "/home/alice" },
    );

    expect(result.value).toEqual({ note: "contact <EMAIL>" });
  });

  it("truncates strings longer than the limit", () => {
    const result = redact(
      { text: "x".repeat(30) },
      { projectRoot: "/repo", homeDir: "/home/alice", maxStringLength: 10 },
    );

    expect(result.value).toEqual({ text: `xxxxxxxxxx…<truncated 20>` });
  });

  it("aliases transcript paths that escape the project and home", () => {
    const result = redact(
      { transcript_path: "/mnt/elsewhere/session.jsonl" },
      { projectRoot: "/repo", homeDir: "/home/alice" },
    );

    expect(result.value).toEqual({ transcript_path: "id_fixture_3658ec1af860" });
  });

  it("does not mutate its input", () => {
    const input = { cwd: "/repo/project" };
    redact(input, { projectRoot: "/repo/project", homeDir: "/home/alice" });
    expect(input.cwd).toBe("/repo/project");
  });

  it("applies explicit replacements before built-in ones", () => {
    const result = redact(
      { branch: "phronia/task-1" },
      { replacements: [["phronia/task-1", "<BRANCH>"]] },
    );
    expect(result.value).toEqual({ branch: "<BRANCH>" });
  });
});
