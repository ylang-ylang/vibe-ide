# Repo Symbol Tree

Interactive repository tree for Python-heavy codebases.

This tool scans a repository with Python `ast`, builds a compact tree, and lets you click one
`.py` file to generate and copy an ASCII symbol summary based on module, class, function, method,
and docstring first-line data.

## Run

```bash
npm install
npm run dev
```

By default, the scanner reads the current repository root.

## Scan Another Repo

Generate data for another checkout:

```bash
python3 tools/generate_symbol_tree.py \
  --repo-root /path/to/repo \
  --output public/tree-data.json
```

Then run:

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Current Scope

- Real directory tree
- Python module detection
- Top-level class and function extraction
- Class method extraction
- Docstring first-line summaries
- Click-to-copy ASCII symbol summary for `.py` files
