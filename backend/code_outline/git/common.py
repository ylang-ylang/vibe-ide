"""Git-specific metadata and diff parsing patterns."""

from __future__ import annotations

from dataclasses import dataclass
import re
from pathlib import Path
import tomllib


CONFIG_PATH = Path(__file__).with_name("cfgs").joinpath("status_meta.toml")


@dataclass(frozen=True)
class GitStatusVisualStyle:
    """Mermaid outline style for one git or non-git node state."""

    stroke: str
    stroke_width: str
    color: str
    stroke_dasharray: str | None = None


@dataclass(frozen=True)
class GitStatusMetaEntry:
    """Loaded metadata for one git or non-git state key."""

    label: str
    priority: int
    code: str | None = None
    mermaid_style: GitStatusVisualStyle | None = None


def _load_git_status_meta(path: str | Path = CONFIG_PATH) -> dict[str, GitStatusMetaEntry]:
    config_path = Path(path).resolve()
    raw_config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    priority_order = raw_config.get("priority_order")
    raw_statuses = raw_config.get("statuses")
    if not isinstance(priority_order, list) or not priority_order:
        raise ValueError(f"{config_path}: priority_order must be a non-empty TOML array")
    if not isinstance(raw_statuses, dict) or not raw_statuses:
        raise ValueError(f"{config_path}: [statuses] must be a non-empty TOML table")

    normalized_priority_order: list[str] = []
    for status_kind in priority_order:
        if not isinstance(status_kind, str) or not status_kind:
            raise ValueError(f"{config_path}: priority_order values must be non-empty strings")
        if status_kind not in raw_statuses:
            raise ValueError(f"{config_path}: priority_order references unknown status {status_kind!r}")
        normalized_priority_order.append(status_kind)

    duplicate_statuses = sorted(
        status_kind
        for status_kind in set(normalized_priority_order)
        if normalized_priority_order.count(status_kind) > 1
    )
    if duplicate_statuses:
        raise ValueError(f"{config_path}: priority_order contains duplicates: {duplicate_statuses}")

    if set(normalized_priority_order) != set(raw_statuses):
        missing_statuses = sorted(set(raw_statuses) - set(normalized_priority_order))
        extra_statuses = sorted(set(normalized_priority_order) - set(raw_statuses))
        problems: list[str] = []
        if missing_statuses:
            problems.append(f"missing statuses {missing_statuses}")
        if extra_statuses:
            problems.append(f"unknown statuses {extra_statuses}")
        raise ValueError(f"{config_path}: priority_order must cover every status exactly once ({', '.join(problems)})")

    derived_priorities = {
        status_kind: len(normalized_priority_order) - index - 1
        for index, status_kind in enumerate(normalized_priority_order)
    }

    status_meta: dict[str, GitStatusMetaEntry] = {}
    for status_kind, status_config in raw_statuses.items():
        if not isinstance(status_config, dict):
            raise ValueError(f"{config_path}: [statuses.{status_kind}] must be a TOML table")

        label = status_config.get("label")
        code = status_config.get("code")
        stroke = status_config.get("mermaid_stroke")
        stroke_width = status_config.get("mermaid_stroke_width")
        color = status_config.get("mermaid_color")
        stroke_dasharray = status_config.get("mermaid_stroke_dasharray")

        if not isinstance(label, str) or not label:
            raise ValueError(f"{config_path}: [statuses.{status_kind}] label must be a non-empty string")
        if code is not None and (not isinstance(code, str) or not code):
            raise ValueError(f"{config_path}: [statuses.{status_kind}] code must be a non-empty string when set")

        mermaid_style = None
        if stroke is not None or stroke_width is not None or color is not None or stroke_dasharray is not None:
            if not isinstance(stroke, str) or not stroke:
                raise ValueError(
                    f"{config_path}: [statuses.{status_kind}] mermaid_stroke must be a non-empty string"
                )
            if not isinstance(stroke_width, str) or not stroke_width:
                raise ValueError(
                    f"{config_path}: [statuses.{status_kind}] mermaid_stroke_width must be a non-empty string"
                )
            if not isinstance(color, str) or not color:
                raise ValueError(
                    f"{config_path}: [statuses.{status_kind}] mermaid_color must be a non-empty string"
                )
            if stroke_dasharray is not None and (not isinstance(stroke_dasharray, str) or not stroke_dasharray):
                raise ValueError(
                    f"{config_path}: [statuses.{status_kind}] mermaid_stroke_dasharray must be a non-empty string when set"
                )
            mermaid_style = GitStatusVisualStyle(
                stroke=stroke,
                stroke_width=stroke_width,
                color=color,
                stroke_dasharray=stroke_dasharray,
            )

        status_meta[status_kind] = GitStatusMetaEntry(
            label=label,
            priority=derived_priorities[status_kind],
            code=code,
            mermaid_style=mermaid_style,
        )

    return status_meta


GIT_STATUS_META = _load_git_status_meta()


def git_status_meta_entry(status_kind: str) -> GitStatusMetaEntry:
    """Return loaded metadata for one git or derived status key."""
    try:
        return GIT_STATUS_META[status_kind]
    except KeyError as exc:
        raise KeyError(f"unknown git status kind: {status_kind}") from exc


def git_status_mermaid_style(status_kind: str) -> GitStatusVisualStyle:
    """Return Mermaid outline style for one git or derived status key."""
    meta_entry = git_status_meta_entry(status_kind)
    if meta_entry.mermaid_style is None:
        raise KeyError(f"git status kind has no Mermaid style: {status_kind}")
    return meta_entry.mermaid_style

HUNK_HEADER_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? \+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@"
)
