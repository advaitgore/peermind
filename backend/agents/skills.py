"""Load Agent Skills from JSON and render their system prompts.

A Skill is a reusable persona with a templated system prompt, an input
contract, and an expected JSON output schema. The template uses Python's
`str.format_map` style but we also support ``{key[index]}`` indexing so a
rubric like ``{journal_score_range[0]}-{journal_score_range[1]}`` works.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"


@dataclass
class Skill:
    name: str
    description: str
    version: str
    inputs: list[str]
    system_prompt_template: str
    output_schema: dict[str, Any] | None = None

    @classmethod
    def from_file(cls, path: Path) -> "Skill":
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            name=data["name"],
            description=data.get("description", ""),
            version=data.get("version", "0.0.0"),
            inputs=data.get("inputs", []),
            system_prompt_template=data["system_prompt_template"],
            output_schema=data.get("output_schema"),
        )


_INDEX_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]\}")


def render_prompt(template: str, ctx: dict[str, Any]) -> str:
    """Fill a template with ``{key}`` and ``{key[i]}`` substitutions.

    We deliberately avoid ``str.format_map`` so that stray ``{`` in prompt
    content (e.g. LaTeX braces) don't blow up.
    """
    def _indexed(m: re.Match[str]) -> str:
        key, idx = m.group(1), int(m.group(2))
        val = ctx.get(key)
        if isinstance(val, (list, tuple)) and 0 <= idx < len(val):
            return str(val[idx])
        return m.group(0)

    out = _INDEX_RE.sub(_indexed, template)
    for key, val in ctx.items():
        if isinstance(val, (str, int, float)):
            out = out.replace("{" + key + "}", str(val))
        elif isinstance(val, (list, tuple)):
            out = out.replace("{" + key + "}", ", ".join(str(x) for x in val))
        elif isinstance(val, dict):
            out = out.replace("{" + key + "}", json.dumps(val, indent=2))
    return out


def load_skill(name: str) -> Skill:
    path = SKILLS_DIR / f"{name}_skill.json"
    if not path.exists():
        raise FileNotFoundError(f"Skill not found: {path}")
    return Skill.from_file(path)
