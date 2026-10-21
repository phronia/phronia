#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# phronia-shim: snow@v1
# shim-version: 0.6.17
# DO NOT EDIT. Regenerate with: phronia update --regenerate-shims

"""Snow CLI Phronia context writer + additionalContext emitter.

Used by onSessionStart / onUserMessage / beforeSubAgentStart hooks.

1. Writes a breadcrumb file agents/skills can Read:
     .snow/log/phronia-context.txt
2. Prints stdout JSON for the Snow inject protocol:
     { "additionalContext": "...", "display": "..." }

Modes (compact vs full):
- argv: session | user | subagent  (preferred)
- env:  PHRONIA_SNOW_HOOK_MODE
- stdin JSON from Snow may include agentId/agentName/prompt/cwd/sessionId

This file contains no context assembly. It maps the hook event to
`phronia context` and encodes the returned blocks for Snow. Fail-open: never
raise out of main().
"""

from __future__ import annotations

from collections.abc import Mapping
import json
import os

# TRELLIS_* -> PHRONIA_* compatibility (removed in the next major).
for _legacy_key in list(os.environ):
    if _legacy_key.startswith("TRELLIS_"):
        os.environ.setdefault("PHRONIA_" + _legacy_key[8:], os.environ[_legacy_key])
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# Force UTF-8 on Windows consoles (cp936/cp1252 otherwise corrupt Chinese paths).
if sys.platform.startswith("win"):
    import io as _io

    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass
        elif hasattr(_stream, "detach"):
            try:
                setattr(
                    sys,
                    _stream_name,
                    _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"),
                )
            except Exception:
                pass


DEFAULT_MAX_BYTES = 7500
COMPACT_MAX_BYTES = 2800


def _find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur, *cur.parents]:
        if (candidate / ".phronia").is_dir():
            return candidate
    return cur


def _resolve_cli() -> list[str]:
    explicit = os.environ.get("PHRONIA_CLI_PATH")
    if explicit:
        return [sys.executable, explicit] if explicit.endswith(".py") else ["node", explicit]
    for name in ("phronia", "trellis"):
        found = shutil.which(name)
        if found:
            return [found]
    raise RuntimeError("cannot find the phronia CLI; install @phronia/cli or set PHRONIA_CLI_PATH")


def _call_core(
    repo: Path,
    event: str,
    payload: dict[str, Any],
    request_input: dict[str, Any],
) -> dict[str, Any]:
    command = [
        *_resolve_cli(),
        "context",
        "--event",
        event,
        "--platform",
        "snow",
        "--project-root",
        str(repo),
        "--input",
        "-",
        "--json",
    ]
    completed = subprocess.run(
        command,
        input=json.dumps(request_input),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"phronia context exited {completed.returncode}")
    data = json.loads(completed.stdout)
    if not isinstance(data, dict):
        raise RuntimeError("phronia context returned a non-object response")
    return data


def _blocks_text(response: dict[str, Any]) -> str:
    blocks = response.get("blocks")
    if not isinstance(blocks, list):
        return ""
    texts = [
        block.get("text")
        for block in blocks
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]
    return "\n\n".join(text for text in texts if text)


def _drain_stdin(timeout_sec: float = 0.5) -> str:
    """Best-effort drain of host-piped hook context without hanging on TTY."""
    chunks: list[str] = []
    try:
        if sys.stdin is None or sys.stdin.closed:
            return ""
        # Interactive terminal: do not block waiting for EOF.
        if hasattr(sys.stdin, "isatty") and sys.stdin.isatty():
            return ""

        # Hosts (Snow) pipe JSON then close stdin. Manual CLI runs must not hang.
        if sys.platform.startswith("win"):
            import threading

            box: list[str] = []

            def _read() -> None:
                try:
                    box.append(sys.stdin.read())
                except Exception:
                    pass

            t = threading.Thread(target=_read, daemon=True)
            t.start()
            t.join(timeout_sec)
            return box[0] if box else ""

        import select

        while True:
            ready, _, _ = select.select([sys.stdin], [], [], timeout_sec)
            if not ready:
                break
            chunk = sys.stdin.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
    except Exception:
        pass
    return "".join(chunks)


def _parse_stdin_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        # Some hosts may wrap payload; try first JSON object substring.
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                data = json.loads(text[start : end + 1])
                return data if isinstance(data, dict) else {}
            except Exception:
                return {}
        return {}


def _resolve_mode(
    argv: list[str], env: Mapping[str, str], stdin_ctx: dict[str, Any]
) -> str:
    for arg in argv[1:]:
        a = arg.strip().lower()
        if a in {"session", "user", "subagent", "full", "compact"}:
            if a == "full":
                return "session"
            if a == "compact":
                return "user"
            return a
    env_mode = (env.get("PHRONIA_SNOW_HOOK_MODE") or "").strip().lower()
    if env_mode in {"session", "user", "subagent"}:
        return env_mode
    # Infer from Snow stdin context shape.
    if stdin_ctx.get("agentId") or stdin_ctx.get("agentName") or stdin_ctx.get("prompt"):
        return "subagent"
    if stdin_ctx.get("message") is not None or stdin_ctx.get("source") in {"normal", "pending"}:
        return "user"
    if stdin_ctx.get("isResume") is not None or stdin_ctx.get("messages") is not None:
        return "session"
    return "session"


def _agent_type(stdin_ctx: dict[str, Any]) -> str:
    blob = " ".join(
        str(stdin_ctx.get(k) or "")
        for k in ("agentId", "agentName", "prompt")
    ).lower()
    if "implement" in blob:
        return "phronia-implement"
    if "check" in blob:
        return "phronia-check"
    if "research" in blob:
        return "phronia-research"
    return "session"


def _request_input(stdin_ctx: dict[str, Any], mode: str) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    session_id = stdin_ctx.get("sessionId") or stdin_ctx.get("session_id")
    if isinstance(session_id, str) and session_id:
        payload["session_id"] = session_id
    if mode == "user":
        message = stdin_ctx.get("message")
        payload["prompt"] = message if isinstance(message, str) else ""
    if mode == "subagent":
        payload["subagent_type"] = _agent_type(stdin_ctx)
        payload["context_only"] = True
        prompt = stdin_ctx.get("prompt")
        payload["prompt"] = prompt if isinstance(prompt, str) else ""
    return payload


def _truncate(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    suffix = "\n... (truncated)\n"
    budget = max(0, max_bytes - len(suffix.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + suffix


def _event(mode: str) -> str:
    return {"session": "session-start", "user": "user-prompt", "subagent": "subagent-spawn"}[mode]


def main() -> int:
    try:
        raw_stdin = _drain_stdin()
        stdin_ctx = _parse_stdin_json(raw_stdin)
        mode = _resolve_mode(sys.argv, os.environ, stdin_ctx)

        cwd_hint = stdin_ctx.get("cwd") if isinstance(stdin_ctx.get("cwd"), str) else None
        cwd = Path(cwd_hint or os.environ.get("SNOW_CWD") or os.getcwd())
        repo = _find_repo_root(cwd)
        request_input = _request_input(stdin_ctx, mode)

        response = _call_core(repo, _event(mode), stdin_ctx, request_input)
        context = _blocks_text(response)

        # Keep phronia-context.txt as the richest practical breadcrumb for
        # pull-based reads. User-mode inject stays compact, but must not clobber
        # a prior full snapshot.
        if mode == "user":
            full = _blocks_text(_call_core(repo, "session-start", stdin_ctx, request_input))
            log_context = full
        else:
            log_context = context

        log_dir = repo / ".snow" / "log"
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            (log_dir / "phronia-context.txt").write_text(log_context, encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"phronia-context write failed: {exc}\n")

        max_bytes = COMPACT_MAX_BYTES if mode == "user" else DEFAULT_MAX_BYTES
        inject = _truncate(context, max_bytes)
        display = {
            "session": "Phronia session context injected",
            "user": "Phronia compact breadcrumb",
            "subagent": f"Phronia sub-agent context ({_agent_type(stdin_ctx)})",
        }.get(mode, "Phronia context refreshed")
        display = f"{display} (.snow/log/phronia-context.txt)"

        payload = {
            "additionalContext": inject,
            "display": display,
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 — absolute fail-open
        try:
            sys.stderr.write(f"write-phronia-context failed: {exc}\n")
            # Still emit empty-safe JSON so host can continue.
            sys.stdout.write(
                json.dumps(
                    {
                        "additionalContext": "# Phronia context unavailable (hook error)\n",
                        "display": "Phronia context hook error (fail-open)",
                    },
                    ensure_ascii=False,
                )
            )
            sys.stdout.write("\n")
        except Exception:
            pass
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
