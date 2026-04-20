#!/usr/bin/env python3
"""Serve local AI translation for ASCII symbol trees."""

import argparse
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


API_PORT = 8766
DEFAULT_LLM_PROXY_BASE_URL = "http://127.0.0.1:38080"
DEFAULT_LLM_PROXY_MODEL = "gpt-5.4-mini"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=API_PORT)
    return parser.parse_args()


class TranslationState:
    """Runtime config for the local symbol translation server."""

    def __init__(self) -> None:
        self.llm_proxy_base_url = os.environ.get("LLM_PROXY_BASE_URL", DEFAULT_LLM_PROXY_BASE_URL).rstrip("/")
        self.llm_proxy_model = os.environ.get("LLM_PROXY_MODEL", DEFAULT_LLM_PROXY_MODEL)
        self.llm_proxy_api_key = os.environ.get("LLM_PROXY_API_KEY", "")

    def translate_symbol_text(self, ascii_tree: str) -> dict[str, str]:
        ascii_tree = ascii_tree.strip()
        if not ascii_tree:
            raise ValueError("ascii_tree must be a non-empty string")

        request_payload = {
            "model": self.llm_proxy_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Translate the user's Python ASCII symbol tree into concise Simplified Chinese. "
                        "Use only the provided ASCII tree as source context. "
                        "Do not infer code details that are not present. "
                        "Preserve the path first line and keep the tree hierarchy when practical."
                    ),
                },
                {
                    "role": "user",
                    "content": ascii_tree,
                },
            ],
            "temperature": 0.2,
        }

        headers = {
            "Content-Type": "application/json",
        }
        if self.llm_proxy_api_key:
            headers["Authorization"] = f"Bearer {self.llm_proxy_api_key}"

        request = Request(
            f"{self.llm_proxy_base_url}/v1/chat/completions",
            data=json.dumps(request_payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace").strip()
            message = error_body or exc.reason
            raise RuntimeError(f"llm proxy returned {exc.code}: {message}") from exc
        except URLError as exc:
            raise RuntimeError(
                f"failed to reach llm proxy at {self.llm_proxy_base_url}: {exc.reason}"
            ) from exc

        choices = payload.get("choices", [])
        if not choices:
            raise RuntimeError("llm proxy returned no choices")

        message = choices[0].get("message", {})
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict)
            )
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("llm proxy returned empty content")

        return {
            "translation": content.strip(),
            "model": str(payload.get("model") or self.llm_proxy_model),
        }


class SymbolTranslateHandler(BaseHTTPRequestHandler):
    """Serve local CORS-enabled translation APIs for the frontend."""

    server_version = "SymbolTranslate/0.1"

    @property
    def translation_state(self) -> TranslationState:
        return self.server.translation_state  # type: ignore[attr-defined]

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT.value)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/healthz":
            self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown path: {parsed.path}")
            return

        self._send_json(
            {
                "ok": True,
                "llm_proxy_base_url": self.translation_state.llm_proxy_base_url,
                "model": self.translation_state.llm_proxy_model,
            }
        )

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/translate-symbol":
            self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown path: {parsed.path}")
            return

        body = self._read_json_body()
        ascii_tree = body.get("ascii_tree")
        if not isinstance(ascii_tree, str) or not ascii_tree.strip():
            self._send_error_json(HTTPStatus.BAD_REQUEST, "ascii_tree must be a non-empty string")
            return

        try:
            payload = self.translation_state.translate_symbol_text(ascii_tree)
        except ValueError as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        except RuntimeError as exc:
            self._send_error_json(HTTPStatus.BAD_GATEWAY, str(exc))
            return

        self._send_json(payload)

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
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), SymbolTranslateHandler)
    server.translation_state = TranslationState()  # type: ignore[attr-defined]
    print(f"symbol-translate server listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
