# TODO

## Current Baseline

- Tree view with git status badges and `changes only`
- Python symbol extraction via `ast`
- Mermaid preview plus source code preview
- XML outline copy for Python modules
- Mermaid translation through the local translator service

## LSP / DocumentSymbol as Symbol Extraction Backend

Status: todo

Goal:
- Evaluate replacing the current Python-only `ast` symbol extraction with an LSP `textDocument/documentSymbol` based adapter.

Why:
- Current symbol extraction in `tools/generate_symbol_tree.py` is Python-specific.
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
