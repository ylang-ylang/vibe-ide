"""Shared constants and low-level helpers for tree and outline generation."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


EXCLUDED_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "assets",
    "build",
    "common_assets",
    "dist",
    "node_modules",
    "third_party",
}

PYTHON_FILE_SUFFIX = ".py"

GIT_STATUS_META = {
    "conflicted": {"code": "!", "label": "conflicted", "priority": 70},
    "deleted": {"code": "D", "label": "deleted", "priority": 60},
    "modified": {"code": "M", "label": "modified", "priority": 50},
    "added": {"code": "A", "label": "added", "priority": 40},
    "renamed": {"code": "R", "label": "renamed", "priority": 30},
    "copied": {"code": "C", "label": "copied", "priority": 20},
    "typechanged": {"code": "T", "label": "type changed", "priority": 10},
    "untracked": {"code": "U", "label": "untracked", "priority": 0},
}

HUNK_HEADER_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@"
)


@dataclass(frozen=True, slots=True)
class Stats:
    """Basic counts for one built repository tree payload."""

    total_nodes: int
    python_files: int


def should_track_repo_path(relative_path: str) -> bool:
    """Return whether one repo-relative path can affect visible tree content or git badges."""
    return bool(relative_path and Path(relative_path).name.lower() != ".ds_store")


def resolve_preview_target(repo_root: Path, relative_path: str) -> tuple[Path, str]:
    """Resolve one repo-relative preview target and keep it inside the repo root."""
    normalized_relative_path = relative_path.strip().strip("/")
    if not normalized_relative_path:
        raise ValueError("path must be a non-empty repo-relative path")

    target_path = (repo_root / normalized_relative_path).resolve()
    if not target_path.is_relative_to(repo_root):
        raise ValueError(f"path must stay inside repo root: {relative_path}")
    if not target_path.is_file():
        raise ValueError(f"path is not a file: {relative_path}")

    return target_path, target_path.relative_to(repo_root).as_posix()


def is_python_file(relative_path: str) -> bool:
    """Return whether one repo-relative path points to a Python file."""
    return Path(relative_path).suffix.lower() == PYTHON_FILE_SUFFIX


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


def build_source_signature(path: Path) -> str:
    """Build one cheap change signature from file mtime and size."""
    stat_result = path.stat()
    return f"{stat_result.st_mtime_ns}:{stat_result.st_size}"


def first_line(text: str | None) -> str | None:
    """Return the first non-empty stripped line from one block of text."""
    if not text:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None
