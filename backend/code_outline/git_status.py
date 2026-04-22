"""Git status collection and source-diff annotations for previews."""

from __future__ import annotations

import subprocess
from collections import Counter
from pathlib import Path

from .common import EXCLUDED_DIRS, GIT_STATUS_META, HUNK_HEADER_RE, should_track_repo_path


def collect_git_status(repo_root: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """Collect direct file git status and aggregated directory git status."""
    try:
        raw_output = subprocess.run(
            ["git", "-C", str(repo_root), "status", "--porcelain=v2", "-z", "--untracked-files=all"],
            check=True,
            capture_output=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        return {}, {}

    exact_status: dict[str, dict] = {}
    directory_counters: dict[str, Counter[str]] = {"": Counter()}
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
        else:
            continue

        if kind is None or not should_include_git_status_path(path):
            continue

        exact_status[path] = build_direct_git_status(kind)
        for ancestor in git_status_ancestor_directories(path):
            directory_counters.setdefault(ancestor, Counter())[kind] += 1

    directory_status = {
        directory_path: build_directory_git_status(counter)
        for directory_path, counter in directory_counters.items()
        if counter
    }
    return exact_status, directory_status


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


def should_include_git_status_path(path: str) -> bool:
    """Return whether one git status path should be visible in the tree UI."""
    relative_path = Path(path)

    for part in relative_path.parts[:-1]:
        if part in EXCLUDED_DIRS:
            return False
        if part.startswith(".") and part not in {".codex"}:
            return False
    return should_track_repo_path(relative_path.as_posix())


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
    meta = GIT_STATUS_META[kind]
    return {
        "code": meta["code"],
        "kind": kind,
        "scope": "direct",
        "count": 1,
        "title": meta["label"],
    }


def build_directory_git_status(counter: Counter[str]) -> dict:
    """Build the aggregated git status badge payload for one directory subtree."""
    total_count = sum(counter.values())
    dominant_kind = max(
        counter.items(),
        key=lambda item: (GIT_STATUS_META[item[0]]["priority"], item[1], item[0]),
    )[0]
    meta = GIT_STATUS_META[dominant_kind]
    mixed = len(counter) > 1
    title_parts = [f"{count} {GIT_STATUS_META[kind]['label']}" for kind, count in sorted(counter.items())]

    return {
        "code": meta["code"] if total_count == 1 else str(total_count),
        "kind": "mixed" if mixed else dominant_kind,
        "display_kind": dominant_kind,
        "scope": "children",
        "count": total_count,
        "title": f"{total_count} changed descendants: {', '.join(title_parts)}",
    }


def collect_preview_source_git_info(
    repo_root: Path,
    relative_path: str,
    exact_git_status: dict[str, dict],
) -> dict | None:
    """Return per-line git diff metadata for one preview target when available."""
    file_git_status = exact_git_status.get(relative_path)
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
