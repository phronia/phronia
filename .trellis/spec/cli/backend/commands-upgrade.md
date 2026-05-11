# `trellis upgrade` Command

How `trellis upgrade` upgrades the globally installed Trellis CLI package.

This command is intentionally separate from `trellis update`:

- `trellis upgrade` updates the **CLI binary** by running npm's global install.
- `trellis update` updates a **project's bundled Trellis files** under `.trellis/`
  and platform directories.

---

## User-facing contract

```text
trellis upgrade [--tag <tag-or-version>] [--dry-run]
```

Behavior:

- Builds and runs `npm install -g @mindfoldhq/trellis@<tag>`.
- Uses the current CLI channel by default:
  - stable versions install `@latest`
  - `-beta.*` versions install `@beta`
  - `-rc.*` versions install `@rc`
- `--tag <tag-or-version>` overrides the inferred channel. Accept simple npm
  dist-tags or versions such as `latest`, `beta`, `rc`, or `0.6.0-beta.8`.
- `--dry-run` prints the exact npm command and exits without changing anything.

The implementation does not detect or preserve the original installer. Trellis
is published as an npm package, so npm is the upgrade backend even when the user
installed Node through pnpm, Homebrew, Volta, proto, or another manager.

---

## Failure behavior

- If npm is unavailable, fail with the manual npm command.
- If npm exits non-zero, surface the exit code.
- If npm is interrupted by a signal, report the signal.
- Reject shell-shaped `--tag` input before spawning npm. Never build a shell
  command string for execution.

---

## Update hints

Any user-facing hint that previously said:

```text
npm install -g @mindfoldhq/trellis@latest
```

should now prefer:

```text
trellis upgrade
```

This applies to CLI startup warnings, `trellis update` downgrade guidance, and
session-start update hints.

---

## Test requirements

- Tag inference: stable → `latest`, beta → `beta`, RC → `rc`.
- Explicit tag override.
- Invalid tag rejection.
- Windows npm binary name (`npm.cmd`).
- Dry-run does not spawn npm.
- Non-zero npm exit becomes a command failure.
