"""FastAPI application: static dashboard + WebSocket metrics stream.

Endpoints
    GET  /             dashboard (static/index.html)
    GET  /api/system   static machine info (hostname, CPU model, RAM total, ...)
    GET  /api/health   liveness probe + current tick rate and client count
    WS   /ws           live metrics stream

Security note: this server exposes detailed information about the host machine
(running process names, PIDs, disk layout) and has **no authentication**. It is
therefore bound to 127.0.0.1 by default. Do not expose it on a public interface
without putting authentication and TLS in front of it.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .connection_manager import MAX_INTERVAL_MS, MIN_INTERVAL_MS, MetricsHub
from .metrics import system_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("sysmonitor")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = STATIC_DIR / "index.html"

hub = MetricsHub(interval_ms=1000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Dashboard ready at http://127.0.0.1:8000")
    logger.warning(
        "No authentication is configured - keep this bound to localhost only."
    )
    yield
    logger.info("Shutting down, closing WebSocket clients")
    await hub.shutdown()


app = FastAPI(
    title="Real-Time System Resource Monitor",
    description="Streams live CPU, memory, disk and network metrics over WebSockets.",
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/api/system")
async def api_system() -> dict[str, Any]:
    """Machine facts that never change while the server runs."""
    return system_info()


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "clients": hub.client_count,
        "interval_ms": hub.interval_ms,
        "interval_bounds_ms": [MIN_INTERVAL_MS, MAX_INTERVAL_MS],
        "history_size": len(hub.history),
    }


@app.websocket("/ws")
async def websocket_metrics(websocket: WebSocket) -> None:
    """Stream metrics to one client and listen for its control messages.

    The sending side lives in MetricsHub's broadcast loop; this coroutine only
    needs to stay alive to read inbound frames and to notice the disconnect.
    """
    await hub.connect(websocket)
    try:
        while True:
            message = await websocket.receive_json()
            await _handle_client_message(websocket, message)
    except WebSocketDisconnect:
        await hub.disconnect(websocket)
    except Exception:
        # Malformed JSON, abrupt close, etc. Log it and drop the client rather
        # than letting the exception bubble into uvicorn's handler.
        logger.exception("WebSocket error, dropping client")
        await hub.disconnect(websocket)


async def _handle_client_message(websocket: WebSocket, message: Any) -> None:
    if not isinstance(message, dict):
        return

    action = message.get("type")

    if action == "set_interval":
        applied = hub.set_interval(message.get("value"))
        # Echo the *applied* value back: it may have been clamped, and the UI
        # should reflect what the server actually does.
        await websocket.send_json({"type": "interval_ack", "interval_ms": applied})

    elif action == "ping":
        # Lets the client measure round-trip latency.
        await websocket.send_json({"type": "pong", "echo": message.get("value")})

    else:
        logger.debug("Ignoring unknown client message type: %r", action)


@app.exception_handler(404)
async def not_found(request, exc) -> JSONResponse:  # noqa: ANN001
    return JSONResponse({"detail": "Not found"}, status_code=404)


def run() -> None:
    """Entry point for `python -m app.main`."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()
