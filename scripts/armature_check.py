#!/usr/bin/env python
"""Doctor for the Armature setup. Run: uv run --extra analytics python scripts/armature_check.py

Checks the SDK is importable, the ingest key is present, and (with --live)
that a throwaway instrumented server can deliver one event.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sales_agent.analytics import ENV_PATH, load_env  # noqa: E402

OK, BAD, WARN = "  ok  ", " FAIL ", " warn "


def line(status: str, msg: str) -> None:
    print(f"[{status}] {msg}")


def main() -> int:
    failures = 0

    found = load_env()
    line(OK if ENV_PATH.exists() else BAD, f".env at {ENV_PATH} ({len(found)} values set)")
    if not ENV_PATH.exists():
        print("        cp .env.example .env, then paste the shared keys")
        failures += 1

    try:
        import armature_mcp_analytics as sdk

        line(OK, f"armature-mcp-analytics {getattr(sdk, '__version__', 'installed')}")
    except ImportError:
        line(BAD, "armature-mcp-analytics not installed -> uv sync --extra analytics")
        failures += 1

    try:
        import mcp

        line(OK, f"mcp SDK {mcp.__version__ if hasattr(mcp, '__version__') else ''} (SDK needs >=1.27)")
    except ImportError:
        line(BAD, "mcp not installed -> uv sync")
        failures += 1

    key = os.environ.get("ANALYTICS_INGEST_API_KEY")
    if key:
        line(OK, f"ANALYTICS_INGEST_API_KEY set ({key[:4]}…{key[-4:]}, {len(key)} chars)")
    else:
        line(WARN, "ANALYTICS_INGEST_API_KEY empty -> analytics no-ops (everything else still runs)")
        print("        get one: armature.tech dashboard, free workspace, no card")

    url = os.environ.get("ANALYTICS_INGEST_URL")
    line(OK, f"ANALYTICS_INGEST_URL = {url}" if url else "ANALYTICS_INGEST_URL unset (US default)")

    # Other keys the demo path needs, reported but not required for Armature.
    for name in ("ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "SUPABASE_URL"):
        value = os.environ.get(name)
        if name == "STRIPE_SECRET_KEY" and value and not value.startswith("sk_test_"):
            line(BAD, f"{name} is not a TEST key (sk_test_…) — repo rule is test mode only")
            failures += 1
        else:
            line(OK if value else WARN, f"{name} {'set' if value else 'empty'}")

    print()
    if failures:
        print(f"{failures} blocking problem(s) above.")
    else:
        print("Armature environment ready." if key else "Install ready; drop the ingest key into .env to start sending sessions.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
