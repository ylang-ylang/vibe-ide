#!/usr/bin/env python3
"""Serve repo-symbol-tree APIs and optional built static assets."""

from __future__ import annotations

import argparse
import json
import os
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from generate_symbol_tree import build_tree_payload


API_PORT = 8765
DEFAULT_TRANSLATE_SERVER_BASE_URL = "http://127.0.0.1:8766"
MAX_SCAN_DEPTH = 5
SKIP_SCAN_DIRS = {
    ".cache",
    ".cargo",
    ".config",
    ".conda",
    ".git",
    ".local",
    ".npm",
    ".nv",
    ".venv",
    "__pycache__",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Videos",
    "build",
    "dist",
    "node_modules",
    "venv",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=API_PORT)
    parser.add_argument("--static-dir")
    return parser.parse_args()


class AppState:
    """Runtime state and filesystem helpers for the local tool server."""

    def __init__(self, static_dir: str | None = None) -> None:
        self.home_dir = Path.home().resolve()
        self.static_dir = Path(static_dir).resolve() if static_dir else None
        self.config_path = self._resolve_config_path()
        self.translate_server_base_url = os.environ.get(
            "TRANSLATE_SERVER_BASE_URL",
            DEFAULT_TRANSLATE_SERVER_BASE_URL,
        ).rstrip("/")
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

    def get_selected_repo_root(self) -> str | None:
        selected = self._read_config().get("selected_repo_root")
        if not selected:
            return None
        try:
            valid_path = self._validate_repo_root(selected)
        except ValueError:
            return None
        return str(valid_path)

    def set_selected_repo_root(self, repo_root: str) -> str:
        repo_root_path = self._validate_repo_root(repo_root)
        payload = {"selected_repo_root": str(repo_root_path)}
        self.config_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return str(repo_root_path)

    def list_repo_roots(self) -> list[dict[str, str]]:
        discovered: set[Path] = set()

        def walk(directory: Path, depth: int) -> None:
            if depth > MAX_SCAN_DEPTH:
                return
            try:
                entries = sorted(directory.iterdir(), key=lambda item: item.name.lower())
            except PermissionError:
                return

            if (directory / ".git").exists() and directory != self.home_dir:
                discovered.add(directory)
                return

            for entry in entries:
                if not entry.is_dir():
                    continue
                if self._should_skip_scan_dir(entry):
                    continue
                walk(entry, depth + 1)

        walk(self.home_dir, 0)
        return [
            {
                "path": str(path),
                "label": f"~/{path.relative_to(self.home_dir).as_posix()}",
                "name": path.name,
            }
            for path in sorted(discovered)
        ]

    def build_tree(self, repo_root: str) -> dict:
        return build_tree_payload(self._validate_repo_root(repo_root))

    def _resolve_config_path(self) -> Path:
        xdg_home = os.environ.get("XDG_CONFIG_HOME")
        if xdg_home:
            return Path(xdg_home).expanduser().resolve() / "repo-symbol-tree" / "state.json"
        return self.home_dir / ".config" / "repo-symbol-tree" / "state.json"

    def _read_config(self) -> dict:
        if not self.config_path.exists():
            return {}
        try:
            return json.loads(self.config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def _validate_repo_root(self, repo_root: str | Path) -> Path:
        path = Path(repo_root).expanduser().resolve()
        if not path.is_dir():
            raise ValueError(f"repo root is not a directory: {path}")
        if not path.is_relative_to(self.home_dir):
            raise ValueError(f"repo root must stay inside the current user home: {self.home_dir}")
        if not (path / ".git").exists():
            raise ValueError(f"repo root must contain .git: {path}")
        return path

    def _should_skip_scan_dir(self, path: Path) -> bool:
        if path.name in SKIP_SCAN_DIRS:
            return True
        if path.name.startswith(".") and path.name not in {".codex"}:
            return True
        return False


class RepoSymbolTreeHandler(SimpleHTTPRequestHandler):
    """Serve local APIs and optional built frontend assets."""

    server_version = "RepoSymbolTree/0.1"

    @property
    def app_state(self) -> AppState:
        return self.server.app_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)

        if parsed.path.startswith("/translate-api"):
            self._proxy_translate_request("GET")
            return

        if parsed.path == "/api/state":
            self._send_json(
                {
                    "home_dir": str(self.app_state.home_dir),
                    "selected_repo_root": self.app_state.get_selected_repo_root(),
                }
            )
            return

        if parsed.path == "/api/repo-roots":
            self._send_json({"repo_roots": self.app_state.list_repo_roots()})
            return

        if parsed.path == "/api/tree":
            repo_root = parse_qs(parsed.query).get("repo_root", [""])[0]
            if not repo_root:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing repo_root")
                return
            try:
                payload = self.app_state.build_tree(repo_root)
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
                return
            self._send_json(payload)
            return

        if self.app_state.static_dir is not None:
            super().do_GET()
            return

        self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown path: {parsed.path}")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/translate-api"):
            self._proxy_translate_request("POST")
            return

        if parsed.path != "/api/select-root":
            self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown path: {parsed.path}")
            return

        body = self._read_json_body()
        repo_root = body.get("repo_root")
        if not isinstance(repo_root, str) or not repo_root.strip():
            self._send_error_json(HTTPStatus.BAD_REQUEST, "repo_root must be a non-empty string")
            return

        try:
            selected_root = self.app_state.set_selected_repo_root(repo_root)
            payload = self.app_state.build_tree(selected_root)
        except ValueError as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return

        self._send_json(
            {
                "selected_repo_root": selected_root,
                "tree_payload": payload,
            }
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/translate-api"):
            self._proxy_translate_request("OPTIONS")
            return
        self.send_response(HTTPStatus.NO_CONTENT.value)
        self.end_headers()

    def translate_path(self, path: str) -> str:
        static_dir = self.app_state.static_dir
        if static_dir is None:
            return super().translate_path(path)

        parsed = urlparse(path)
        relative_path = parsed.path.lstrip("/") or "index.html"
        candidate = (static_dir / relative_path).resolve()
        if candidate.is_file() and candidate.is_relative_to(static_dir):
            return str(candidate)
        return str((static_dir / "index.html").resolve())

    def log_message(self, format: str, *args: object) -> None:
        return

    def _read_json_body(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)
        try:
            return json.loads(raw_body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _proxy_translate_request(self, method: str) -> None:
        parsed = urlparse(self.path)
        proxied_path = parsed.path.removeprefix("/translate-api") or "/"
        target_url = f"{self.app_state.translate_server_base_url}{proxied_path}"
        if parsed.query:
            target_url = f"{target_url}?{parsed.query}"

        body = None
        if method in {"POST", "PUT", "PATCH"}:
            content_length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(content_length)

        headers = {}
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type

        request = Request(target_url, data=body, headers=headers, method=method)

        try:
            with urlopen(request, timeout=60) as response:
                payload = response.read()
                response_headers = response.headers
                self._send_proxy_response(
                    status=response.status,
                    payload=payload,
                    content_type=response_headers.get("Content-Type", "application/json; charset=utf-8"),
                )
        except HTTPError as exc:
            payload = exc.read()
            self._send_proxy_response(
                status=exc.code,
                payload=payload,
                content_type=exc.headers.get("Content-Type", "application/json; charset=utf-8"),
            )
        except URLError as exc:
            self._send_error_json(
                HTTPStatus.BAD_GATEWAY,
                f"failed to reach local translator at {self.app_state.translate_server_base_url}: {exc.reason}",
            )

    def _send_proxy_response(self, *, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    args = parse_args()
    app_state = AppState(static_dir=args.static_dir)
    server = ThreadingHTTPServer((args.host, args.port), RepoSymbolTreeHandler)
    server.app_state = app_state  # type: ignore[attr-defined]
    print(f"repo-symbol-tree server listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
