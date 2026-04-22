"""Git-backed repo state used by tree and preview builders."""

from __future__ import annotations

import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .common import GIT_STATUS_META, HUNK_HEADER_RE, git_status_meta_entry


@dataclass(frozen=True, slots=True)
class GitRepoState:
    """Git-derived repo view used by tree and preview builders."""

    exact_status: dict[str, dict]
    directory_status: dict[str, dict]
    ignored_files: frozenset[str]
    ignored_directories: frozenset[str]

    def is_ignored_path(self, relative_path: str) -> bool:
        """Return whether one repo-relative path is ignored by Git."""
        normalized_path = relative_path.strip().strip("/")
        if not normalized_path:
            return False
        if normalized_path in self.ignored_files:
            return True
        return any(
            normalized_path == ignored_dir or normalized_path.startswith(f"{ignored_dir}/")
            for ignored_dir in self.ignored_directories
        )


def collect_git_repo_state(repo_root: Path) -> GitRepoState:
    """Collect git status, aggregated directory status, and ignored-path info."""
    try:
        raw_output = subprocess.run(
            [
                "git",
                "-C",
                str(repo_root),
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--ignored=matching",
            ],
            check=True,
            capture_output=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return GitRepoState(
            exact_status={},
            directory_status={},
            ignored_files=frozenset(),
            ignored_directories=frozenset(),
        )

    exact_status: dict[str, dict] = {}
    directory_counters: dict[str, Counter[str]] = {"": Counter()}
    ignored_files: set[str] = set()
    ignored_directories: set[str] = set()
    entries = raw_output.split(b"\0")
    entry_index = 0

    while entry_index < len(entries):
        raw_entry = entries[entry_index]
        entry_index += 1
        if not raw_entry:
            continue

        entry = raw_entry.decode("utf-8", "replace")
        record_type = entry[0]

        if record_type == "1":
            parts = entry.split(" ", 8)
            if len(parts) != 9:
                continue
            kind = git_status_kind_from_xy(parts[1])
            path = parts[8]
        elif record_type == "2":
            parts = entry.split(" ", 9)
            if len(parts) != 10:
                continue
            kind = git_status_kind_from_xy(parts[1])
            path = parts[9]
            entry_index += 1
        elif record_type == "u":
            parts = entry.split(" ", 10)
            if len(parts) != 11:
                continue
            kind = "conflicted"
            path = parts[10]
        elif record_type == "?":
            kind = "untracked"
            path = entry[2:]
        elif record_type == "!":
            ignored_path = entry[2:].rstrip("/")
            if ignored_path:
                if entry.endswith("/"):
                    ignored_directories.add(ignored_path)
                else:
                    ignored_files.add(ignored_path)
            continue
        else:
            continue

        if kind is None:
            continue

        exact_status[path] = build_direct_git_status(kind)
        for ancestor in git_status_ancestor_directories(path):
            directory_counters.setdefault(ancestor, Counter())[kind] += 1

    directory_status = {
        directory_path: build_directory_git_status(counter)
        for directory_path, counter in directory_counters.items()
        if counter
    }
    return GitRepoState(
        exact_status=exact_status,
        directory_status=directory_status,
        ignored_files=frozenset(ignored_files),
        ignored_directories=frozenset(ignored_directories),
    )


def collect_git_status(repo_root: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Collect direct file git status and aggregated directory git status."""
    git_state = collect_git_repo_state(repo_root)
    return git_state.exact_status, git_state.directory_status


def git_status_kind_from_xy(xy: str) -> str | None:
    """Map one porcelain v2 XY status code into the normalized UI status kind."""
    if xy == "??":
        return "untracked"
    if "U" in xy or xy in {"AA", "DD"}:
        return "conflicted"
    if "D" in xy:
        return "deleted"
    if "M" in xy:
        return "modified"
    if "A" in xy:
        return "added"
    if "R" in xy:
        return "renamed"
    if "C" in xy:
        return "copied"
    if "T" in xy:
        return "typechanged"
    return None


def git_status_ancestor_directories(path: str) -> list[str]:
    """Return one repo-relative file path and all its ancestor directories."""
    relative_path = Path(path)
    ancestors = [""]
    parent_parts = relative_path.parts[:-1]
    for index in range(1, len(parent_parts) + 1):
        ancestors.append(Path(*parent_parts[:index]).as_posix())
    return ancestors


def build_direct_git_status(kind: str) -> dict:
    """Build the direct git status badge payload for one changed file."""
    meta = git_status_meta_entry(kind)
    return {
        "code": meta.code,
        "kind": kind,
        "scope": "direct",
        "count": 1,
        "title": meta.label,
    }


def build_directory_git_status(counter: Counter[str]) -> dict:
    """Build the aggregated git status badge payload for one directory subtree."""
    total_count = sum(counter.values())
    dominant_kind = max(
        counter.items(),
        key=lambda item: (git_status_meta_entry(item[0]).priority, item[1], item[0]),
    )[0]
    meta = git_status_meta_entry(dominant_kind)
    mixed = len(counter) > 1
    title_parts = [f"{count} {git_status_meta_entry(kind).label}" for kind, count in sorted(counter.items())]

    return {
        "code": meta.code if total_count == 1 else str(total_count),
        "kind": "mixed" if mixed else dominant_kind,
        "display_kind": dominant_kind,
        "scope": "children",
        "count": total_count,
        "title": f"{total_count} changed descendants: {', '.join(title_parts)}",
    }


def collect_preview_source_git_info(
    repo_root: Path,
    relative_path: str,
    exact_status: dict[str, dict],
) -> dict | None:
    """Return per-line git diff metadata for one preview target when available."""
    file_git_status = exact_status.get(relative_path)
    if not file_git_status or file_git_status["kind"] == "untracked":
        return None

    diff_info = build_source_git_info_from_diff(repo_root, relative_path)
    if diff_info["current"] or diff_info["deleted"]:
        return diff_info
    return None


def build_source_git_info_from_diff(repo_root: Path, relative_path: str) -> dict:
    """Build preview git line markers from `git diff --unified=0` output."""
    try:
        diff_text = subprocess.run(
            [
                "git",
                "-C",
                str(repo_root),
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=0",
                "HEAD",
                "--",
                relative_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return {"current": [], "deleted": []}

    return parse_source_git_info_from_patch(diff_text)


def parse_source_git_info_from_patch(diff_text: str) -> dict:
    """Parse unified diff text into current-line and deleted-line preview markers."""
    current: list[dict] = []
    deleted: list[dict] = []
    old_line = 0
    new_line = 0
    current_kind: str | None = None

    for line in diff_text.splitlines():
        hunk_match = HUNK_HEADER_RE.match(line)
        if hunk_match:
            old_start = int(hunk_match.group("old_start"))
            old_count = int(hunk_match.group("old_count") or "1")
            new_start = int(hunk_match.group("new_start"))
            new_count = int(hunk_match.group("new_count") or "1")
            old_line = old_start
            new_line = new_start

            if old_count == 0 and new_count > 0:
                current_kind = "added"
            elif old_count > 0 and new_count > 0:
                current_kind = "modified"
            else:
                current_kind = None
            continue

        if line.startswith("---") or line.startswith("+++") or line.startswith("diff --git") or line.startswith("index "):
            continue

        if line.startswith("-"):
            deleted.append(
                {
                    "before_line": new_line,
                    "old_line": old_line,
                    "text": line[1:],
                }
            )
            old_line += 1
            continue

        if line.startswith("+"):
            if current_kind is not None:
                current.append({"line": new_line, "kind": current_kind})
            new_line += 1
            continue

        if line.startswith(" "):
            old_line += 1
            new_line += 1

    return {"current": current, "deleted": deleted}
