"""JSONL run logs and a small parallel runner."""

from __future__ import annotations

import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterable


class RunLog:
    """Append-only JSONL file of outcome dicts. Safe to write from several threads."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, record) -> None:
        d = record.to_dict() if hasattr(record, "to_dict") else record
        with self._lock, self.path.open("a") as f:
            f.write(json.dumps(d, default=str) + "\n")

    def load(self) -> list[dict]:
        return load(self.path)


def load(path: str | Path) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def run_many(fn: Callable, items: Iterable, *, concurrency: int = 3, log: RunLog | None = None, label: str = "") -> list:
    """Run fn(item) for each item in parallel threads. Logs each result as it finishes."""
    items = list(items)
    results = []
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(fn, it): it for it in items}
        for i, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            results.append(res)
            if log is not None:
                log.write(res)
            elapsed = time.monotonic() - start
            print(f"[{label}] {i}/{len(items)} done ({elapsed:.0f}s)", file=sys.stderr, flush=True)
    return results
