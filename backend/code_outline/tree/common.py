"""Tree-specific helpers."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True, slots=True)
class Stats:
    """Basic counts for one built repository tree payload."""

    total_nodes: int
    python_files: int


def is_binary_file(path: Path) -> bool:
    """Detect binary-vs-text via the system `file` tool instead of local heuristics."""
    try:
        mime_encoding = subprocess.run(
            ["file", "--mime-encoding", "-b", str(path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().lower()
    except (FileNotFoundError, subprocess.CalledProcessError):
        raise RuntimeError("system `file` command is required for backend binary detection")

    return mime_encoding == "binary"
