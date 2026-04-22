"""Python AST-based symbol preview payloads and renderers."""

from __future__ import annotations

import ast
import html
from pathlib import Path

from ..git import collect_git_repo_state, collect_preview_source_git_info
from ..git.common import git_status_mermaid_style, git_status_meta_entry
from ..shared import build_source_signature, first_line, is_python_file, resolve_preview_target
from .blocks import load_mermaid_block_config


def build_python_symbol_payload(repo_root: str | Path, relative_path: str) -> dict:
    """Build the Python semantic preview payload for one repo-relative Python file."""
    repo_root_path = Path(repo_root).resolve()
    git_state = collect_git_repo_state(repo_root_path)
    target_path, normalized_relative_path = resolve_preview_target(
        repo_root=repo_root_path,
        relative_path=relative_path,
    )
    if not is_python_file(normalized_relative_path):
        raise ValueError(f"path is not a Python file: {normalized_relative_path}")

    preview_source_git_info = collect_preview_source_git_info(
        repo_root_path,
        normalized_relative_path,
        git_state.exact_status,
    )
    payload = _build_python_symbol_preview(
        target_path,
        normalized_relative_path,
        file_git_status=git_state.exact_status.get(normalized_relative_path),
        preview_source_git_info=preview_source_git_info,
    )
    payload["source_signature"] = build_source_signature(target_path)
    return payload


def _build_python_symbol_preview(
    path: Path,
    relative_path: str,
    *,
    file_git_status: dict | None,
    preview_source_git_info: dict | None,
) -> dict:
    source = path.read_text(encoding="utf-8")
    source_lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return {
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
            "symbol_mermaid": _render_parse_error_mermaid(
                relative_path,
                exc.msg,
                file_git_status_kind=_file_git_status_kind(file_git_status),
            ),
            "symbol_outline_xml": _render_parse_error_outline_xml(relative_path, exc.msg),
        }

    module_doc = first_line(ast.get_docstring(tree))
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

    symbol_nodes = _build_module_symbol_nodes(
        module_path=relative_path,
        module_doc=module_doc,
        classes=classes,
        functions=functions,
        source_line_count=max(1, len(source_lines)),
    )
    symbol_git_status_kinds = _build_symbol_git_status_kinds(
        symbol_nodes=symbol_nodes,
        file_git_status=file_git_status,
        preview_source_git_info=preview_source_git_info,
    )

    return {
        "id": f"module::{relative_path}",
        "name": path.name,
        "kind": "module",
        "path": relative_path,
        "summary": module_doc or "Python module",
        "symbol_nodes": _attach_symbol_git_status_kinds(symbol_nodes, symbol_git_status_kinds),
        "symbol_mermaid": _render_module_symbol_mermaid(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
            symbol_git_status_kinds=symbol_git_status_kinds,
        ),
        "symbol_outline_xml": _render_module_outline_xml(
            module_path=relative_path,
            module_doc=module_doc,
            classes=classes,
            functions=functions,
            main_guard=main_guard,
        ),
    }


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


def _render_parse_error_mermaid(
    module_path: str,
    error_message: str,
    *,
    file_git_status_kind: str | None,
) -> str:
    block_config = load_mermaid_block_config()
    module_label = _build_mermaid_label(module_path, "Python module")
    error_label = _build_mermaid_label("Parse error", error_message)
    return "\n".join(
        [
            "flowchart LR",
            *block_config.render_class_defs("module", "parse_error"),
            *block_config.render_node_lines(node_id="module", label=module_label, semantic_role="module"),
            *block_config.render_node_lines(node_id="parse_error", label=error_label, semantic_role="parse_error"),
            _render_mermaid_status_style(
                "module",
                file_git_status_kind or "neutral",
            ),
            _render_mermaid_status_style("parse_error", "error"),
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
                "summary": first_line(ast.get_docstring(class_node)) or "No docstring.",
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
                    "summary": first_line(ast.get_docstring(method_node)) or "No docstring.",
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
                "summary": first_line(ast.get_docstring(function_node)) or "No docstring.",
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
    symbol_git_status_kinds: dict[str, str],
) -> str:
    block_config = load_mermaid_block_config()
    lines: list[str] = [
        "flowchart LR",
        *block_config.render_class_defs("module", "class", "function", "method", "empty"),
    ]

    module_label = _build_mermaid_label(module_path, module_doc or "Python module")
    lines.extend(
        block_config.render_node_lines(node_id="module", label=module_label, semantic_role="module")
    )
    lines.append(_render_mermaid_status_style("module", symbol_git_status_kinds.get("module", "neutral")))

    if not classes and not functions:
        lines.extend(
            block_config.render_node_lines(
                node_id="empty",
                label="No top-level classes or functions found.",
                semantic_role="empty",
            )
        )
        lines.append(_render_mermaid_status_style("empty", "neutral"))
        lines.append("    module --> empty")
        return "\n".join(lines)

    for class_index, class_node in enumerate(classes):
        class_id = f"class_{class_index}"
        class_label = _build_mermaid_label(
            _render_class_title(class_node),
            first_line(ast.get_docstring(class_node)),
        )
        lines.extend(
            block_config.render_node_lines(node_id=class_id, label=class_label, semantic_role="class")
        )
        lines.append(_render_mermaid_status_style(class_id, symbol_git_status_kinds.get(class_id, "neutral")))
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
                first_line(ast.get_docstring(method_node)),
            )
            lines.extend(
                block_config.render_node_lines(node_id=method_id, label=method_label, semantic_role="method")
            )
            lines.append(_render_mermaid_status_style(method_id, symbol_git_status_kinds.get(method_id, "neutral")))
            lines.append(f"    {class_id} --> {method_id}")

    for function_index, function_node in enumerate(functions):
        function_id = f"function_{function_index}"
        function_label = _build_mermaid_label(
            _render_function_title(function_node),
            first_line(ast.get_docstring(function_node)),
        )
        lines.extend(
            block_config.render_node_lines(
                node_id=function_id,
                label=function_label,
                semantic_role="function",
            )
        )
        lines.append(_render_mermaid_status_style(function_id, symbol_git_status_kinds.get(function_id, "neutral")))
        lines.append(f"    module --> {function_id}")

    return "\n".join(lines)


def _render_mermaid_status_style(node_id: str, status_kind: str) -> str:
    style = git_status_mermaid_style(status_kind)
    style_parts = [
        f"stroke:{style.stroke}",
        f"stroke-width:{style.stroke_width}",
        f"color:{style.color}",
    ]
    if style.stroke_dasharray:
        style_parts.append(f"stroke-dasharray:{style.stroke_dasharray}")
    return f"    style {node_id} {','.join(style_parts)}"


def _file_git_status_kind(file_git_status: dict | None) -> str | None:
    if not file_git_status:
        return None
    kind = file_git_status.get("kind")
    return kind if isinstance(kind, str) and kind else None


def _attach_symbol_git_status_kinds(symbol_nodes: list[dict], symbol_git_status_kinds: dict[str, str]) -> list[dict]:
    attached_nodes: list[dict] = []
    for symbol_node in symbol_nodes:
        status_kind = symbol_git_status_kinds.get(symbol_node["id"])
        if status_kind:
            attached_nodes.append({**symbol_node, "git_status_kind": status_kind})
        else:
            attached_nodes.append(symbol_node)
    return attached_nodes


def _build_symbol_git_status_kinds(
    *,
    symbol_nodes: list[dict],
    file_git_status: dict | None,
    preview_source_git_info: dict | None,
) -> dict[str, str]:
    file_git_status_kind = _file_git_status_kind(file_git_status)
    if file_git_status_kind in {"conflicted", "deleted", "renamed", "copied", "typechanged", "untracked"}:
        return {
            symbol_node["id"]: file_git_status_kind
            for symbol_node in symbol_nodes
        }

    current_entries = list(preview_source_git_info.get("current", [])) if preview_source_git_info else []
    deleted_entries = list(preview_source_git_info.get("deleted", [])) if preview_source_git_info else []
    symbol_git_status_kinds: dict[str, str] = {}

    for symbol_node in symbol_nodes:
        line_start = max(1, int(symbol_node.get("line", 1)))
        line_end = max(line_start, int(symbol_node.get("line_end", line_start)))
        if symbol_node["id"] == "module":
            if file_git_status_kind:
                symbol_git_status_kinds["module"] = file_git_status_kind
            continue
        status_kind = _resolve_symbol_git_status_kind(
            line_start=line_start,
            line_end=line_end,
            file_git_status_kind=file_git_status_kind,
            current_entries=current_entries,
            deleted_entries=deleted_entries,
        )
        if status_kind:
            symbol_git_status_kinds[symbol_node["id"]] = status_kind

    if "module" not in symbol_git_status_kinds:
        symbol_git_status_kinds["module"] = file_git_status_kind or "neutral"
    return symbol_git_status_kinds


def _resolve_symbol_git_status_kind(
    *,
    line_start: int,
    line_end: int,
    file_git_status_kind: str | None,
    current_entries: list[dict],
    deleted_entries: list[dict],
) -> str | None:
    if file_git_status_kind in {"conflicted", "deleted", "renamed", "copied", "typechanged", "untracked"}:
        return file_git_status_kind

    matched_status_kinds: set[str] = set()

    for entry in current_entries:
        line_number = entry.get("line")
        status_kind = entry.get("kind")
        if isinstance(line_number, int) and isinstance(status_kind, str) and line_start <= line_number <= line_end:
            matched_status_kinds.add(status_kind)

    for entry in deleted_entries:
        before_line = entry.get("before_line")
        if isinstance(before_line, int) and line_start <= before_line <= line_end + 1:
            matched_status_kinds.add("deleted")

    if not matched_status_kinds:
        return file_git_status_kind if line_start == 1 else None

    if len(matched_status_kinds) == 1:
        return next(iter(matched_status_kinds))

    return max(
        matched_status_kinds,
        key=lambda status_kind: (git_status_meta_entry(status_kind).priority, status_kind),
    )


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
        f"{indent}  <summary>{_xml_text(first_line(ast.get_docstring(class_node)) or 'No docstring.')}</summary>",
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
        f"{indent}  <summary>{_xml_text(first_line(ast.get_docstring(function_node)) or 'No docstring.')}</summary>",
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
