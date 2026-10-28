# ADR-0015: Project-local ZCode plugin and `phronia hook`

- Status: accepted
- Date: 2026-10-28
- Supersedes: the `.zcode/config.json` workspace-hook writer and the
  `trellis-bridge` manual fallback.

## Context

ZCode's `${ZCODE_PROJECT_DIR}` is the **tool cwd**, not the workspace root. A
`cd` into `.phronia/tasks/...` therefore points a project-relative hook script
at a path that does not exist and blocks every tool call. The old config also
ran through a shell (`type: "command"`), which made quoting and POSIX-only
workarounds (`git rev-parse`, `$(...)`) platform-dependent.

ZCode also loads `plugins.dirs` from `.zcode/config.json` as `inline` plugins
and enables them by default. Plugin `hooks/hooks.json` supports
`type: "process"` with argv, `${ZCODE_PLUGIN_ROOT}` is stable, and a
project-local plugin can be refreshed in place by `phronia update`.

## Decision

1. Ship a project-local ZCode plugin at `.zcode/plugins/phronia/`:
   - `.zcode-plugin/plugin.json`
   - `hooks/hooks.json` using `type: "process"` and
     `${ZCODE_PLUGIN_ROOT}/hooks/bridge.mjs`
   - `hooks/bridge.mjs`, which delegates to `phronia hook`
   - `plugins.dirs` must contain the **absolute** plugin path. ZCode resolves
     relative entries against the host process cwd, not the workspace root, so
     a relative entry silently disappears after an app restart or when another
     workspace is active. `init`/`update`/`doctor` write and repair the
     machine-local absolute path.
2. Add `phronia hook --platform zcode --event <event>` as the stable harness
   entrypoint. It resolves the nearest `.phronia/` root from
   `ZCODE_PROJECT_DIR`/cwd and calls the existing Python shim with the explicit
   root.
3. Put root discovery in `@phronia/core/layout` (`findProjectRoot`), so the CLI
   and future adapters share one implementation.
4. `phronia init`, `phronia update`, and `phronia doctor` own the lifecycle:
   - `init` installs the plugin and removes legacy Phronia workspace hooks;
   - `update` refreshes the plugin and migrates old projects;
   - `doctor` checks/repairs the plugin by default (`--no-fix` is read-only).
5. Do not keep project-level `hooks` in `.zcode/config.json` when the plugin is
   installed; one hook source prevents double execution.
6. Keep a user-level marketplace plugin as a fallback for ZCode builds where
   project-local plugin directories are unavailable.

## Consequences

- Hook commands contain no project paths, no shell, and no
  `${ZCODE_PROJECT_DIR}/script`; cwd changes cannot break them.
- `phronia init` is fully automatic: no marketplace install and no extra flag.
- Per-repository versioning is preserved: the plugin ships with the project and
  `phronia update` rewrites it.
- The `plugins.dirs` entry is machine-local (absolute path). A fresh clone on
  another machine needs `phronia init` / `phronia update` / `phronia doctor` to
  rewrite it, or the user can opt into the user-level marketplace fallback.
- `plugins.dirs` is a local inline-plugin source, not the primary path in the
  public Plugin docs. The doctor checks the installed plugin and a user-level
  marketplace fallback is documented.
- Enabling a project plugin grants code execution in that workspace. The plugin
  lives in the repository and is reviewable like any hook script.
- New sessions are required after a plugin/update change; the configuration is
  snapshotted at session start.
