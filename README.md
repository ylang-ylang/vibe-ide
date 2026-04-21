# Repo Symbol Tree

Interactive repository tree for Python-heavy codebases.

This tool scans a repository with Python `ast`, builds a compact tree, and lets you click one
file to preview source. For `.py` files it also renders a Mermaid module flowchart and copies an
XML outline based on module, class, function, method, and docstring first-line data.

## Run

```bash
npm install
npm run dev
```

`npm install` now includes the Mermaid renderer used by the module preview panel.

If you already have an old dev session running and hit `Address already in use`, use:

```bash
npm run stop
npm run dev
```

or in one command:

```bash
npm run dev:fresh
```

This starts:

- a local Python API server on `127.0.0.1:8765`
- a local symbol translation server on `127.0.0.1:8766`
- a Vite frontend on `127.0.0.1:4174`

Open the Vite URL in your browser. The UI will:

- scan the current user's home directory for git repos
- let you choose one repo root
- remember the last selected repo root on disk

The remembered selection is stored at:

```bash
~/.config/repo-symbol-tree/state.json
```

## Build And Serve

```bash
npm run build
npm run serve
```

This starts the built frontend API on `127.0.0.1:8765` and the separate symbol translation server on `127.0.0.1:8766`.

## AI Symbol Translation

The right-side panel can send the current Mermaid module flowchart to a local translation server.

Runtime flow:

- frontend sends only the current Mermaid flowchart to the same-origin path `/translate-api`
- in `npm run dev`, Vite proxies `/translate-api` to `127.0.0.1:8766`
- in `npm run serve`, `app_server` proxies `/translate-api` to `127.0.0.1:8766`
- `tools/symbol_translate_server.py` forwards that request to a local OpenAI-compatible proxy

Default upstream target:

```text
http://127.0.0.1:38080/v1/chat/completions
```

By default, the frontend always talks to the same-origin path `/translate-api`.
This avoids browser-direct access to port `8766` and keeps the hop between the page server and translator on the same machine.

Optional environment overrides:

```bash
export LLM_PROXY_BASE_URL=http://127.0.0.1:38080
export LLM_PROXY_MODEL=gpt-5.4-mini
export LLM_PROXY_API_KEY=
```

You can still override the frontend target explicitly:

```bash
export VITE_TRANSLATE_API_BASE_URL=http://127.0.0.1:8766
```

## Manual Tree Export

Generate a static tree payload for any repo root:

```bash
python3 tools/generate_symbol_tree.py \
  --repo-root /path/to/repo \
  --output public/tree-data.json
```

## Current Scope

- Real directory tree
- Git status badges and `changes only` filtering
- Python module detection
- Top-level class and function extraction
- Class method extraction
- Docstring first-line summaries
- Mermaid module flowchart preview for `.py` files
- Source code preview with syntax highlighting
- Click-to-copy XML module outline for `.py` files
- Click Mermaid nodes to inspect full source ranges
- AI translation that sends only the current Mermaid flowchart to a separate local translator service
- Repo root selection from the current user's home directory
- On-disk memory for the last selected repo root

## Preview Controls

- Tree toolbar: `expand`, `collapse`, `changes only`
- Mermaid panel: wheel to zoom, left drag to pan
- Mermaid selection: click node to inspect, right double-click empty area to clear

## License

Apache License 2.0. See [LICENSE](./LICENSE).
