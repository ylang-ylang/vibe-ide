# TODO

## Current Baseline

- Tree view with git status badges and `changes only`
- Python symbol extraction via `ast`
- Mermaid preview plus source code preview
- XML outline copy for Python modules
- Mermaid translation through the local translator service

## Python Script-Flow Extraction

Status: todo

Goal:
- Extend the current Python symbol extraction so script-style files are not reduced to only `class` / `def` declarations.

Why:
- Current `ast` extraction mainly captures declarations and one `__main__` guard node.
- Non-declaration statements such as `if`, `for`, `while`, `try`, assignments, and call flow are mostly dropped.
- This makes entry scripts and demo scripts look structurally incomplete in Mermaid and XML outline.

Scope:
- Keep the current declaration extraction.
- Add a lightweight `script_flow` view for `__main__` and other statement-heavy sections.
- Improve Mermaid and XML outline output for script-oriented Python files.

## LSP / DocumentSymbol as Symbol Extraction Backend

Status: todo

Goal:
- Evaluate replacing the current Python-only `ast` symbol extraction with an LSP `textDocument/documentSymbol` based adapter.

Why:
- Current symbol extraction in `backend/code_outline/mermaid/python_symbols.py` is Python-specific.
- LSP could generalize symbol extraction across multiple code languages.
- This may reduce per-language custom parser work.

Scope:
- Replace or abstract the current `source -> symbol tree` extraction layer.
- Keep repo scan, git status aggregation, Mermaid rendering, XML outline rendering, and frontend preview flow unchanged.
- Treat LSP as a replacement candidate for Python `ast` symbol extraction, not for the whole tree pipeline.

Known caveats:
- Standard `DocumentSymbol` may not cover custom Python-specific semantics such as `__main__` guard and custom `script_flow`.
- A small amount of language-specific post-processing may still be needed.

Later implementation questions:
- Choose `LSP-first` vs mixed adapter architecture.
- Decide fallback behavior when no language server is available.
- Define a normalized symbol schema independent of parser backend.
