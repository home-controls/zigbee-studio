"""Development helpers: reach a real Home Assistant from a workstation.

Nothing here runs inside the add-on. A long-lived token is read from the file named by
HA_TOKEN_FILE (never from the repo); HA_URL is Home Assistant's address (http://host[:port]).
The Zigbee2MQTT WebSocket is reached through Home Assistant's ingress proxy with an ingress
session, exactly as the Zigbee2MQTT panel reaches it: read-only unless the app is told otherwise.
"""

import os

import aiohttp


def ha_url() -> str:
    return os.environ.get("HA_URL", "").rstrip("/")


def ha_token() -> str:
    path = os.environ.get("HA_TOKEN_FILE", "")
    if not path:
        raise SystemExit("Set HA_TOKEN_FILE to a file holding a long-lived Home Assistant token")
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


async def ha_ws_call(session: aiohttp.ClientSession, calls: list[dict]) -> list:
    """Run Home Assistant WebSocket commands in order and return their results."""
    out = []
    async with session.ws_connect(ha_url() + "/api/websocket", max_msg_size=0) as ws:
        await ws.receive_json()
        await ws.send_json({"type": "auth", "access_token": ha_token()})
        if (await ws.receive_json()).get("type") != "auth_ok":
            raise SystemExit("Home Assistant refused the token")
        for i, call in enumerate(calls, 1):
            await ws.send_json({"id": i, **call})
            while True:
                msg = await ws.receive_json()
                if msg.get("id") == i:
                    break
            if not msg.get("success", False):
                raise RuntimeError(f"{call.get('type')}: {msg.get('error')}")
            out.append(msg.get("result"))
    return out


async def z2m_via_ingress(session: aiohttp.ClientSession, slug: str = "45df7312_zigbee2mqtt") -> tuple[str, dict]:
    """URL and headers for Zigbee2MQTT's WebSocket through ingress (a fresh ingress session)."""
    sess, info = await ha_ws_call(session, [
        {"type": "supervisor/api", "endpoint": "/ingress/session", "method": "post"},
        {"type": "supervisor/api", "endpoint": f"/addons/{slug}/info", "method": "get"},
    ])
    url = ha_url().replace("http", "ws", 1) + info["ingress_entry"].rstrip("/") + "/api"
    return url, {"Cookie": f"ingress_session={sess['session']}"}
