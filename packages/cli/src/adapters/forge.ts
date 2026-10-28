/**
 * ForgePort adapter (design.md §18.2, §6.4, §25.1).
 *
 * Detects the `origin` host and shells out to `gh` (GitHub) or `glab`
 * (GitLab) with `execFile*` only. It never calls a merge API: Phronia opens a
 * change request and lets the remote merge queue decide. When the CLI is
 * missing or a call fails, methods return `null` and the caller degrades to a
 * compare URL plus manual instructions.
 *
 * Availability probes are cached for the lifetime of the port (3s timeout).
 */

import {
  defaultCommandExec,
  type CommandExec,
  type CommandResult,
} from "./git.js";

export const FORGE_PROBE_TIMEOUT_MS = 3_000;
export const FORGE_CREATE_TIMEOUT_MS = 30_000;

export type ForgeKind = "github" | "gitlab" | "generic";

export interface OriginInfo {
  readonly kind: ForgeKind;
  readonly host: string;
  /** Everything before the repository name, e.g. `group/subgroup`. */
  readonly owner: string;
  readonly repo: string;
  /** `https://<host>`; null for unparseable hosts. */
  readonly webBase: string | null;
  readonly remoteUrl: string;
}

export interface ChangeRequestState {
  readonly url: string | null;
  /** Lowercase provider state: `open`, `merged`, `closed`, or `unknown`. */
  readonly state: string;
  readonly branch: string;
  readonly draft: boolean;
  readonly mergeState: string | null;
}

export interface CreateChangeRequestOptions {
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}

export interface CompareUrlOptions {
  readonly base: string;
  readonly head: string;
}

export interface ForgePort {
  readonly kind: ForgeKind;
  available(): boolean;
  createChangeRequest(
    options: CreateChangeRequestOptions,
  ): { url: string } | null;
  viewChangeRequest(branch: string): ChangeRequestState | null;
  compareUrl(options: CompareUrlOptions): string | null;
}

export interface ForgeOptions {
  readonly cwd: string;
  /**
   * Origin URL. Omit to read `git remote get-url origin`; pass `null` when the
   * caller already knows there is no origin.
   */
  readonly originUrl?: string | null;
  readonly exec?: CommandExec;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Parse a git remote URL into host/owner/repo.
 *
 * Supports scp-like (`git@github.com:owner/repo.git`), `ssh://`, `https://`,
 * `http://`, and `git://` forms. Returns null when no host/path can be found;
 * unknown hosts are still returned with `kind: "generic"`.
 */
export function parseOriginUrl(remoteUrl: string): OriginInfo | null {
  const raw = remoteUrl.trim();
  if (raw === "") {
    return null;
  }

  let host = "";
  let pathPart = "";

  if (raw.includes("://")) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      pathPart = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // scp-like syntax: [user@]host:path
    const at = raw.indexOf("@");
    const colon = raw.indexOf(":", at === -1 ? 0 : at + 1);
    if (colon === -1) {
      return null;
    }
    host = raw.slice(at === -1 ? 0 : at + 1, colon);
    pathPart = raw.slice(colon + 1);
  }

  host = host.trim().toLowerCase();
  const cleaned = pathPart
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (host === "" || cleaned === "") {
    return null;
  }

  const segments = cleaned.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) {
    return null;
  }
  const repo = segments[segments.length - 1] ?? "";
  const owner = segments.slice(0, -1).join("/");
  if (repo === "" || owner === "") {
    return null;
  }

  return {
    kind: classifyHost(host),
    host,
    owner,
    repo,
    webBase: `https://${host}`,
    remoteUrl: raw,
  };
}

export function classifyHost(host: string): ForgeKind {
  const normalized = host.toLowerCase();
  if (
    normalized === "github.com" ||
    normalized === "www.github.com" ||
    normalized.startsWith("github.")
  ) {
    return "github";
  }
  if (
    normalized === "gitlab.com" ||
    normalized === "www.gitlab.com" ||
    normalized.startsWith("gitlab.") ||
    normalized.includes("gitlab")
  ) {
    return "gitlab";
  }
  return "generic";
}

export function createForgePort(options: ForgeOptions): ForgePort {
  const exec = options.exec ?? defaultCommandExec;
  const origin = readOrigin(options, exec);
  const kind: ForgeKind = origin?.kind ?? "generic";
  const cli = kind === "github" ? "gh" : kind === "gitlab" ? "glab" : null;
  let availability: boolean | null = null;

  const run = (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): CommandResult =>
    exec(command, args, {
      cwd: options.cwd,
      timeoutMs,
      ...(options.env === undefined ? {} : { env: options.env }),
    });

  const isAvailable = (): boolean => {
    if (cli === null) {
      return false;
    }
    if (availability !== null) {
      return availability;
    }
    const result = run(cli, ["--version"], FORGE_PROBE_TIMEOUT_MS);
    availability =
      result.spawnError === null && !result.timedOut && result.exitCode === 0;
    return availability;
  };

  return {
    kind,

    available: isAvailable,

    createChangeRequest(
      createOptions: CreateChangeRequestOptions,
    ): { url: string } | null {
      if (cli === null || !isAvailable() || origin === null) {
        return null;
      }
      const args =
        kind === "github"
          ? githubCreateArgs(createOptions)
          : gitlabCreateArgs(createOptions);
      const result = run(cli, args, FORGE_CREATE_TIMEOUT_MS);
      if (result.exitCode !== 0 || result.spawnError !== null || result.timedOut) {
        return null;
      }
      const url = firstUrl(result.stdout);
      return url === null ? null : { url };
    },

    viewChangeRequest(branch: string): ChangeRequestState | null {
      if (cli === null || !isAvailable()) {
        return null;
      }
      const args =
        kind === "github"
          ? [
              "pr",
              "view",
              branch,
              "--json",
              "url,state,isDraft,mergeStateStatus,headRefName",
            ]
          : ["mr", "view", branch, "--output", "json"];
      const result = run(cli, args, FORGE_PROBE_TIMEOUT_MS);
      if (result.exitCode !== 0 || result.spawnError !== null || result.timedOut) {
        return null;
      }
      return kind === "github"
        ? parseGithubState(result.stdout, branch)
        : parseGitlabState(result.stdout, branch);
    },

    compareUrl(compare: CompareUrlOptions): string | null {
      if (!origin?.webBase) {
        return null;
      }
      const base = compare.base.trim();
      const head = compare.head.trim();
      if (base === "" || head === "") {
        return null;
      }
      const repoPath = `${origin.owner}/${origin.repo}`;
      if (kind === "github") {
        return `${origin.webBase}/${repoPath}/compare/${base}...${head}?expand=1`;
      }
      if (kind === "gitlab") {
        return `${origin.webBase}/${repoPath}/-/compare/${base}...${head}`;
      }
      return null;
    },
  };
}

function readOrigin(
  options: ForgeOptions,
  exec: CommandExec,
): OriginInfo | null {
  const remoteUrl =
    options.originUrl === undefined
      ? readOriginUrl(options, exec)
      : options.originUrl;
  return remoteUrl === null ? null : parseOriginUrl(remoteUrl);
}

function readOriginUrl(
  options: ForgeOptions,
  exec: CommandExec,
): string | null {
  const result = exec("git", ["remote", "get-url", "origin"], {
    cwd: options.cwd,
    timeoutMs: FORGE_PROBE_TIMEOUT_MS,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.exitCode !== 0 || result.spawnError !== null || result.timedOut) {
    return null;
  }
  const url = result.stdout.trim();
  return url === "" ? null : url;
}

function githubCreateArgs(
  options: CreateChangeRequestOptions,
): readonly string[] {
  return [
    "pr",
    "create",
    "--head",
    options.branch,
    "--base",
    options.base,
    "--title",
    options.title,
    "--body",
    options.body ?? "",
    ...(options.draft === true ? ["--draft"] : []),
  ];
}

function gitlabCreateArgs(
  options: CreateChangeRequestOptions,
): readonly string[] {
  return [
    "mr",
    "create",
    "--source-branch",
    options.branch,
    "--target-branch",
    options.base,
    "--title",
    options.title,
    "--description",
    options.body ?? "",
    "--yes",
    ...(options.draft === true ? ["--draft"] : []),
  ];
}

function firstUrl(output: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+/.exec(output);
  return match === null ? null : match[0];
}

function parseGithubState(
  output: string,
  branch: string,
): ChangeRequestState | null {
  const parsed = parseJsonObject(output);
  if (parsed === null) {
    return null;
  }
  const state = typeof parsed.state === "string" ? parsed.state.toLowerCase() : "unknown";
  return {
    url: typeof parsed.url === "string" ? parsed.url : null,
    state,
    branch:
      typeof parsed.headRefName === "string" ? parsed.headRefName : branch,
    draft: parsed.isDraft === true,
    mergeState:
      typeof parsed.mergeStateStatus === "string"
        ? parsed.mergeStateStatus
        : null,
  };
}

function parseGitlabState(
  output: string,
  branch: string,
): ChangeRequestState | null {
  const parsed = parseJsonObject(output);
  if (parsed === null) {
    return null;
  }
  const rawState =
    typeof parsed.state === "string" ? parsed.state.toLowerCase() : "unknown";
  return {
    url:
      typeof parsed.web_url === "string"
        ? parsed.web_url
        : typeof parsed.webUrl === "string"
          ? parsed.webUrl
          : null,
    state: rawState === "opened" ? "open" : rawState,
    branch:
      typeof parsed.source_branch === "string"
        ? parsed.source_branch
        : typeof parsed.sourceBranch === "string"
          ? parsed.sourceBranch
          : branch,
    draft: parsed.draft === true || parsed.work_in_progress === true,
    mergeState: null,
  };
}

function parseJsonObject(
  output: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
