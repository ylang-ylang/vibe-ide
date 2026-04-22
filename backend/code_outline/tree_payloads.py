"""Repository tree payloads and raw file preview payloads."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .common import (
    EXCLUDED_DIRS,
    Stats,
    build_source_signature,
    is_binary_file,
    is_python_file,
    resolve_preview_target,
)
from .git_status import collect_git_status, collect_preview_source_git_info


def build_tree_payload(repo_root: str | Path) -> dict:
    """Build the raw repository tree payload used by the frontend tree panel."""
    repo_root_path = Path(repo_root).resolve()
    exact_git_status, directory_git_status = collect_git_status(repo_root_path)
    nodes = [
        _build_directory_node(
            repo_root_path,
            repo_root_path.name,
            exact_git_status,
            directory_git_status,
        )
    ]
    stats = _count_stats(nodes)
    tree_signature = _build_tree_signature(nodes)
    return {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "repo_root": repo_root_path.name,
            "repo_root_path": str(repo_root_path),
            "python_files": stats.python_files,
            "total_nodes": stats.total_nodes,
            "tree_signature": tree_signature,
        },
        "nodes": nodes,
    }


def build_preview_payload(repo_root: str | Path, relative_path: str) -> dict:
    """Build the raw file preview payload for one repo-relative file path."""
    repo_root_path = Path(repo_root).resolve()
    target_path, normalized_relative_path = resolve_preview_target(
        repo_root=repo_root_path,
        relative_path=relative_path,
    )
    exact_git_status, _ = collect_git_status(repo_root_path)
    preview_source_git_info = collect_preview_source_git_info(
        repo_root_path,
        normalized_relative_path,
        exact_git_status,
    )

    payload = _build_raw_file_preview(
        target_path,
        normalized_relative_path,
        exact_git_status,
        preview_source_git_info,
    )
    payload["source_signature"] = build_source_signature(target_path)
    return payload


def _build_directory_node(
    path: Path,
    repo_name: str,
    exact_git_status: dict[str, dict],
    directory_git_status: dict[str, dict],
) -> dict:
    children = _build_directory_children(
        path,
        repo_root=path,
        exact_git_status=exact_git_status,
        directory_git_status=directory_git_status,
    )
    node = {
        "id": f"directory::{repo_name}",
        "name": repo_name,
        "kind": "directory",
        "path": repo_name,
        "summary": "Repository root",
        "child_count": len(children),
        "children": children,
    }
    root_git_status = directory_git_status.get("")
    if root_git_status:
        node["git_status"] = root_git_status
    return node


def _build_directory_children(
    directory: Path,
    repo_root: Path,
    exact_git_status: dict[str, dict],
    directory_git_status: dict[str, dict],
) -> list[dict]:
    children: list[dict] = []
    for entry in sorted(_iter_entries(directory), key=lambda item: (not item.is_dir(), item.name.lower())):
        if entry.is_dir():
            if _should_skip_directory(entry):
                continue
            nested_children = _build_directory_children(
                entry,
                repo_root=repo_root,
                exact_git_status=exact_git_status,
                directory_git_status=directory_git_status,
            )
            relative_path = entry.relative_to(repo_root).as_posix()
            node = {
                "id": f"directory::{relative_path}",
                "name": entry.name,
                "kind": "directory",
                "path": relative_path,
                "summary": "Directory",
                "child_count": len(nested_children),
                "children": nested_children,
            }
            directory_status = directory_git_status.get(relative_path)
            if directory_status:
                node["git_status"] = directory_status
            children.append(node)
            continue

        relative_path = entry.relative_to(repo_root).as_posix()
        children.append(
            _build_file_tree_node(
                entry,
                relative_path,
                exact_git_status,
            )
        )
    return children


def _iter_entries(directory: Path) -> Iterable[Path]:
    try:
        return list(directory.iterdir())
    except PermissionError:
        return []


def _should_skip_directory(path: Path) -> bool:
    if path.name in EXCLUDED_DIRS:
        return True
    if path.name.startswith(".") and path.name not in {".codex"}:
        return True
    return False


def _build_file_tree_node(
    path: Path,
    relative_path: str,
    exact_git_status: dict[str, dict],
) -> dict:
    node = {
        "id": f"file::{relative_path}",
        "name": path.name,
        "kind": "file",
        "path": relative_path,
        "summary": "File",
        "child_count": 0,
    }
    file_git_status = exact_git_status.get(relative_path)
    if file_git_status:
        node["git_status"] = file_git_status
    return node


def _build_raw_file_preview(
    path: Path,
    relative_path: str,
    exact_git_status: dict[str, dict],
    source_git_info: dict | None,
) -> dict:
    if is_binary_file(path):
        node = {
            "id": f"file::{relative_path}",
            "name": path.name,
            "kind": "file",
            "path": relative_path,
            "summary": "Binary file",
            "content_kind": "binary",
            "size_bytes": path.stat().st_size,
        }
        file_git_status = exact_git_status.get(relative_path)
        if file_git_status:
            node["git_status"] = file_git_status
        return node

    source = path.read_text(encoding="utf-8", errors="replace")
    source_lines = source.splitlines()
    node = {
        "id": f"file::{relative_path}",
        "name": path.name,
        "kind": "file",
        "path": relative_path,
        "summary": "Text file",
        "content_kind": "text",
        "source_text": source,
    }
    _attach_source_metadata(
        node=node,
        relative_path=relative_path,
        exact_git_status=exact_git_status,
        source_line_count=max(1, len(source_lines)),
        source_git_info=source_git_info,
    )
    return node


def _attach_source_metadata(
    *,
    node: dict,
    relative_path: str,
    exact_git_status: dict[str, dict],
    source_line_count: int,
    source_git_info: dict | None,
) -> None:
    file_git_status = exact_git_status.get(relative_path)
    if not file_git_status:
        return

    node["git_status"] = file_git_status
    if file_git_status["kind"] == "untracked":
        node["source_git_info"] = {
            "current": [
                {"line": line_number, "kind": "added"}
                for line_number in range(1, source_line_count + 1)
            ],
            "deleted": [],
        }
    elif source_git_info:
        node["source_git_info"] = source_git_info


def _count_stats(nodes: list[dict]) -> Stats:
    total_nodes = 0
    python_files = 0

    def walk(node_list: list[dict]) -> None:
        nonlocal total_nodes, python_files
        for node in node_list:
            total_nodes += 1
            if node["kind"] == "file" and is_python_file(node["path"]):
                python_files += 1
            children = node.get("children", [])
            if children:
                walk(children)

    walk(nodes)
    return Stats(total_nodes=total_nodes, python_files=python_files)


def _build_tree_signature(nodes: list[dict]) -> str:
    stable_json = json.dumps(nodes, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(stable_json.encode("utf-8")).hexdigest()
