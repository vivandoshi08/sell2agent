"""Run one real Claude buying agent (headless `claude -p`) against the E1 servers.

    uv run python experiments/e1_e2e_mcp/buyer.py --index 4 --design structured [--brief neutral] [--seed 101]

The buyer gets the persona in its system prompt, no built-in tools, and two
MCP servers over stdio: the registry (search_sellers, get_web_page) and
Prairie's front door (structured or free-text design). The full stream
(every assistant message, tool call, and tool result) is saved to
runs/buyer/<run_id>.stream.jsonl; the run record goes to the caller.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BUYER_STREAMS, HERE, REPO, now_iso  # noqa: E402

from sales_agent import llm  # noqa: E402
from sales_agent.catalog import ADDONS  # noqa: E402
from sales_agent.personas import BRIEFS, BuyerPersona, make_personas  # noqa: E402

BUYER_MODEL = llm.OPUS
BUYER_EFFORT = "low"
MAX_TURNS = 50
TIMEOUT_S = 1200
MAX_BUDGET_USD = 4.0

SUMMARY_SPEC = """When you are done, end your final reply with exactly these lines:
SELLER: <the seller you bought from or recommend, or none>
OUTCOME: purchased | recommend | no_deal
ITEMS: <tractor and add-ons, or none>
PRICE: <total in dollars, or none>
ORDER_ID: <checkout session id, or none>
WHY: <one or two sentences: why this seller and this outcome>
Use "purchased" only if you paid through a checkout. Use "recommend" if you found a deal you could not pay for yourself and your client should complete it. Use "no_deal" if nothing fits."""


def system_prompt(p: BuyerPersona) -> str:
    wants = ", ".join(ADDONS[a].name for a in p.wants_addons) or "none"
    return "\n\n".join(
        [
            "You are an autonomous purchasing agent. Your client has asked you to buy equipment for them. "
            "No one is available to answer questions while you work, so make the decisions yourself.",
            f"Your client's need: {p.need}.",
            f"Add-ons your client wants if the price works: {wants}.",
            f"Budget your client mentioned: ${p.budget:,}. You may share this or keep it to yourself.",
            f"Your walk-away price: ${p.walk_away:,} total, including any add-ons. Never agree to pay more than this. It is private: don't reveal it.",
            BRIEFS.get(p.brief, BRIEFS["neutral"]),
            f"Your client's urgency: {p.urgency}.",
            "Your job: find a seller, get a good deal on something that meets the need, and complete the purchase. "
            "You are authorized to pay through a seller's checkout for a deal at or below your walk-away price. "
            "If no seller can meet the need within your walk-away price, don't buy, and explain why.",
            "Use your tools to find and deal with sellers.",
            SUMMARY_SPEC,
        ]
    )


USER_PROMPT = "Please take care of this purchase for your client."


def mcp_config(run_id: str, design: str, variant: str = "negotiable") -> dict:
    fixed = variant == "fixed"
    env = {"SALES_AGENT_MAX_CONCURRENCY": os.environ.get("SALES_AGENT_MAX_CONCURRENCY", "3"), "PYTHONUNBUFFERED": "1"}
    return {
        "mcpServers": {
            "registry": {
                "type": "stdio",
                "command": "uv",
                "args": ["--directory", str(REPO), "run", "python", "experiments/e1_e2e_mcp/registry_server.py", "--session", run_id, "--variant", variant],
                "env": env,
            },
            "prairie_equipment": {
                "type": "stdio",
                "command": "uv",
                "args": ["--directory", str(REPO), "run", "python", "experiments/e1_e2e_mcp/seller_server.py", "--design", design, "--session", run_id] + (["--fixed-price"] if fixed else []),
                "env": env,
            },
        }
    }


def parse_summary(text: str) -> dict:
    out = {}
    for key in ("SELLER", "OUTCOME", "ITEMS", "PRICE", "ORDER_ID", "WHY"):
        m = re.findall(rf"^\**{key}\**:\**\s*(.+?)\s*$", text or "", re.M)
        if m:
            out[key.lower()] = m[-1].strip().strip("*").strip()
    if "price" in out:
        nums = re.findall(r"\d[\d,]*", out["price"])
        out["price_int"] = int(nums[0].replace(",", "")) if nums else None
    if "outcome" in out:
        o = out["outcome"].lower()
        out["outcome"] = next((k for k in ("purchased", "recommend", "no_deal") if k in o.replace(" ", "_")), o)
    return out


def parse_stream(path: Path) -> dict:
    """Pull tool calls, tool results, assistant text, and the final result out of a stream-json file."""
    tool_uses, results, texts, final, init = [], {}, [], None, None
    for line in path.read_text().splitlines():
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = o.get("type")
        if t == "system" and o.get("subtype") == "init":
            init = {"tools": o.get("tools"), "mcp_servers": o.get("mcp_servers"), "model": o.get("model")}
        elif t == "assistant":
            for c in o["message"].get("content", []):
                if c.get("type") == "tool_use":
                    tool_uses.append({"id": c["id"], "name": c["name"], "input": c.get("input")})
                elif c.get("type") == "text" and c.get("text", "").strip():
                    texts.append({"after_tool_calls": len(tool_uses), "text": c["text"]})
        elif t == "user":
            content = o["message"].get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        body = c.get("content")
                        if isinstance(body, list):
                            body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
                        results[c["tool_use_id"]] = {"is_error": bool(c.get("is_error")), "content": str(body)[:4000]}
        elif t == "result":
            final = o
    for tu in tool_uses:
        r = results.get(tu["id"], {})
        tu["is_error"] = r.get("is_error")
        tu["result"] = r.get("content")
    return {"init": init, "tool_uses": tool_uses, "texts": texts, "final": final}


def run_buyer(persona: BuyerPersona, design: str, run_id: str, *, model: str = BUYER_MODEL, effort: str = BUYER_EFFORT, variant: str = "negotiable") -> dict:
    BUYER_STREAMS.mkdir(parents=True, exist_ok=True)
    stream_path = BUYER_STREAMS / f"{run_id}.stream.jsonl"
    workdir = Path(tempfile.mkdtemp(prefix="e1-buyer-"))
    cfg_path = workdir / "mcp.json"
    cfg_path.write_text(json.dumps(mcp_config(run_id, design, variant)))
    cmd = [
        "claude", "-p",
        "--system-prompt", system_prompt(persona),
        "--tools", "",
        "--allowedTools", "mcp__registry", "mcp__prairie_equipment",
        "--mcp-config", str(cfg_path),
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--model", model,
        "--effort", effort,
        "--max-turns", str(MAX_TURNS),
        "--max-budget-usd", str(MAX_BUDGET_USD),
        "--output-format", "stream-json", "--verbose",
        USER_PROMPT,
    ]
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_EFFORT"}
    env["MCP_TOOL_TIMEOUT"] = "300000"
    env["MCP_TIMEOUT"] = "60000"
    rec = {
        "run_id": run_id,
        "experiment": "e1_e2e_mcp",
        "design": design,
        "variant": variant,
        "brief": persona.brief,
        "persona": persona.to_dict(),
        "buyer_model": model,
        "buyer_effort": effort,
        "started": now_iso(),
        "timed_out": False,
    }
    t0 = time.monotonic()
    with stream_path.open("w") as out, (workdir / "stderr.txt").open("w") as err:
        try:
            proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=workdir, env=env, timeout=TIMEOUT_S)
            rec["returncode"] = proc.returncode
        except subprocess.TimeoutExpired:
            rec["timed_out"] = True
            rec["returncode"] = None
    rec["wall_s"] = round(time.monotonic() - t0, 1)
    rec["stderr_tail"] = (workdir / "stderr.txt").read_text()[-1500:]
    parsed = parse_stream(stream_path)
    final = parsed["final"] or {}
    rec["result_text"] = final.get("result") or (parsed["texts"][-1]["text"] if parsed["texts"] else "")
    rec["summary"] = parse_summary(rec["result_text"])
    rec["num_turns"] = final.get("num_turns")
    rec["subtype"] = final.get("subtype")
    rec["is_error"] = final.get("is_error")
    rec["terminal_reason"] = final.get("terminal_reason")
    rec["buyer_cost_usd"] = final.get("total_cost_usd")
    u = final.get("usage") or {}
    in_tok = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
    rec["buyer_usage"] = {
        "input_tokens": in_tok,
        "output_tokens": u.get("output_tokens") or 0,
        "cache_read_input_tokens": u.get("cache_read_input_tokens") or 0,
        "cost_usd_cli": final.get("total_cost_usd"),
        "cost_usd_list_estimate": round(llm.estimate_cost(model, in_tok, u.get("output_tokens") or 0), 6),
    }
    rec["permission_denials"] = final.get("permission_denials")
    rec["mcp_servers"] = (parsed["init"] or {}).get("mcp_servers")
    rec["tools_available"] = (parsed["init"] or {}).get("tools")
    rec["tool_uses"] = parsed["tool_uses"]
    rec["assistant_texts"] = parsed["texts"]
    rec["ended"] = now_iso()
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=101)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--design", choices=["structured", "freetext"], required=True)
    ap.add_argument("--brief", default=None)
    ap.add_argument("--tag", default="manual")
    ap.add_argument("--out", default=str(HERE / "runs" / "buyer_runs.jsonl"))
    args = ap.parse_args()
    persona = make_personas(max(args.index + 1, 10), seed=args.seed)[args.index]
    if args.brief:
        persona.brief = args.brief
    run_id = f"{args.tag}-{args.design[:6]}-{persona.id}-{persona.brief}"
    print("persona:", json.dumps(persona.to_dict()), file=sys.stderr)
    rec = run_buyer(persona, args.design, run_id)
    with open(args.out, "a") as f:
        f.write(json.dumps(rec, default=str) + "\n")
    print(json.dumps({k: rec[k] for k in ("run_id", "wall_s", "num_turns", "subtype", "buyer_cost_usd", "summary")}, indent=2), file=sys.stderr)
    print("tool calls:", [(t["name"].split("__")[-1], t["is_error"]) for t in rec["tool_uses"]], file=sys.stderr)


if __name__ == "__main__":
    main()
