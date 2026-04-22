"""Shared low-level helpers reused by tree and Mermaid backends."""

from __future__ import annotations

from pathlib import Path


PYTHON_FILE_SUFFIX = ".py"


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
