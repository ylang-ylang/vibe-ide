"""Load Mermaid block-type config for backend symbol flowchart rendering."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import tomllib


CONFIG_PATH = Path(__file__).with_name("cfgs").joinpath("mermaid_block_types.toml")


class MermaidBlockConfigError(ValueError):
    """Mermaid block-type config load or validation failure."""


@dataclass(frozen=True)
class MermaidBlockType:
    """One Mermaid `classDef` block type."""

    name: str
    shape: str
    fill: str
    stroke: str
    stroke_width: str
    color: str
    stroke_dasharray: str | None = None

    def render_class_def(self) -> str:
        """Render one Mermaid `classDef` line."""
        style_parts = [
            f"fill:{self.fill}",
            f"stroke:{self.stroke}",
            f"stroke-width:{self.stroke_width}",
        ]
        if self.stroke_dasharray:
            style_parts.append(f"stroke-dasharray: {self.stroke_dasharray}")
        style_parts.append(f"color:{self.color}")
        return f"    classDef {self.name} {','.join(style_parts)};"


@dataclass(frozen=True)
class MermaidBlockConfig:
    """Loaded Mermaid block-type config."""

    semantic_roles: dict[str, str]
    block_types: dict[str, MermaidBlockType]
    render_order: tuple[str, ...]

    def block_type_name_for(self, semantic_role: str) -> str:
        """Resolve one backend semantic role to its Mermaid block type name."""
        block_type_name = self.semantic_roles.get(semantic_role)
        if not block_type_name:
            raise MermaidBlockConfigError(f"unknown Mermaid semantic role: {semantic_role}")
        if block_type_name not in self.block_types:
            raise MermaidBlockConfigError(
                f"semantic role {semantic_role!r} points to missing block type {block_type_name!r}"
            )
        return block_type_name

    def render_class_defs(self, *semantic_roles: str) -> list[str]:
        """Render Mermaid `classDef` lines for the requested semantic roles."""
        if not semantic_roles:
            ordered_names = self.render_order
        else:
            requested_names = {
                self.block_type_name_for(semantic_role)
                for semantic_role in semantic_roles
            }
            ordered_names = tuple(
                block_type_name
                for block_type_name in self.render_order
                if block_type_name in requested_names
            )
        return [self.block_types[name].render_class_def() for name in ordered_names]

    def render_node_lines(self, *, node_id: str, label: str, semantic_role: str) -> list[str]:
        """Render one Mermaid node declaration plus its class binding."""
        block_type_name = self.block_type_name_for(semantic_role)
        block_type = self.block_types[block_type_name]
        encoded_label = json.dumps(label, ensure_ascii=False)
        return [
            f"    {node_id}@{{ shape: {block_type.shape}, label: {encoded_label} }}",
            f"    class {node_id} {block_type_name}",
        ]

    @classmethod
    def load(cls, path: str | Path = CONFIG_PATH) -> "MermaidBlockConfig":
        """Load one Mermaid block-type config TOML file from disk."""
        config_path = Path(path).resolve()
        raw_config = tomllib.loads(config_path.read_text(encoding="utf-8"))

        semantic_roles = raw_config.get("semantic_roles")
        if not isinstance(semantic_roles, dict) or not semantic_roles:
            raise MermaidBlockConfigError(
                f"{config_path}: [semantic_roles] must be a non-empty TOML table"
            )

        block_types_table = raw_config.get("block_types")
        if not isinstance(block_types_table, dict) or not block_types_table:
            raise MermaidBlockConfigError(
                f"{config_path}: [block_types] must be a non-empty TOML table"
            )

        render_order = raw_config.get("render_order")
        if not isinstance(render_order, list) or not render_order:
            raise MermaidBlockConfigError(
                f"{config_path}: render_order must be a non-empty TOML array"
            )

        normalized_semantic_roles: dict[str, str] = {}
        for semantic_role, block_type_name in semantic_roles.items():
            if not isinstance(semantic_role, str) or not semantic_role:
                raise MermaidBlockConfigError(f"{config_path}: semantic role keys must be non-empty strings")
            if not isinstance(block_type_name, str) or not block_type_name:
                raise MermaidBlockConfigError(
                    f"{config_path}: semantic role {semantic_role!r} must map to a non-empty string"
                )
            normalized_semantic_roles[semantic_role] = block_type_name

        block_types: dict[str, MermaidBlockType] = {}
        for block_type_name, block_type_config in block_types_table.items():
            if not isinstance(block_type_config, dict):
                raise MermaidBlockConfigError(
                    f"{config_path}: [block_types.{block_type_name}] must be a TOML table"
                )

            shape = block_type_config.get("shape", "rect")
            fill = block_type_config.get("fill")
            stroke = block_type_config.get("stroke")
            stroke_width = block_type_config.get("stroke_width", "1.2px")
            color = block_type_config.get("color", "#1b1814")
            stroke_dasharray = block_type_config.get("stroke_dasharray")

            required_fields = {
                "shape": shape,
                "fill": fill,
                "stroke": stroke,
                "stroke_width": stroke_width,
                "color": color,
            }
            for field_name, field_value in required_fields.items():
                if not isinstance(field_value, str) or not field_value:
                    raise MermaidBlockConfigError(
                        f"{config_path}: [block_types.{block_type_name}] {field_name} must be a non-empty string"
                    )
            if stroke_dasharray is not None and (not isinstance(stroke_dasharray, str) or not stroke_dasharray):
                raise MermaidBlockConfigError(
                    f"{config_path}: [block_types.{block_type_name}] stroke_dasharray must be a non-empty string when set"
                )

            block_types[block_type_name] = MermaidBlockType(
                name=block_type_name,
                shape=shape,
                fill=fill,
                stroke=stroke,
                stroke_width=stroke_width,
                color=color,
                stroke_dasharray=stroke_dasharray,
            )

        normalized_render_order: list[str] = []
        for block_type_name in render_order:
            if not isinstance(block_type_name, str) or not block_type_name:
                raise MermaidBlockConfigError(
                    f"{config_path}: render_order values must be non-empty strings"
                )
            if block_type_name not in block_types:
                raise MermaidBlockConfigError(
                    f"{config_path}: render_order references unknown block type {block_type_name!r}"
                )
            normalized_render_order.append(block_type_name)

        for semantic_role, block_type_name in normalized_semantic_roles.items():
            if block_type_name not in block_types:
                raise MermaidBlockConfigError(
                    f"{config_path}: semantic role {semantic_role!r} references unknown block type {block_type_name!r}"
                )

        return cls(
            semantic_roles=normalized_semantic_roles,
            block_types=block_types,
            render_order=tuple(normalized_render_order),
        )


def load_mermaid_block_config(path: str | Path = CONFIG_PATH) -> MermaidBlockConfig:
    """Load Mermaid block-type config without caching so local edits apply immediately."""
    return MermaidBlockConfig.load(path)
