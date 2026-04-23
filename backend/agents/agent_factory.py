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
    # Execution path:
    #   requires_managed_agents=True  → use client.beta.sessions (the Managed
    #   Agents platform). Needed for roles that rely on the container toolset
    #   (bash, read/write/edit, web_fetch) — e.g. the Code Runner.
    #   requires_managed_agents=False → use Messages API with per-token
    #   streaming. Better UX for roles that just emit structured text, because
    #   Managed Agents only emits complete agent.message events per turn,
    #   whereas Messages API streams content_block_deltas live.
    # Every role still has a Managed Agent CREATED (see ensure_agent); this
    # flag only changes which runtime we dispatch invocations through.
    requires_managed_agents: bool = False
    # Enable extended thinking on Messages API calls.
    thinking_budget: int = 0
    # Max tokens for Messages API.
    max_tokens: int = 4096


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
        """Run a single session end-to-end, streaming tokens to on_event.

        Dispatch strategy:
        - Managed Agent is always CREATED (ensure_agent) so every role shows
          up in client.beta.agents.list() and the architecture story holds.
        - Execution goes through Messages API by default, because Managed
          Agents' session stream only emits completed-turn ``agent.message``
          events (i.e. the whole response arrives at once after ~2 min of
          silence). Messages API streams content_block_deltas live and is
          what the reviewer/fix-agent UX needs.
        - Roles that need the Managed Agents container toolset (bash, file
          ops, web_fetch) — i.e. the Code Runner — opt in via
          ``spec.requires_managed_agents=True`` and go through the session
          path, trading live token streaming for real tool execution.
        """
        # Always register the Managed Agent so ``client.beta.agents.list()``
        # reflects all six roles even when we dispatch via Messages API.
        try:
            await self.ensure_agent(spec)
        except Exception as e:
            if on_event:
                await on_event("error", {"role": spec.name, "detail": f"ensure_agent: {e}"})

        if spec.requires_managed_agents:
            try:
                return await self._run_session_managed(spec, user_message, on_event)
            except Exception as e:
                if on_event:
                    await on_event("error", {"role": spec.name, "detail": f"{type(e).__name__}: {e}"})
                return await self._run_session_messages_fallback(spec, user_message, on_event)
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

        # AsyncAnthropic.beta.sessions.events.stream is a coroutine that
        # returns an AsyncStream. AsyncStream is both an async context manager
        # and an async iterator; we use the context-manager form so cleanup
        # happens even if we break early on session.status_idle.
        stream = await self.client.beta.sessions.events.stream(session_id)
        async with stream as events:
            await self.client.beta.sessions.events.send(
                session_id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": user_message}],
                    }
                ],
            )
            async for event in events:
                etype = getattr(event, "type", None) or (
                    event.get("type") if isinstance(event, dict) else None
                )
                if etype == "agent.message":
                    content = getattr(event, "content", None) or (
                        event.get("content", []) if isinstance(event, dict) else []
                    )
                    for block in content:
                        block_type = getattr(block, "type", None) or (
                            block.get("type") if isinstance(block, dict) else None
                        )
                        if block_type == "text":
                            text = getattr(block, "text", None) or (
                                block.get("text", "") if isinstance(block, dict) else ""
                            )
                            collected_text_parts.append(text)
                            if on_event:
                                await on_event("token", {"text": text})
                elif etype == "agent.tool_use":
                    tool_name = getattr(event, "name", None) or (
                        event.get("name") if isinstance(event, dict) else None
                    )
                    if on_event:
                        await on_event("tool_use", {"tool": tool_name})
                    if self._is_custom_tool(event, spec):
                        await self._handle_custom_tool(session_id, event, spec, on_event)
                elif etype == "session.status_idle":
                    break

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
        """Messages API with per-token streaming + custom-tool tool-use loop.

        This is the primary dispatch path (the old "fallback" name is retained
        for diff clarity). Each ``stream.text_stream`` chunk fires ``on_event
        ("token", ...)`` immediately so the UI can render it live. After a
        ``tool_use`` turn we execute the custom tool server-side and loop.
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
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_message}]
        collected: list[str] = []
        # Prose-first streaming: the reviewer skills emit PART 1 prose,
        # then a single-line sentinel ``===PEERMIND_JSON===``, then the
        # JSON. Once we've seen the sentinel in the accumulated text we
        # stop forwarding text chunks to on_event — the JSON is recovered
        # later by ``extract_json`` but never shown as streaming text.
        stream_sentinel = "===PEERMIND_JSON==="
        past_sentinel = False
        while True:
            stream_kwargs: dict[str, Any] = dict(
                model=spec.model,
                max_tokens=spec.max_tokens,
                system=spec.system,
                messages=messages,
            )
            if tools_param:
                stream_kwargs["tools"] = tools_param
            if spec.thinking_budget > 0:
                stream_kwargs["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": spec.thinking_budget,
                }
            async with self.client.messages.stream(**stream_kwargs) as stream:
                async for text in stream.text_stream:
                    collected.append(text)
                    if past_sentinel:
                        # The JSON block — collect it for parsing but don't
                        # leak it to the UI.
                        continue
                    combined = "".join(collected)
                    idx = combined.find(stream_sentinel)
                    if idx != -1:
                        # Sentinel just landed. Forward only the portion of
                        # the current chunk that precedes it, then flip the
                        # flag so subsequent chunks are silent.
                        already = sum(len(c) for c in collected[:-1])
                        sentinel_in_chunk = idx - already
                        visible = text[:sentinel_in_chunk] if sentinel_in_chunk > 0 else ""
                        if on_event and visible:
                            await on_event("token", {"text": visible})
                        past_sentinel = True
                    else:
                        if on_event:
                            await on_event("token", {"text": text})
                final = await stream.get_final_message()
            tool_uses = [b for b in final.content if getattr(b, "type", None) == "tool_use"]
            if not tool_uses:
                break
            # Re-serialize assistant content for the NEXT turn. model_dump()
            # on a TextBlock includes a computed ``parsed_output`` field that
            # the Messages API rejects on input ("Extra inputs are not
            # permitted"). Whitelist only the input-legal fields per block.
            clean_assistant: list[dict[str, Any]] = []
            for b in final.content:
                bt = getattr(b, "type", None)
                if bt == "text":
                    clean_assistant.append({"type": "text", "text": getattr(b, "text", "")})
                elif bt == "tool_use":
                    clean_assistant.append(
                        {
                            "type": "tool_use",
                            "id": getattr(b, "id", None),
                            "name": getattr(b, "name", None),
                            "input": getattr(b, "input", {}),
                        }
                    )
                elif bt == "thinking":
                    clean_assistant.append(
                        {
                            "type": "thinking",
                            "thinking": getattr(b, "thinking", ""),
                            "signature": getattr(b, "signature", ""),
                        }
                    )
                else:
                    # Unknown block type — best-effort dump and strip parsed_output.
                    d = b.model_dump()
                    d.pop("parsed_output", None)
                    clean_assistant.append(d)
            messages.append({"role": "assistant", "content": clean_assistant})
            tool_results: list[dict[str, Any]] = []
            for tu in tool_uses:
                name = tu.name  # type: ignore[attr-defined]
                impl = spec.custom_tool_impls.get(name)
                if on_event:
                    await on_event("tool_use", {"tool": name})
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

_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", re.IGNORECASE)
_JSON_AT_END_RE = re.compile(r"\{[\s\S]*\}\s*$")


def extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort pull of a JSON object from the model's response.

    Skills may instruct the model to emit prose + a sentinel + JSON, or prose
    + fenced JSON, or plain JSON. Handle all paths.
    """
    text = text.strip()

    # Case 0 (preferred): prose + ``===PEERMIND_JSON===`` sentinel + JSON.
    SENTINEL = "===PEERMIND_JSON==="
    si = text.find(SENTINEL)
    if si != -1:
        tail = text[si + len(SENTINEL) :].strip()
        # Drop a code fence if the model wrapped it anyway.
        if tail.startswith("```"):
            tail = re.sub(r"^```(?:json)?\s*", "", tail)
            tail = re.sub(r"\s*```$", "", tail)
        try:
            return json.loads(tail)
        except Exception:
            # Try scanning within the tail for the first parseable object.
            start = tail.find("{")
            while start != -1:
                depth = 0
                for i, ch in enumerate(tail[start:], start):
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            candidate = tail[start : i + 1]
                            try:
                                return json.loads(candidate)
                            except Exception:
                                break
                start = tail.find("{", start + 1)

    # Case 1: fenced ```json ... ``` anywhere in the text. Pick the LAST
    # fenced block — the reviewer may quote a JSON example inside prose and
    # then emit the real structured output at the end.
    fenced = list(_FENCED_JSON_RE.finditer(text))
    if fenced:
        for m in reversed(fenced):
            try:
                return json.loads(m.group(1))
            except Exception:
                continue

    # Case 2: text IS just JSON (whole thing).
    if text.startswith("{"):
        try:
            return json.loads(text)
        except Exception:
            pass

    # Case 3: text was fenced at outer level without json annotator.
    if text.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", text)
        stripped = re.sub(r"\s*```$", "", stripped)
        try:
            return json.loads(stripped)
        except Exception:
            pass

    # Case 4: JSON at end of text (prose before, {...} at the tail).
    m = _JSON_AT_END_RE.search(text)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass

    # Case 5: scan for first {...} that balances and parses.
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
