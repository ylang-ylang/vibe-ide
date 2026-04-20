#!/usr/bin/env python3
"""Generate repository tree payloads with Python module summaries."""

from __future__ import annotations

import argparse
import ast
import json
import html
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
    payload = build_tree_payload(args.repo_root)
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build_tree_payload(repo_root: str | Path) -> dict:
    repo_root_path = Path(repo_root).resolve()
    nodes = [_build_directory_node(repo_root_path, repo_root_path.name)]
    stats = _count_stats(nodes)
    return {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "repo_root": repo_root_path.name,
            "repo_root_path": str(repo_root_path),
            "python_files": stats.python_files,
            "total_nodes": stats.total_nodes,
        },
        "nodes": nodes,
    }


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
            "symbol_mermaid": _render_parse_error_mermaid(relative_path, exc.msg),
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
        "symbol_mermaid": _render_module_symbol_mermaid(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
        ),
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


def _build_mermaid_label(title: str, summary: str | None = None) -> str:
    lines = [title]
    if summary:
        lines.append(summary)
    escaped_lines = [
        html.escape(line, quote=True)
        .replace("{", "&#123;")
        .replace("}", "&#125;")
        for line in lines
    ]
    return "<br/>".join(escaped_lines)


if __name__ == "__main__":
    main()
