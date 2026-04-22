#!/usr/bin/env python3
"""Stop repo-symbol-tree local dev servers."""

import os
import signal
import subprocess
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MATCH_PATTERNS = (
    f"{REPO_ROOT}/backend/app_server.py",
    f"{REPO_ROOT}/backend/symbol_translate_server.py",
    f"{REPO_ROOT}/frontend/node_modules/.bin/vite",
    "backend/app_server.py",
    "backend/symbol_translate_server.py",
    "node ./frontend/node_modules/.bin/vite",
    "node_modules/.bin/vite",
    "./node_modules/.bin/vite",
)


def find_matching_pids() -> list[int]:
    result = subprocess.run(
        ["ps", "-eo", "pid=,args="],
        check=True,
        capture_output=True,
        text=True,
    )
    pids: list[int] = []
    current_pid = os.getpid()

    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == current_pid:
            continue
        if any(pattern in command for pattern in MATCH_PATTERNS):
            pids.append(pid)

    return sorted(set(pids))


def stop_processes(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue

    deadline = time.time() + 1.5
    alive = set(pids)
    while alive and time.time() < deadline:
        next_alive: set[int] = set()
        for pid in alive:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            next_alive.add(pid)
        alive = next_alive
        if alive:
            time.sleep(0.1)

    for pid in alive:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            continue


def main() -> None:
    pids = find_matching_pids()
    if not pids:
        print("no repo-symbol-tree dev processes found")
        return

    stop_processes(pids)
    print("stopped repo-symbol-tree dev processes:", " ".join(str(pid) for pid in pids))


if __name__ == "__main__":
    main()
