#!/usr/bin/env python3
"""Generate raw repository tree payloads and Python symbol previews."""

from __future__ import annotations

import argparse
import ast
import hashlib
import html
import json
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


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
    total_nodes: int
    python_files: int


def should_track_repo_path(relative_path: str) -> bool:
    """Return whether one repo-relative path can affect visible tree content or git badges."""
    return bool(relative_path and Path(relative_path).name.lower() != ".ds_store")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = build_tree_payload(args.repo_root)
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_tree_payload(repo_root: str | Path) -> dict:
    repo_root_path = Path(repo_root).resolve()
    exact_git_status, directory_git_status = _collect_git_status(repo_root_path)
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
    repo_root_path = Path(repo_root).resolve()
    target_path, normalized_relative_path = _resolve_preview_target(
        repo_root=repo_root_path,
        relative_path=relative_path,
    )
    exact_git_status, _ = _collect_git_status(repo_root_path)
    preview_source_git_info = _collect_preview_source_git_info(
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
    payload["source_signature"] = _build_source_signature(target_path)
    return payload


def build_python_symbol_payload(repo_root: str | Path, relative_path: str) -> dict:
    repo_root_path = Path(repo_root).resolve()
    target_path, normalized_relative_path = _resolve_preview_target(
        repo_root=repo_root_path,
        relative_path=relative_path,
    )
    if not _is_python_file(normalized_relative_path):
        raise ValueError(f"path is not a Python file: {normalized_relative_path}")

    payload = _build_python_symbol_preview(target_path, normalized_relative_path)
    payload["source_signature"] = _build_source_signature(target_path)
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


def _build_python_symbol_preview(
    path: Path,
    relative_path: str,
) -> dict:
    source = path.read_text(encoding="utf-8")
    source_lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        node = {
            "id": f"module::{relative_path}",
            "name": path.name,
            "kind": "module",
            "path": relative_path,
            "summary": f"Python module with parse error: {exc.msg}",
            "symbol_nodes": [
                _build_whole_file_symbol_node(
                    symbol_id="module",
                    kind="module",
                    title=relative_path,
                    summary=f"Python module with parse error: {exc.msg}",
                    line_count=max(1, len(source_lines)),
                )
            ],
            "symbol_mermaid": _render_parse_error_mermaid(relative_path, exc.msg),
            "symbol_outline_xml": _render_parse_error_outline_xml(relative_path, exc.msg),
        }
        return node

    module_doc = _first_line(ast.get_docstring(tree))
    classes: list[ast.ClassDef] = []
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef] = []
    main_guard: ast.If | None = None

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            classes.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node)
        elif _is_main_guard(node):
            main_guard = node

    node = {
        "id": f"module::{relative_path}",
        "name": path.name,
        "kind": "module",
        "path": relative_path,
        "summary": module_doc or "Python module",
        "symbol_nodes": _build_module_symbol_nodes(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
            source_line_count=max(1, len(source_lines)),
        ),
        "symbol_mermaid": _render_module_symbol_mermaid(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
        ),
        "symbol_outline_xml": _render_module_outline_xml(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
            main_guard=main_guard,
        ),
    }
    return node


def _build_raw_file_preview(
    path: Path,
    relative_path: str,
    exact_git_status: dict[str, dict],
    source_git_info: dict | None,
) -> dict:
    if _is_binary_file(path):
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


def _resolve_preview_target(repo_root: Path, relative_path: str) -> tuple[Path, str]:
    normalized_relative_path = relative_path.strip().strip("/")
    if not normalized_relative_path:
        raise ValueError("path must be a non-empty repo-relative path")

    target_path = (repo_root / normalized_relative_path).resolve()
    if not target_path.is_relative_to(repo_root):
        raise ValueError(f"path must stay inside repo root: {relative_path}")
    if not target_path.is_file():
        raise ValueError(f"path is not a file: {relative_path}")

    return target_path, target_path.relative_to(repo_root).as_posix()


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


def _build_whole_file_symbol_node(
    *,
    symbol_id: str,
    kind: str,
    title: str,
    summary: str,
    line_count: int,
) -> dict:
    return {
        "id": symbol_id,
        "kind": kind,
        "title": title,
        "summary": summary,
        "line": 1,
        "line_end": max(1, line_count),
    }


def _is_python_file(relative_path: str) -> bool:
    return Path(relative_path).suffix.lower() == PYTHON_FILE_SUFFIX


def _is_binary_file(path: Path) -> bool:
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


def _build_source_signature(path: Path) -> str:
    stat_result = path.stat()
    return f"{stat_result.st_mtime_ns}:{stat_result.st_size}"


def _first_line(text: str | None) -> str | None:
    if not text:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def _count_stats(nodes: list[dict]) -> Stats:
    total_nodes = 0
    python_files = 0

    def walk(node_list: list[dict]) -> None:
        nonlocal total_nodes, python_files
        for node in node_list:
            total_nodes += 1
            if node["kind"] == "file" and _is_python_file(node["path"]):
                python_files += 1
            children = node.get("children", [])
            if children:
                walk(children)

    walk(nodes)
    return Stats(total_nodes=total_nodes, python_files=python_files)


def _build_tree_signature(nodes: list[dict]) -> str:
    stable_json = json.dumps(nodes, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(stable_json.encode("utf-8")).hexdigest()


def _collect_git_status(repo_root: Path) -> tuple[dict[str, dict], dict[str, dict]]:
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
            kind = _git_status_kind_from_xy(parts[1])
            path = parts[8]
        elif record_type == "2":
            parts = entry.split(" ", 9)
            if len(parts) != 10:
                continue
            kind = _git_status_kind_from_xy(parts[1])
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

        if kind is None or not _should_include_git_status_path(path):
            continue

        exact_status[path] = _build_direct_git_status(kind)
        for ancestor in _git_status_ancestor_directories(path):
            directory_counters.setdefault(ancestor, Counter())[kind] += 1

    directory_status = {
        directory_path: _build_directory_git_status(counter)
        for directory_path, counter in directory_counters.items()
        if counter
    }
    return exact_status, directory_status


def _git_status_kind_from_xy(xy: str) -> str | None:
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


def _should_include_git_status_path(path: str) -> bool:
    relative_path = Path(path)

    for part in relative_path.parts[:-1]:
        if part in EXCLUDED_DIRS:
            return False
        if part.startswith(".") and part not in {".codex"}:
            return False
    return should_track_repo_path(relative_path.as_posix())


def _git_status_ancestor_directories(path: str) -> list[str]:
    relative_path = Path(path)
    ancestors = [""]
    parent_parts = relative_path.parts[:-1]
    for index in range(1, len(parent_parts) + 1):
        ancestors.append(Path(*parent_parts[:index]).as_posix())
    return ancestors


def _build_direct_git_status(kind: str) -> dict:
    meta = GIT_STATUS_META[kind]
    return {
        "code": meta["code"],
        "kind": kind,
        "scope": "direct",
        "count": 1,
        "title": meta["label"],
    }


def _build_directory_git_status(counter: Counter[str]) -> dict:
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


def _collect_preview_source_git_info(
    repo_root: Path,
    relative_path: str,
    exact_git_status: dict[str, dict],
) -> dict | None:
    file_git_status = exact_git_status.get(relative_path)
    if not file_git_status or file_git_status["kind"] == "untracked":
        return None

    diff_info = _build_source_git_info_from_diff(repo_root, relative_path)
    if diff_info["current"] or diff_info["deleted"]:
        return diff_info
    return None


def _build_source_git_info_from_diff(repo_root: Path, relative_path: str) -> dict:
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

    return _parse_source_git_info_from_patch(diff_text)


def _parse_source_git_info_from_patch(diff_text: str) -> dict:
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


def _render_parse_error_mermaid(module_path: str, error_message: str) -> str:
    module_label = _build_mermaid_label(module_path, "Python module")
    error_label = _build_mermaid_label("Parse error", error_message)
    return "\n".join(
        [
            "flowchart LR",
            "    classDef moduleNode fill:#f3eee2,stroke:#8b6f47,stroke-width:1.5px,color:#1b1814;",
            "    classDef errorNode fill:#fdeaea,stroke:#a12c2c,stroke-width:1.2px,color:#1b1814;",
            f'    module["{module_label}"]:::moduleNode',
            f'    parse_error["{error_label}"]:::errorNode',
            "    module --> parse_error",
        ]
    )


def _build_module_symbol_nodes(
    *,
    module_path: str,
    module_doc: str | None,
    classes: list[ast.ClassDef],
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef],
    source_line_count: int,
) -> list[dict]:
    symbol_nodes: list[dict] = [
        {
            "id": "module",
            "kind": "module",
            "title": module_path,
            "summary": module_doc or "Python module",
            "line": 1,
            "line_end": source_line_count,
        }
    ]

    for class_index, class_node in enumerate(classes):
        class_id = f"class_{class_index}"
        symbol_nodes.append(
            {
                "id": class_id,
                "kind": "class",
                "title": _render_class_title(class_node),
                "summary": _first_line(ast.get_docstring(class_node)) or "No docstring.",
                "line": class_node.lineno,
                "line_end": _node_end_lineno(class_node),
                "parent_id": "module",
            }
        )

        methods = [
            child for child in class_node.body
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
        ]
        for method_index, method_node in enumerate(methods):
            symbol_nodes.append(
                {
                    "id": f"{class_id}_method_{method_index}",
                    "kind": "method",
                    "title": _render_function_title(method_node),
                    "summary": _first_line(ast.get_docstring(method_node)) or "No docstring.",
                    "line": method_node.lineno,
                    "line_end": _node_end_lineno(method_node),
                    "parent_id": class_id,
                }
            )

    for function_index, function_node in enumerate(functions):
        symbol_nodes.append(
            {
                "id": f"function_{function_index}",
                "kind": "function",
                "title": _render_function_title(function_node),
                "summary": _first_line(ast.get_docstring(function_node)) or "No docstring.",
                "line": function_node.lineno,
                "line_end": _node_end_lineno(function_node),
                "parent_id": "module",
            }
        )

    return symbol_nodes


def _render_parse_error_outline_xml(module_path: str, error_message: str) -> str:
    return "\n".join(
        [
            "<module_outline>",
            f"  <path>{_xml_text(module_path)}</path>",
            "  <module_summary>Python module with parse error.</module_summary>",
            f"  <parse_error>{_xml_text(error_message)}</parse_error>",
            "</module_outline>",
        ]
    )


def _render_module_symbol_mermaid(
    *,
    module_path: str,
    module_doc: str | None,
    classes: list[ast.ClassDef],
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef],
) -> str:
    lines: list[str] = [
        "flowchart LR",
        "    classDef moduleNode fill:#f3eee2,stroke:#8b6f47,stroke-width:1.5px,color:#1b1814;",
        "    classDef classNode fill:#e8f1ff,stroke:#28569c,stroke-width:1.2px,color:#1b1814;",
        "    classDef functionNode fill:#edf7ef,stroke:#0f704b,stroke-width:1.2px,color:#1b1814;",
        "    classDef methodNode fill:#fff6e6,stroke:#a95c12,stroke-width:1.2px,color:#1b1814;",
        "    classDef noteNode fill:#f8f7f4,stroke:#8a8175,stroke-dasharray: 4 4,color:#1b1814;",
    ]

    module_label = _build_mermaid_label(module_path, module_doc or "Python module")
    lines.append(f'    module["{module_label}"]:::moduleNode')

    if not classes and not functions:
        lines.append('    empty["No top-level classes or functions found."]:::noteNode')
        lines.append("    module --> empty")
        return "\n".join(lines)

    for class_index, class_node in enumerate(classes):
        class_id = f"class_{class_index}"
        class_label = _build_mermaid_label(
            _render_class_title(class_node),
            _first_line(ast.get_docstring(class_node)),
        )
        lines.append(f'    {class_id}["{class_label}"]:::classNode')
        lines.append(f"    module --> {class_id}")

        methods = [
            child for child in class_node.body
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
        ]
        if not methods:
            continue

        for method_index, method_node in enumerate(methods):
            method_id = f"{class_id}_method_{method_index}"
            method_label = _build_mermaid_label(
                _render_function_title(method_node),
                _first_line(ast.get_docstring(method_node)),
            )
            lines.append(f'    {method_id}["{method_label}"]:::methodNode')
            lines.append(f"    {class_id} --> {method_id}")

    for function_index, function_node in enumerate(functions):
        function_id = f"function_{function_index}"
        function_label = _build_mermaid_label(
            _render_function_title(function_node),
            _first_line(ast.get_docstring(function_node)),
        )
        lines.append(f'    {function_id}["{function_label}"]:::functionNode')
        lines.append(f"    module --> {function_id}")

    return "\n".join(lines)


def _render_module_outline_xml(
    *,
    module_path: str,
    module_doc: str | None,
    classes: list[ast.ClassDef],
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef],
    main_guard: ast.If | None,
) -> str:
    lines: list[str] = [
        "<module_outline>",
        f"  <path>{_xml_text(module_path)}</path>",
        f"  <module_summary>{_xml_text(module_doc or 'Python module')}</module_summary>",
    ]

    lines.append("  <classes>")
    for class_node in classes:
        lines.extend(_render_class_outline_xml(class_node, indent="    "))
    lines.append("  </classes>")

    lines.append("  <functions>")
    for function_node in functions:
        lines.extend(_render_function_outline_xml(function_node, indent="    ", tag_name="function"))
    lines.append("  </functions>")

    if main_guard is not None:
        lines.extend(_render_main_guard_outline_xml(main_guard, indent="  "))

    lines.append("</module_outline>")
    return "\n".join(lines)


def _render_main_guard_outline_xml(main_guard: ast.If, *, indent: str) -> list[str]:
    classes = [
        node for node in main_guard.body
        if isinstance(node, ast.ClassDef)
    ]
    functions = [
        node for node in main_guard.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]

    lines = [
        f'{indent}<main_guard condition="__name__ == \'__main__\'">',
        f"{indent}  <classes>",
    ]
    for class_node in classes:
        lines.extend(_render_class_outline_xml(class_node, indent=f"{indent}    "))
    lines.append(f"{indent}  </classes>")

    lines.append(f"{indent}  <functions>")
    for function_node in functions:
        lines.extend(_render_function_outline_xml(function_node, indent=f"{indent}    ", tag_name="function"))
    lines.append(f"{indent}  </functions>")
    lines.append(f"{indent}</main_guard>")
    return lines


def _render_class_outline_xml(class_node: ast.ClassDef, *, indent: str) -> list[str]:
    lines = [
        f"{indent}<class>",
        f"{indent}  <signature>{_xml_text(_render_class_title(class_node))}</signature>",
        f"{indent}  <summary>{_xml_text(_first_line(ast.get_docstring(class_node)) or 'No docstring.')}</summary>",
        f"{indent}  <methods>",
    ]

    methods = [
        child for child in class_node.body
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    for method_node in methods:
        lines.extend(_render_function_outline_xml(method_node, indent=f"{indent}    ", tag_name="method"))

    lines.extend(
        [
            f"{indent}  </methods>",
            f"{indent}</class>",
        ]
    )
    return lines


def _render_function_outline_xml(
    function_node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    indent: str,
    tag_name: str,
) -> list[str]:
    return [
        f"{indent}<{tag_name}>",
        f"{indent}  <signature>{_xml_text(_render_function_title(function_node))}</signature>",
        f"{indent}  <summary>{_xml_text(_first_line(ast.get_docstring(function_node)) or 'No docstring.')}</summary>",
        f"{indent}</{tag_name}>",
    ]


def _render_class_title(class_node: ast.ClassDef) -> str:
    if not class_node.bases:
        return f"class {class_node.name}"

    bases = ", ".join(_safe_unparse(base) for base in class_node.bases)
    return f"class {class_node.name}({bases})"


def _render_function_title(function_node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    prefix = "async def" if isinstance(function_node, ast.AsyncFunctionDef) else "def"
    arg_names = _render_argument_names(function_node.args)
    return f"{prefix} {function_node.name}({arg_names})"


def _render_argument_names(args: ast.arguments) -> str:
    parts: list[str] = []
    positional = [*args.posonlyargs, *args.args]
    parts.extend(arg.arg for arg in positional)

    if args.vararg is not None:
        parts.append(f"*{args.vararg.arg}")
    elif args.kwonlyargs:
        parts.append("*")

    parts.extend(arg.arg for arg in args.kwonlyargs)

    if args.kwarg is not None:
        parts.append(f"**{args.kwarg.arg}")

    return ", ".join(parts)


def _safe_unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "..."


def _node_end_lineno(node: ast.AST) -> int:
    end_lineno = getattr(node, "end_lineno", None)
    if isinstance(end_lineno, int) and end_lineno >= 1:
        return end_lineno
    lineno = getattr(node, "lineno", 1)
    return lineno if isinstance(lineno, int) and lineno >= 1 else 1


def _escape_mermaid_html_text(value: str) -> str:
    return (
        html.escape(value, quote=True)
        .replace("{", "&#123;")
        .replace("}", "&#125;")
    )


def _build_mermaid_label(title: str, summary: str | None = None) -> str:
    lines = [f"<span class='symbol-title'>{_escape_mermaid_html_text(title)}</span>"]
    if summary:
        lines.append(f"<span class='symbol-doc'>{_escape_mermaid_html_text(summary)}</span>")
    return "<br/>".join(lines)


def _xml_text(value: str) -> str:
    return html.escape(value, quote=False)


def _is_main_guard(node: ast.AST) -> bool:
    if not isinstance(node, ast.If):
        return False

    test = node.test
    if not isinstance(test, ast.Compare):
        return False
    if len(test.ops) != 1 or len(test.comparators) != 1:
        return False
    if not isinstance(test.ops[0], ast.Eq):
        return False
    if not isinstance(test.left, ast.Name) or test.left.id != "__name__":
        return False

    comparator = test.comparators[0]
    return isinstance(comparator, ast.Constant) and comparator.value == "__main__"


if __name__ == "__main__":
    main()
