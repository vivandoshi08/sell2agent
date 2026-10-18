"""Shared bits for E1: paths, the JSONL tool-call logger, and an MCP server
subclass that logs every tool call (including argument-validation failures
and unknown tools, which never reach the tool function).

mcp 2.x renamed FastMCP to MCPServer; we import whichever is installed.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNS = HERE / "runs"
SESSIONS = RUNS / "sessions"
BUYER_STREAMS = RUNS / "buyer"
ORDERS = RUNS / "orders.jsonl"

if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

try:  # mcp >= 2
    from mcp.server.mcpserver import MCPServer as _BaseServer
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _BaseServer  # type: ignore
    from mcp.server.fastmcp.exceptions import ToolError  # type: ignore

__all__ = ["LoggedServer", "ToolError", "JsonlLog", "now_iso", "HERE", "REPO", "RUNS", "SESSIONS", "BUYER_STREAMS", "ORDERS"]


def now_iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc).isoformat(timespec="seconds")


class JsonlLog:
    """Append-only JSONL file, safe across threads (and small appends are atomic across processes)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, rec: dict) -> None:
        line = json.dumps(rec, default=str) + "\n"
        with self._lock:
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            try:
                os.write(fd, line.encode())
            finally:
                os.close(fd)


def _result_payload(res: Any) -> tuple[Any, bool]:
    """Pull loggable content and the error flag out of a CallToolResult (or whatever came back)."""
    is_error = bool(getattr(res, "is_error", False) or getattr(res, "isError", False))
    structured = getattr(res, "structured_content", None) or getattr(res, "structuredContent", None)
    if structured is not None:
        return structured, is_error
    content = getattr(res, "content", None)
    if content is None:
        return res, is_error
    texts = []
    for c in content:
        t = getattr(c, "text", None)
        if t is None:
            texts.append(str(c))
            continue
        try:
            texts.append(json.loads(t))
        except (json.JSONDecodeError, TypeError):
            texts.append(t)
    return (texts[0] if len(texts) == 1 else texts), is_error


class LoggedServer(_BaseServer):
    """An MCP server that writes one JSONL record per tool call.

    Each record: timestamp, session, server, design, tool, args, result,
    is_error, error text, whether the error was an argument-validation
    failure, latency, and (if `usage_fn` is given) the seller's model usage
    spent inside the call.
    """

    def __init__(self, name: str, *, log_path: Path, session_id: str, design: str = "", usage_fn: Callable[[], dict] | None = None, **kwargs):
        super().__init__(name, **kwargs)
        self._calllog = JsonlLog(log_path)
        self._session_id = session_id
        self._design = design
        self._server_label = name
        self._usage_fn = usage_fn
        self._seq = 0
        self._seq_lock = threading.Lock()

    async def call_tool(self, name: str, arguments: dict[str, Any], context=None):  # type: ignore[override]
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        t0 = time.time()
        before = self._usage_fn() if self._usage_fn else None
        rec: dict[str, Any] = {
            "ts": now_iso(t0),
            "t": round(t0, 3),
            "seq": seq,
            "session": self._session_id,
            "server": self._server_label,
            "design": self._design,
            "tool": name,
            "args": arguments,
        }
        try:
            res = await super().call_tool(name, arguments, context)
            payload, is_error = _result_payload(res)
            rec["result"] = payload
            rec["is_error"] = is_error
            return res
        except Exception as e:  # logged, then re-raised so the client sees a normal MCP error
            cause = e.__cause__
            rec["is_error"] = True
            rec["error"] = str(e)
            rec["error_type"] = type(e).__name__
            rec["invalid_args"] = type(cause).__name__ == "ValidationError"
            rec["unknown_tool"] = "unknown tool" in str(e).lower()
            raise
        finally:
            rec["latency_s"] = round(time.time() - t0, 3)
            if self._usage_fn:
                after = self._usage_fn()
                rec["seller_usage"] = {
                    k: round(after.get(k, 0) - (before or {}).get(k, 0), 6) for k in ("calls", "input_tokens", "output_tokens", "cost_usd")
                }
            self._calllog.write(rec)
