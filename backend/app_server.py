#!/usr/bin/env python3
"""Serve repo-symbol-tree APIs and optional built static assets."""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from code_outline import (
    EXCLUDED_DIRS,
    build_preview_payload,
    build_python_symbol_payload,
    build_tree_payload,
    should_track_repo_path,
)

try:
    from watchfiles import watch
except ImportError:
    watch = None


API_PORT = 8765
DEFAULT_TRANSLATE_SERVER_BASE_URL = "http://127.0.0.1:8766"
LOGGER = logging.getLogger("repo_symbol_tree.app_server")
MAX_SCAN_DEPTH = 5
PREVIEW_WATCH_POLL_INTERVAL_SECONDS = 0.4
PREVIEW_WATCH_KEEPALIVE_SECONDS = 10.0
TREE_WATCH_POLL_INTERVAL_SECONDS = 1.0
TREE_WATCH_KEEPALIVE_SECONDS = 10.0
TREE_WATCH_DEBOUNCE_MS = 300
TREE_WATCH_RUST_TIMEOUT_MS = 5_000
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


class PreviewWatchDisconnectedError(ConnectionError):
    """Client closed the preview watch SSE connection."""


class TreeWatchDisconnectedError(ConnectionError):
    """Client closed the tree watch SSE connection."""


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

    def build_preview(self, repo_root: str, relative_path: str) -> dict:
        return build_preview_payload(self._validate_repo_root(repo_root), relative_path)

    def build_python_symbols(self, repo_root: str, relative_path: str) -> dict:
        return build_python_symbol_payload(self._validate_repo_root(repo_root), relative_path)

    def resolve_repo_root(self, repo_root: str | Path) -> Path:
        return self._validate_repo_root(repo_root)

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
        LOGGER.info("GET %s", self.path)

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

        if parsed.path == "/api/preview":
            repo_root = parse_qs(parsed.query).get("repo_root", [""])[0]
            relative_path = parse_qs(parsed.query).get("path", [""])[0]
            if not repo_root:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing repo_root")
                return
            if not relative_path:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing path")
                return
            try:
                payload = self.app_state.build_preview(repo_root, relative_path)
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
                return
            self._send_json(payload)
            return

        if parsed.path == "/api/python-symbol-preview":
            repo_root = parse_qs(parsed.query).get("repo_root", [""])[0]
            relative_path = parse_qs(parsed.query).get("path", [""])[0]
            if not repo_root:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing repo_root")
                return
            if not relative_path:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing path")
                return
            try:
                payload = self.app_state.build_python_symbols(repo_root, relative_path)
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
                return
            self._send_json(payload)
            return

        if parsed.path == "/api/watch-preview":
            repo_root = parse_qs(parsed.query).get("repo_root", [""])[0]
            relative_path = parse_qs(parsed.query).get("path", [""])[0]
            since_signature = parse_qs(parsed.query).get("since_signature", [""])[0]
            if not repo_root:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing repo_root")
                return
            if not relative_path:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing path")
                return
            try:
                self._stream_preview_watch(
                    repo_root=repo_root,
                    relative_path=relative_path,
                    since_signature=since_signature,
                )
            except PreviewWatchDisconnectedError:
                LOGGER.info("preview watch disconnected: %s", relative_path)
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return

        if parsed.path == "/api/watch-tree":
            repo_root = parse_qs(parsed.query).get("repo_root", [""])[0]
            since_signature = parse_qs(parsed.query).get("since_signature", [""])[0]
            if not repo_root:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "missing repo_root")
                return
            try:
                self._stream_tree_watch(
                    repo_root=repo_root,
                    since_signature=since_signature,
                )
            except TreeWatchDisconnectedError:
                LOGGER.info("tree watch disconnected: %s", repo_root)
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return

        if self.app_state.static_dir is not None:
            super().do_GET()
            return

        self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown path: {parsed.path}")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        LOGGER.info("POST %s", self.path)
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
            LOGGER.info("selected repo root: %s", selected_root)
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
        LOGGER.info("OPTIONS %s", self.path)
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
        LOGGER.info("%s - %s", self.address_string(), format % args)

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

    def _stream_preview_watch(
        self,
        *,
        repo_root: str,
        relative_path: str,
        since_signature: str,
    ) -> None:
        repo_root_path = self.app_state.resolve_repo_root(repo_root)
        initial_payload = self.app_state.build_preview(str(repo_root_path), relative_path)
        normalized_relative_path = initial_payload["path"]
        watched_path = (repo_root_path / normalized_relative_path).resolve()
        if not watched_path.is_relative_to(repo_root_path):
            raise ValueError(f"path must stay inside repo root: {normalized_relative_path}")
        if not watched_path.is_file():
            raise ValueError(f"path is not a file: {normalized_relative_path}")

        last_signature = self._read_preview_signature(watched_path)
        self._send_sse_headers()

        if since_signature and since_signature == last_signature:
            self._write_sse_event(
                "watch_ready",
                {
                    "path": normalized_relative_path,
                    "source_signature": last_signature,
                },
            )
        else:
            self._write_sse_event("preview", initial_payload)

        next_keepalive_at = time.monotonic() + PREVIEW_WATCH_KEEPALIVE_SECONDS
        while True:
            time.sleep(PREVIEW_WATCH_POLL_INTERVAL_SECONDS)
            current_signature = self._read_preview_signature(watched_path, allow_missing=True)
            if current_signature is None:
                self._write_sse_event(
                    "preview_error",
                    {"error": f"watched file disappeared: {normalized_relative_path}"},
                )
                return

            if current_signature != last_signature:
                last_signature = current_signature
                try:
                    payload = self.app_state.build_preview(str(repo_root_path), normalized_relative_path)
                except ValueError:
                    self._write_sse_event(
                        "preview_error",
                        {"error": f"failed to rebuild preview for: {normalized_relative_path}"},
                    )
                    return
                self._write_sse_event("preview", payload)
                next_keepalive_at = time.monotonic() + PREVIEW_WATCH_KEEPALIVE_SECONDS
                continue

            if time.monotonic() >= next_keepalive_at:
                self._write_sse_comment("keepalive")
                next_keepalive_at = time.monotonic() + PREVIEW_WATCH_KEEPALIVE_SECONDS

    def _send_sse_headers(self) -> None:
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _write_sse_event(self, event_name: str, payload: dict) -> None:
        try:
            encoded = json.dumps(payload, ensure_ascii=False)
            message = f"event: {event_name}\ndata: {encoded}\n\n".encode("utf-8")
            self.wfile.write(message)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise PreviewWatchDisconnectedError("client disconnected from preview watch stream") from None

    def _write_sse_comment(self, text: str) -> None:
        try:
            self.wfile.write(f": {text}\n\n".encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise PreviewWatchDisconnectedError("client disconnected from preview watch stream") from None

    def _read_preview_signature(self, path: Path, *, allow_missing: bool = False) -> str | None:
        try:
            stat_result = path.stat()
        except FileNotFoundError:
            if allow_missing:
                return None
            raise
        return f"{stat_result.st_mtime_ns}:{stat_result.st_size}"

    def _stream_tree_watch(
        self,
        *,
        repo_root: str,
        since_signature: str,
    ) -> None:
        repo_root_path = self.app_state.resolve_repo_root(repo_root)
        initial_payload = self.app_state.build_tree(str(repo_root_path))
        last_signature = initial_payload["meta"].get("tree_signature", "")
        self._send_sse_headers()

        if since_signature and since_signature == last_signature:
            self._write_tree_sse_event(
                "watch_ready",
                {
                    "repo_root": str(repo_root_path),
                    "tree_signature": last_signature,
                },
            )
        else:
            self._write_tree_sse_event("tree", initial_payload)

        if watch is not None:
            self._stream_tree_watch_via_watchfiles(
                repo_root_path=repo_root_path,
                last_signature=last_signature,
            )
            return

        self._stream_tree_watch_via_polling(
            repo_root_path=repo_root_path,
            last_signature=last_signature,
        )

    def _stream_tree_watch_via_watchfiles(
        self,
        *,
        repo_root_path: Path,
        last_signature: str,
    ) -> None:
        next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS

        for changes in watch(
            str(repo_root_path),
            watch_filter=lambda change, changed_path: self._should_watch_tree_path(
                repo_root_path,
                changed_path,
            ),
            debounce=TREE_WATCH_DEBOUNCE_MS,
            rust_timeout=TREE_WATCH_RUST_TIMEOUT_MS,
            yield_on_timeout=True,
        ):
            if not changes:
                if time.monotonic() >= next_keepalive_at:
                    self._write_tree_sse_comment("keepalive")
                    next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS
                continue

            payload = self.app_state.build_tree(str(repo_root_path))
            current_signature = payload["meta"].get("tree_signature", "")
            if current_signature == last_signature:
                continue

            last_signature = current_signature
            self._write_tree_sse_event("tree", payload)
            next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS

    def _stream_tree_watch_via_polling(
        self,
        *,
        repo_root_path: Path,
        last_signature: str,
    ) -> None:
        next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS

        while True:
            time.sleep(TREE_WATCH_POLL_INTERVAL_SECONDS)
            payload = self.app_state.build_tree(str(repo_root_path))
            current_signature = payload["meta"].get("tree_signature", "")
            if current_signature != last_signature:
                last_signature = current_signature
                self._write_tree_sse_event("tree", payload)
                next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS
                continue

            if time.monotonic() >= next_keepalive_at:
                self._write_tree_sse_comment("keepalive")
                next_keepalive_at = time.monotonic() + TREE_WATCH_KEEPALIVE_SECONDS

    def _should_watch_tree_path(self, repo_root_path: Path, changed_path: str) -> bool:
        candidate_path = Path(changed_path)
        try:
            relative_path = candidate_path.resolve().relative_to(repo_root_path).as_posix()
        except ValueError:
            return False

        if relative_path in {".git/index", ".git/HEAD", ".git/packed-refs"}:
            return True
        if relative_path.startswith(".git/refs/"):
            return True

        relative_parts = Path(relative_path).parts
        if any(part in EXCLUDED_DIRS for part in relative_parts):
            return False
        if any(part.startswith(".") and part not in {".codex"} for part in relative_parts[:-1]):
            return False

        return should_track_repo_path(relative_path)

    def _write_tree_sse_event(self, event_name: str, payload: dict) -> None:
        try:
            encoded = json.dumps(payload, ensure_ascii=False)
            message = f"event: {event_name}\ndata: {encoded}\n\n".encode("utf-8")
            self.wfile.write(message)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise TreeWatchDisconnectedError("client disconnected from tree watch stream") from None

    def _write_tree_sse_comment(self, text: str) -> None:
        try:
            self.wfile.write(f": {text}\n\n".encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            raise TreeWatchDisconnectedError("client disconnected from tree watch stream") from None

    def _proxy_translate_request(self, method: str) -> None:
        parsed = urlparse(self.path)
        proxied_path = parsed.path.removeprefix("/translate-api") or "/"
        target_url = f"{self.app_state.translate_server_base_url}{proxied_path}"
        if parsed.query:
            target_url = f"{target_url}?{parsed.query}"
        LOGGER.info("proxy %s %s -> %s", method, self.path, target_url)

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
                LOGGER.info("proxy response %s %s", response.status, target_url)
                self._send_proxy_response(
                    status=response.status,
                    payload=payload,
                    content_type=response_headers.get("Content-Type", "application/json; charset=utf-8"),
                )
        except HTTPError as exc:
            payload = exc.read()
            LOGGER.warning("proxy upstream error %s %s", exc.code, target_url)
            self._send_proxy_response(
                status=exc.code,
                payload=payload,
                content_type=exc.headers.get("Content-Type", "application/json; charset=utf-8"),
            )
        except URLError as exc:
            LOGGER.error("proxy connect error %s: %s", target_url, exc.reason)
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
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    logging.getLogger("watchfiles.main").setLevel(logging.WARNING)
    app_state = AppState(static_dir=args.static_dir)
    server = ThreadingHTTPServer((args.host, args.port), RepoSymbolTreeHandler)
    server.app_state = app_state  # type: ignore[attr-defined]
    LOGGER.info(
        "tree watch backend: %s",
        "watchfiles" if watch is not None else f"polling every {TREE_WATCH_POLL_INTERVAL_SECONDS:.1f}s",
    )
    LOGGER.info("repo-symbol-tree server listening on http://%s:%s", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
