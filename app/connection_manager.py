"""WebSocket fan-out and the background sampling loop.

Design note: there is exactly **one** sampling loop for the whole server, not
one per connected client. Two reasons:

1. Cost. Sampling (especially walking the process list) is the expensive part;
   doing it per client would scale badly.
2. Correctness. Rate metrics are derived from deltas between consecutive
   readings of shared, global OS counters. If two loops both read
   `net_io_counters()`, each would only see part of the traffic and both would
   report wrong numbers.

So the loop samples once per tick and broadcasts the identical payload to
everyone. The loop idles while nobody is connected.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from typing import Any

from fastapi import WebSocket

from .metrics import MetricsCollector

logger = logging.getLogger("sysmonitor.hub")

MIN_INTERVAL_MS = 250
MAX_INTERVAL_MS = 10_000
HISTORY_SIZE = 60


class MetricsHub:
    """Owns the collector, the client set, and the broadcast loop."""

    def __init__(self, interval_ms: int = 1000) -> None:
        self.interval_ms = self._clamp_interval(interval_ms)
        self.collector = MetricsCollector()
        self.history: deque[dict[str, Any]] = deque(maxlen=HISTORY_SIZE)

        self._clients: set[WebSocket] = set()
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        # Lets set_interval() interrupt the current sleep so a new interval
        # applies immediately instead of after the old one elapses.
        self._wake = asyncio.Event()

    # ------------------------------------------------------------------ config

    @staticmethod
    def _clamp_interval(value: Any) -> int:
        """Never trust a client-supplied interval.

        Without clamping, a hostile or buggy client could ask for a 1ms tick and
        peg a CPU core.
        """
        try:
            ms = int(value)
        except (TypeError, ValueError):
            return 1000
        return max(MIN_INTERVAL_MS, min(MAX_INTERVAL_MS, ms))

    def set_interval(self, interval_ms: Any) -> int:
        self.interval_ms = self._clamp_interval(interval_ms)
        self._wake.set()
        logger.info("Sampling interval set to %dms", self.interval_ms)
        return self.interval_ms

    # ------------------------------------------------------------- connections

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a client, replay recent history, and make sure the loop runs."""
        await websocket.accept()
        async with self._lock:
            was_idle = not self._clients
            self._clients.add(websocket)

        if was_idle:
            # Counters have been sitting untouched; without this the first
            # sample would divide a large byte delta by a large elapsed time and
            # report a misleading average.
            self.collector.reset_baseline()

        await websocket.send_json(
            {
                "type": "hello",
                "interval_ms": self.interval_ms,
                "history": list(self.history),
            }
        )
        logger.info("Client connected (%d total)", len(self._clients))
        self._ensure_task()

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)
        logger.info("Client disconnected (%d remaining)", len(self._clients))

    # -------------------------------------------------------------------- loop

    def _ensure_task(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="metrics-sampler")

    async def _run(self) -> None:
        logger.info("Sampler loop started")
        try:
            while True:
                # Idle out when the last client leaves; connect() restarts us.
                async with self._lock:
                    if not self._clients:
                        logger.info("No clients left, sampler loop stopping")
                        return

                try:
                    payload = await asyncio.to_thread(self.collector.sample)
                except Exception:
                    # A single bad sample shouldn't kill the stream.
                    logger.exception("Sampling failed, skipping this tick")
                else:
                    self.history.append(payload)
                    await self._broadcast(payload)

                # Sleep, but wake early if the interval changed underneath us.
                self._wake.clear()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(
                        self._wake.wait(), timeout=self.interval_ms / 1000
                    )
        except asyncio.CancelledError:
            logger.info("Sampler loop cancelled")
            raise

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._clients)
        if not targets:
            return

        results = await asyncio.gather(
            *(ws.send_json(payload) for ws in targets),
            return_exceptions=True,
        )

        # Drop clients that errored: usually a browser tab closed mid-send, and
        # the endpoint's disconnect handler may not have run yet.
        dead = [ws for ws, result in zip(targets, results) if isinstance(result, Exception)]
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
            logger.info("Pruned %d dead client(s)", len(dead))

    async def shutdown(self) -> None:
        """Cancel the loop and close any sockets still open."""
        if self._task and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

        async with self._lock:
            targets = list(self._clients)
            self._clients.clear()
        for ws in targets:
            with contextlib.suppress(Exception):
                await ws.close()

    @property
    def client_count(self) -> int:
        return len(self._clients)
