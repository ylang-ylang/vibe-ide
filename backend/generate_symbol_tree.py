#!/usr/bin/env python3
"""CLI entrypoint for generating one raw repository tree payload JSON file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from code_outline import build_tree_payload


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments for static tree payload export."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> None:
    """Generate one tree payload and write it to disk as formatted JSON."""
    args = parse_args()
    payload = build_tree_payload(args.repo_root)
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
