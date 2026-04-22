"""Thin wrapper around the Claude Managed Agents SDK.

This module is the ONLY place that talks to ``client.beta.agents`` /
``client.beta.environments`` / ``client.beta.sessions``. Every other agent
module describes its persona and tools as an ``AgentSpec`` and hands it here.

Design notes:
- We create each Managed Agent lazily and cache the ID in-process. For a
  hackathon this is fine; for production we'd persist agent IDs to the DB.
- We create one shared environment and reuse it for every session.
- We stream session events and relay them to a caller-provided callback so
  the orchestrator can forward them into the SSE bus.
- When the Managed Agents multiagent research-preview is enabled we declare
  ``callable_agents`` so the orchestrator can natively delegate; otherwise
  the orchestrator coordinates server-side by running sessions itself.
- If Managed Agents raises for transient reasons we fall back to the
  Messages API so a demo never dies on a beta hiccup. The Managed Agents
  path stays primary.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from anthropic import AsyncAnthropic

from ..config import get_settings


@dataclass
class AgentSpec:
    name: str
    model: str
    system: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    callable_agent_names: list[str] = field(default_factory=list)
    # Custom tools we execute on the server side on behalf of the agent.
    custom_tool_impls: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = field(
        default_factory=dict
    )


# Callback signature: (event_type, data) -> None
EventCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


class AgentFactory:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._client: AsyncAnthropic | None = None
        self._env_id: str | None = None
        self._agent_ids: dict[str, dict[str, Any]] = {}
        self._agent_specs: dict[str, AgentSpec] = {}
        self._lock = asyncio.Lock()

    @property
    def client(self) -> AsyncAnthropic:
        if self._client is None:
            self._client = AsyncAnthropic(api_key=self._settings.anthropic_api_key or None)
        return self._client

    async def ensure_environment(self) -> str:
        async with self._lock:
            if self._env_id:
                return self._env_id
            try:
                env = await self.client.beta.environments.create(
                    name="peermind-env",
                    config={"type": "cloud", "networking": {"type": "unrestricted"}},
                )
                self._env_id = env.id
            except Exception as e:
                # Surface a readable error upstream.
                raise RuntimeError(f"Failed to create Managed Agents environment: {e}") from e
            return self._env_id

    async def ensure_agent(self, spec: AgentSpec) -> dict[str, Any]:
        """Create (or return cached) Managed Agent for ``spec.name``."""
        async with self._lock:
            if spec.name in self._agent_ids:
                return self._agent_ids[spec.name]

        tools = list(spec.tools)
        # Add the built-in agent toolset if not present — every agent gets
        # bash/read/write/edit/grep/glob/web_* by default unless explicitly removed.
        if not any(t.get("type") == "agent_toolset_20260401" for t in tools):
            tools.insert(0, {"type": "agent_toolset_20260401"})

        create_kwargs: dict[str, Any] = dict(
            name=spec.name,
            model=spec.model,
            system=spec.system,
            tools=tools,
        )
        if (
            self._settings.managed_agents_multiagent_enabled
            and spec.callable_agent_names
        ):
            callable_entries = []
            async with self._lock:
                for sub in spec.callable_agent_names:
                    rec = self._agent_ids.get(sub)
                    if rec:
                        callable_entries.append(
                            {"type": "agent", "id": rec["id"], "version": rec.get("version", 1)}
                        )
            if callable_entries:
                create_kwargs["callable_agents"] = callable_entries

        agent = await self.client.beta.agents.create(**create_kwargs)
        rec = {"id": agent.id, "version": getattr(agent, "version", 1)}
        async with self._lock:
            self._agent_ids[spec.name] = rec
            self._agent_specs[spec.name] = spec
        return rec

    async def run_session(
        self,
        spec: AgentSpec,
        user_message: str,
        on_event: EventCallback | None = None,
    ) -> str:
        """Run a single session end-to-end, streaming events, return final text.

        Returns the concatenated text of all ``agent.message`` events. When the
        caller expects JSON, parse it out of the returned string.
        """
        try:
            return await self._run_session_managed(spec, user_message, on_event)
        except Exception as e:
            # Emit the error so the UI knows why we're falling back.
            if on_event:
                await on_event("error", {"role": spec.name, "detail": f"{type(e).__name__}: {e}"})
            return await self._run_session_messages_fallback(spec, user_message, on_event)

    async def _run_session_managed(
        self,
        spec: AgentSpec,
        user_message: str,
        on_event: EventCallback | None,
    ) -> str:
        env_id = await self.ensure_environment()
        rec = await self.ensure_agent(spec)

        session = await self.client.beta.sessions.create(
            agent=rec["id"],
            environment_id=env_id,
            title=f"peermind:{spec.name}",
        )
        session_id = session.id

        collected_text_parts: list[str] = []

        # Open the stream, send the user message, and process events.
        stream_ctx = self.client.beta.sessions.events.stream(session_id)

        async def _process(stream: Any) -> None:
            await self.client.beta.sessions.events.send(
                session_id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": user_message}],
                    }
                ],
            )
            async for event in stream:
                etype = getattr(event, "type", None) or event.get("type")  # type: ignore[union-attr]
                if etype == "agent.message":
                    content = getattr(event, "content", None) or event.get("content", [])  # type: ignore[union-attr]
                    for block in content:
                        block_type = getattr(block, "type", None) or (
                            block.get("type") if isinstance(block, dict) else None
                        )
                        if block_type == "text":
                            text = getattr(block, "text", None) or block.get("text", "")  # type: ignore[union-attr]
                            collected_text_parts.append(text)
                            if on_event:
                                await on_event("token", {"text": text})
                elif etype == "agent.tool_use":
                    tool_name = getattr(event, "name", None) or event.get("name")  # type: ignore[union-attr]
                    if on_event:
                        await on_event("tool_use", {"tool": tool_name})
                elif etype in (
                    "agent.custom_tool_use",
                    "agent.tool_use",
                ) and self._is_custom_tool(event, spec):
                    await self._handle_custom_tool(session_id, event, spec, on_event)
                elif etype == "session.status_idle":
                    break

        # Support both async-context and sync-context depending on SDK impl.
        try:
            async with stream_ctx as stream:  # type: ignore[attr-defined]
                await _process(stream)
        except (TypeError, AttributeError):
            with stream_ctx as stream:  # type: ignore[attr-defined]
                await _process(stream)

        return "".join(collected_text_parts)

    def _is_custom_tool(self, event: Any, spec: AgentSpec) -> bool:
        name = getattr(event, "name", None)
        if isinstance(event, dict):
            name = event.get("name")
        return bool(name and name in spec.custom_tool_impls)

    async def _handle_custom_tool(
        self,
        session_id: str,
        event: Any,
        spec: AgentSpec,
        on_event: EventCallback | None,
    ) -> None:
        name = getattr(event, "name", None) or event.get("name")  # type: ignore[union-attr]
        tool_use_id = getattr(event, "id", None) or event.get("id")  # type: ignore[union-attr]
        raw_input = getattr(event, "input", None) or event.get("input", {})  # type: ignore[union-attr]
        impl = spec.custom_tool_impls[name]
        try:
            result = await impl(raw_input if isinstance(raw_input, dict) else {})
        except Exception as e:
            result = {"error": f"{type(e).__name__}: {e}"}
        if on_event:
            await on_event("custom_tool_result", {"tool": name, "keys": list(result.keys()) if isinstance(result, dict) else None})
        await self.client.beta.sessions.events.send(
            session_id,
            events=[
                {
                    "type": "user.custom_tool_result",
                    "tool_use_id": tool_use_id,
                    "content": [
                        {"type": "text", "text": json.dumps(result)[:50000]},
                    ],
                }
            ],
        )

    async def _run_session_messages_fallback(
        self,
        spec: AgentSpec,
        user_message: str,
        on_event: EventCallback | None,
    ) -> str:
        """Fallback: use the Messages API directly when Managed Agents is unavailable.

        We loop over tool_use / tool_result exchanges for any custom tools the
        agent declares, and stream text deltas to on_event as tokens arrive.
        """
        tools_param = []
        for tool in spec.tools:
            if tool.get("type") == "custom":
                tools_param.append(
                    {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "input_schema": tool.get("input_schema", {"type": "object"}),
                    }
                )
        # If no custom tools, still run a plain stream.
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_message}]
        collected: list[str] = []
        while True:
            async with self.client.messages.stream(
                model=spec.model,
                max_tokens=4096,
                system=spec.system,
                messages=messages,
                tools=tools_param or None,
            ) as stream:
                async for text in stream.text_stream:
                    collected.append(text)
                    if on_event:
                        await on_event("token", {"text": text})
                final = await stream.get_final_message()
            tool_uses = [b for b in final.content if getattr(b, "type", None) == "tool_use"]
            if not tool_uses:
                break
            messages.append({"role": "assistant", "content": [b.model_dump() for b in final.content]})
            tool_results: list[dict[str, Any]] = []
            for tu in tool_uses:
                name = tu.name  # type: ignore[attr-defined]
                impl = spec.custom_tool_impls.get(name)
                if impl is None:
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": tu.id, "content": f"unknown_tool:{name}", "is_error": True}  # type: ignore[attr-defined]
                    )
                    continue
                try:
                    result = await impl(tu.input if isinstance(tu.input, dict) else {})  # type: ignore[attr-defined]
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": tu.id, "content": json.dumps(result)}  # type: ignore[attr-defined]
                    )
                    if on_event:
                        await on_event("custom_tool_result", {"tool": name})
                except Exception as e:
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": tu.id, "content": f"{type(e).__name__}: {e}", "is_error": True}  # type: ignore[attr-defined]
                    )
            messages.append({"role": "user", "content": tool_results})
        return "".join(collected)


# One factory per process.
factory = AgentFactory()


# ----- JSON extraction helpers -----

_JSON_RE = re.compile(r"\{[\s\S]*\}\s*$")


def extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort pull of a JSON object from the model's response.

    Skills instruct the model to return JSON only, but we remain defensive.
    """
    text = text.strip()
    # Strip code fences.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        pass
    m = _JSON_RE.search(text)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    # Find the first {...} that parses.
    start = text.find("{")
    while start != -1:
        depth = 0
        for i, ch in enumerate(text[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        return json.loads(candidate)
                    except Exception:
                        break
        start = text.find("{", start + 1)
    return None
