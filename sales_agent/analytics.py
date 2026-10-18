"""Armature MCP analytics: one import, one call, safe when unconfigured.

Usage in any MCP server (experiments or apps/seller-mcp's Python side):

    from sales_agent.analytics import instrument

    srv = FastMCP("prairie_equipment")
    instrument(srv)            # BEFORE registering tools
    @srv.tool() ...

Behaviour:
  * no ANALYTICS_INGEST_API_KEY -> no-op, returns None, nothing is sent
  * SDK not installed          -> no-op with a one-line warning
  * errors during delivery     -> logged, never raised into a tool call

Keys live in .env at the repo root (see .env.example). load_env() reads it
without adding a dependency; the Python harness has no dotenv.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"

_loaded = False


def load_env(path: Path | None = None, override: bool = False) -> dict[str, str]:
    """Read KEY=VALUE lines from .env into os.environ. Idempotent."""
    global _loaded
    env_path = path or ENV_PATH
    found: dict[str, str] = {}
    if not env_path.exists():
        _loaded = True
        return found
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not value:
            continue
        found[key] = value
        if override or not os.environ.get(key):
            os.environ[key] = value
    _loaded = True
    return found


def is_configured() -> bool:
    if not _loaded:
        load_env()
    return bool(os.environ.get("ANALYTICS_INGEST_API_KEY"))


def instrument(server: Any, **config: Any) -> Any | None:
    """Instrument a FastMCP / official-SDK server. Returns the instrumentation
    handle, or None if analytics is off or unavailable.

    Keyword config is passed through under the SDK's "armature" key, e.g.
    instrument(srv, delivery="await", request_capability=False).

    Call before tools are registered. Idempotent in the SDK.
    """
    if not is_configured():
        return None
    try:
        from armature_mcp_analytics import instrument_fastmcp
    except ImportError:
        print(
            "[analytics] armature-mcp-analytics not installed; "
            "run: uv sync --extra analytics",
            file=sys.stderr,
        )
        return None

    options: dict[str, Any] = {"on_error": _on_error}
    options.update(config)
    try:
        return instrument_fastmcp(server, {"armature": options})
    except Exception as exc:  # never break the server over telemetry
        print(f"[analytics] instrumentation skipped: {exc}", file=sys.stderr)
        return None


async def flush(instrumentation: Any | None) -> None:
    """Flush buffered events on shutdown (background delivery only)."""
    if instrumentation is None:
        return
    try:
        await instrumentation.recorder.flush()
    except Exception as exc:
        print(f"[analytics] flush failed: {exc}", file=sys.stderr)


def _on_error(exc: Exception) -> None:
    print(f"[analytics] delivery error: {exc}", file=sys.stderr)
