#!/usr/bin/env python3
"""Generate a real repository tree with Python symbol summaries for the MVP."""

from __future__ import annotations

import argparse
import ast
import json
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
    "common_assets",
    "node_modules",
    "roboverse_root_legacy_20260420",
    "third_party",
}

INCLUDED_FILE_SUFFIXES = {
    ".json",
    ".md",
    ".py",
    ".toml",
    ".yaml",
    ".yml",
}


@dataclass(frozen=True, slots=True)
class Stats:
    total_nodes: int
    python_files: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    output_path = Path(args.output).resolve()

    nodes = [_build_directory_node(repo_root, repo_root.name)]
    stats = _count_stats(nodes)
    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "repo_root": repo_root.name,
            "python_files": stats.python_files,
            "total_nodes": stats.total_nodes,
        },
        "nodes": nodes,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_directory_node(path: Path, repo_name: str) -> dict:
    children = _build_directory_children(path, repo_root=path)
    return {
        "id": f"directory::{repo_name}",
        "name": repo_name,
        "kind": "directory",
        "path": repo_name,
        "summary": "Repository root",
        "child_count": len(children),
        "children": children,
    }


def _build_directory_children(directory: Path, repo_root: Path) -> list[dict]:
    children: list[dict] = []
    for entry in sorted(_iter_entries(directory), key=lambda item: (not item.is_dir(), item.name.lower())):
        if entry.is_dir():
            if _should_skip_directory(entry):
                continue
            nested_children = _build_directory_children(entry, repo_root=repo_root)
            if not nested_children:
                continue
            relative_path = entry.relative_to(repo_root).as_posix()
            children.append(
                {
                    "id": f"directory::{relative_path}",
                    "name": entry.name,
                    "kind": "directory",
                    "path": relative_path,
                    "summary": "Directory",
                    "child_count": len(nested_children),
                    "children": nested_children,
                }
            )
            continue

        if entry.suffix not in INCLUDED_FILE_SUFFIXES:
            continue

        relative_path = entry.relative_to(repo_root).as_posix()
        if entry.suffix == ".py":
            children.append(_build_python_module_node(entry, relative_path))
        else:
            children.append(
                {
                    "id": f"file::{relative_path}",
                    "name": entry.name,
                    "kind": "file",
                    "path": relative_path,
                    "summary": f"{entry.suffix[1:].upper()} file",
                    "child_count": 0,
                }
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


def _build_python_module_node(path: Path, relative_path: str) -> dict:
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return {
            "id": f"module::{relative_path}",
            "name": path.name,
            "kind": "module",
            "path": relative_path,
            "summary": f"Python module with parse error: {exc.msg}",
            "line": exc.lineno or 1,
            "child_count": 0,
            "symbol_text": f"{path.name}\n└── Parse error: {exc.msg}",
        }

    module_doc = _first_line(ast.get_docstring(tree))
    classes: list[ast.ClassDef] = []
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef] = []

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            classes.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node)

    return {
        "id": f"module::{relative_path}",
        "name": path.name,
        "kind": "module",
        "path": relative_path,
        "summary": module_doc or "Python module",
        "line": 1,
        "child_count": len(classes) + len(functions),
        "symbol_text": _render_module_symbol_text(
            module_name=path.name,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
        ),
    }


def _build_class_node(node: ast.ClassDef, relative_path: str) -> dict:
    methods: list[dict] = []
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods.append(_build_function_node(child, relative_path, kind="method", parent=node.name))

    return {
        "id": f"class::{relative_path}:{node.name}:{node.lineno}",
        "name": node.name,
        "kind": "class",
        "path": relative_path,
        "line": node.lineno,
        "summary": _first_line(ast.get_docstring(node)) or "Class",
        "child_count": len(methods),
        "children": methods,
    }


def _build_function_node(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    relative_path: str,
    *,
    kind: str,
    parent: str | None = None,
) -> dict:
    qualified_name = f"{parent}.{node.name}" if parent else node.name
    return {
        "id": f"{kind}::{relative_path}:{qualified_name}:{node.lineno}",
        "name": node.name,
        "kind": kind,
        "path": relative_path,
        "line": node.lineno,
        "summary": _first_line(ast.get_docstring(node)) or kind.capitalize(),
        "child_count": 0,
    }


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
            if node["kind"] == "module":
                python_files += 1
            children = node.get("children", [])
            if children:
                walk(children)

    walk(nodes)
    return Stats(total_nodes=total_nodes, python_files=python_files)


def _render_module_symbol_text(
    *,
    module_name: str,
    module_doc: str | None,
    classes: list[ast.ClassDef],
    functions: list[ast.FunctionDef | ast.AsyncFunctionDef],
) -> str:
    lines: list[str] = [module_name]

    sections: list[tuple[str, list[tuple[str, str | None, list[tuple[str, str | None]]]]]] = []

    if classes:
        class_items: list[tuple[str, str | None, list[tuple[str, str | None]]]] = []
        for class_node in classes:
            methods: list[tuple[str, str | None]] = []
            for child in class_node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append((f"{child.name}()", _first_line(ast.get_docstring(child))))
            class_items.append((class_node.name, _first_line(ast.get_docstring(class_node)), methods))
        sections.append(("Classes", class_items))

    if functions:
        function_items = [
            (f"{func.name}()", _first_line(ast.get_docstring(func)), [])
            for func in functions
        ]
        sections.append(("Functions", function_items))

    if module_doc:
        lines.append(f"├── Module: {module_doc}")

    if not sections:
        lines.append("└── No top-level classes or functions found.")
        return "\n".join(lines)

    for section_index, (section_name, items) in enumerate(sections):
        section_is_last = section_index == len(sections) - 1
        section_prefix = "└──" if section_is_last else "├──"
        lines.append(f"{section_prefix} {section_name}")
        child_indent = "    " if section_is_last else "│   "

        for item_index, (item_name, item_doc, nested_items) in enumerate(items):
            item_is_last = item_index == len(items) - 1
            item_prefix = "└──" if item_is_last else "├──"
            summary = item_doc or "No docstring."
            lines.append(f"{child_indent}{item_prefix} {item_name}: {summary}")

            nested_indent = f"{child_indent}{'    ' if item_is_last else '│   '}"
            for nested_index, (nested_name, nested_doc) in enumerate(nested_items):
                nested_is_last = nested_index == len(nested_items) - 1
                nested_prefix = "└──" if nested_is_last else "├──"
                nested_summary = nested_doc or "No docstring."
                lines.append(f"{nested_indent}{nested_prefix} {nested_name}: {nested_summary}")

    return "\n".join(lines)


if __name__ == "__main__":
    main()
