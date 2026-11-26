"""A stand-in for Home Assistant's WebSocket API, so the simulator shows devices by floor and room.

It answers the registry reads Zigbee Studio makes (floors, areas, devices, entities) from the
recorded registry (<recordings>/ha_registry.json, written by dev/record.py) and accepts the event
subscriptions without ever sending an event. dev/run_local.py --sim starts it when no real Home
Assistant is configured (HA_URL / HA_TOKEN_FILE).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from aiohttp import WSMsgType, web

DEV_DIR = Path(os.environ.get("STUDIO_DEV_DIR") or Path(__file__).resolve().parent.parent / ".dev")
TOKEN = "ha-sim-token"

LISTS = {
    "config/floor_registry/list": "floors",
    "config/area_registry/list": "areas",
    "config/device_registry/list": "devices",
    "config/entity_registry/list": "entities",
}


def registry() -> dict:
    f = DEV_DIR / "ha_registry.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await ws.send_json({"type": "auth_required", "ha_version": "sim"})
    auth = await ws.receive_json()
    if auth.get("access_token") != TOKEN:
        await ws.send_json({"type": "auth_invalid", "message": "wrong token"})
        await ws.close()
        return ws
    await ws.send_json({"type": "auth_ok", "ha_version": "sim"})
    reg = registry()
    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            break
        m = json.loads(msg.data)
        kind = m.get("type")
        if kind in LISTS:
            await ws.send_json({"id": m["id"], "type": "result", "success": True, "result": reg.get(LISTS[kind], [])})
        elif kind in ("subscribe_events", "subscribe_entities"):
            await ws.send_json({"id": m["id"], "type": "result", "success": True, "result": None})
        else:
            await ws.send_json({"id": m["id"], "type": "result", "success": False,
                                "error": {"code": "unknown_command", "message": f"ha_sim doesn't do {kind}"}})
    return ws


async def start(port: int) -> str:
    """Serves ws://127.0.0.1:<port>/api/websocket; returns that URL."""
    app = web.Application()
    app.add_routes([web.get("/api/websocket", websocket)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    return f"ws://127.0.0.1:{port}/api/websocket"
