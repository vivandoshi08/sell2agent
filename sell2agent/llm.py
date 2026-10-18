"""Model backend for buyer and seller agents.

Uses headless `claude -p` on the local Claude login by default. If
ANTHROPIC_API_KEY is set, uses the Anthropic SDK instead (that path is
untested so far; nobody has a key set). Every call returns token counts,
an estimated cost at API list prices, and latency, so experiments can
report model cost per deal.

Environment:
    SELL2AGENT_MODEL            default model (claude-opus-5-5)
    SELL2AGENT_EFFORT           default effort (low)
    SELL2AGENT_MAX_CONCURRENCY  parallel model calls per process (4)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field

DEFAULT_MODEL = os.environ.get("SELL2AGENT_MODEL", "claude-opus-5-5")
DEFAULT_EFFORT = os.environ.get("SELL2AGENT_EFFORT", "low")
MAX_CONCURRENCY = int(os.environ.get("SELL2AGENT_MAX_CONCURRENCY", "4"))

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
HAIKU = "claude-haiku-5-5"

# Input and output price per million tokens, for the cost estimate.
PRICES = {
    OPUS: (4.00, 20.00),
    SONNET: (2.00, 10.00),
    HAIKU: (0.10, 0.50),
}

# Models that accept the server-side refusal fallback on the SDK path.
_FALLBACK_MODELS = {OPUS, SONNET}

_slots = threading.BoundedSemaphore(MAX_CONCURRENCY)
_workdir = tempfile.mkdtemp(prefix="sell2agent-llm-")


class LLMError(RuntimeError):
    """A model call failed in a way worth retrying."""


@dataclass
class Completion:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_s: float


@dataclass
class Usage:
    """Running totals across model calls. Safe to share between threads."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    latency_s: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def add(self, c: Completion) -> None:
        with self._lock:
            self.calls += 1
            self.input_tokens += c.input_tokens
            self.output_tokens += c.output_tokens
            self.cost_usd += c.cost_usd
            self.latency_s += c.latency_s

    def merge(self, other: "Usage") -> None:
        with self._lock:
            self.calls += other.calls
            self.input_tokens += other.input_tokens
            self.output_tokens += other.output_tokens
            self.cost_usd += other.cost_usd
            self.latency_s += other.latency_s

    def as_dict(self) -> dict:
        return {
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "latency_s": round(self.latency_s, 2),
        }


def backend() -> str:
    return "sdk" if os.environ.get("ANTHROPIC_API_KEY") else "cli"


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    inp, out = PRICES.get(model, PRICES[OPUS])
    return (input_tokens * inp + output_tokens * out) / 1_000_000


def complete(
    system: str,
    prompt: str,
    *,
    model: str | None = None,
    effort: str | None = None,
    usage: Usage | None = None,
    retries: int = 4,
    timeout: int = 240,
) -> Completion:
    """One stateless model call: a system prompt and one user message."""
    model = model or DEFAULT_MODEL
    effort = effort or DEFAULT_EFFORT
    call = _complete_sdk if backend() == "sdk" else _complete_cli
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with _slots:
                c = call(system, prompt, model, effort, timeout)
            if usage is not None:
                usage.add(c)
            return c
        except LLMError as e:
            last = e
            time.sleep(min(30.0, 2**attempt + 0.5))
    raise LLMError(f"{model}: gave up after {retries + 1} attempts: {last}")


def complete_json(system: str, prompt: str, **kwargs) -> tuple[dict, Completion]:
    """Like complete(), but parse the reply as a JSON object (one retry on bad JSON)."""
    c = complete(system, prompt, **kwargs)
    try:
        return extract_json(c.text), c
    except ValueError:
        retry = prompt + "\n\nYour last reply was not valid JSON. Reply with one JSON object and nothing else."
        c = complete(system, retry, **kwargs)
        return extract_json(c.text), c


def extract_json(text: str) -> dict:
    """Pull the first JSON object out of a model reply. Tolerates code fences and prose."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start : i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except json.JSONDecodeError:
                        pass
                    break
        start = text.find("{", start + 1)
    raise ValueError(f"no JSON object in reply: {text[:200]!r}")


def _complete_cli(system: str, prompt: str, model: str, effort: str, timeout: int) -> Completion:
    # Replace Claude Code's own system prompt and strip tools, MCP servers,
    # settings, and slash commands, so each call carries ~700 tokens of overhead.
    cmd = [
        "claude", "-p",
        "--system-prompt", system,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--model", model,
        "--effort", effort,
        "--output-format", "json",
    ]
    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd, input=prompt, capture_output=True, text=True, timeout=timeout, cwd=_workdir
        )
    except subprocess.TimeoutExpired as e:
        raise LLMError(f"timed out after {timeout}s") from e
    latency = time.monotonic() - start
    result = _parse_cli_result(proc.stdout)
    if result is None:
        tail = (proc.stderr or proc.stdout or "").strip()[-300:]
        raise LLMError(f"no result from claude CLI (exit {proc.returncode}): {tail}")
    if result.get("is_error"):
        raise LLMError(f"claude CLI error: {str(result.get('result'))[:300]}")
    u = result.get("usage") or {}
    input_tokens = (
        (u.get("input_tokens") or 0)
        + (u.get("cache_creation_input_tokens") or 0)
        + (u.get("cache_read_input_tokens") or 0)
    )
    output_tokens = u.get("output_tokens") or 0
    return Completion(
        text=result.get("result") or "",
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=estimate_cost(model, input_tokens, output_tokens),
        latency_s=latency,
    )


def _parse_cli_result(stdout: str) -> dict | None:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "result":
            return obj
    return None


_sdk_client = None


def _complete_sdk(system: str, prompt: str, model: str, effort: str, timeout: int) -> Completion:
    import anthropic

    global _sdk_client
    if _sdk_client is None:
        _sdk_client = anthropic.Anthropic(max_retries=4, timeout=timeout)
    kwargs = dict(
        model=model,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": effort},
    )
    start = time.monotonic()
    try:
        if model in _FALLBACK_MODELS:
            resp = _sdk_client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
            )
        else:
            resp = _sdk_client.messages.create(**kwargs)
    except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
        raise LLMError(str(e)) from e
    latency = time.monotonic() - start
    if resp.stop_reason == "refusal":
        raise LLMError("model refused")
    text = "".join(b.text for b in resp.content if b.type == "text")
    u = resp.usage
    input_tokens = (
        (u.input_tokens or 0)
        + (getattr(u, "cache_creation_input_tokens", 0) or 0)
        + (getattr(u, "cache_read_input_tokens", 0) or 0)
    )
    return Completion(
        text=text,
        model=model,
        input_tokens=input_tokens,
        output_tokens=u.output_tokens or 0,
        cost_usd=estimate_cost(model, input_tokens, u.output_tokens or 0),
        latency_s=latency,
    )
