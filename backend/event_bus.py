"""In-process async pub/sub for SSE fanout per job.

A single backend worker runs the review pipeline; the SSE endpoint subscribes
to the bus and relays every event to the browser. Events are buffered per job
so that a late-connecting stream (e.g. after a page refresh) can replay from
the start of the job.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import AsyncIterator

from .models.schemas import ReviewEvent


class JobEventBus:
    def __init__(self) -> None:
        self._history: dict[str, list[ReviewEvent]] = defaultdict(list)
        self._subscribers: dict[str, set[asyncio.Queue[ReviewEvent | None]]] = defaultdict(set)
        self._seq: dict[str, int] = defaultdict(int)
        self._done: dict[str, bool] = {}
        self._lock = asyncio.Lock()

    async def publish(self, job_id: str, event: ReviewEvent) -> None:
        async with self._lock:
            self._seq[job_id] += 1
            event.seq = self._seq[job_id]
            self._history[job_id].append(event)
            subs = list(self._subscribers.get(job_id, set()))
            if event.event_type == "job_complete":
                self._done[job_id] = True
        for q in subs:
            await q.put(event)
        if event.event_type == "job_complete":
            for q in subs:
                await q.put(None)

    async def subscribe(self, job_id: str) -> AsyncIterator[ReviewEvent]:
        q: asyncio.Queue[ReviewEvent | None] = asyncio.Queue()
        async with self._lock:
            replay = list(self._history.get(job_id, []))
            self._subscribers[job_id].add(q)
            already_done = self._done.get(job_id, False)
        try:
            for ev in replay:
                yield ev
            if already_done:
                return
            while True:
                ev = await q.get()
                if ev is None:
                    return
                yield ev
        finally:
            async with self._lock:
                self._subscribers[job_id].discard(q)


bus = JobEventBus()
