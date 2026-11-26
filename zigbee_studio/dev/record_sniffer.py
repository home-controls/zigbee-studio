"""Record the Zigbee Sniffer's JSON API (read-only GETs through Home Assistant's ingress) into
.dev/sniffer/, for the simulator and for working on the page without the network.

    HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/record_sniffer.py [devices]

`devices` = how many device pages to record (busiest first; default 12, 0 = all).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import aiohttp
from haconn import ha_url, ha_ws_call

OUT = Path(__file__).resolve().parent.parent / ".dev" / "sniffer"
SLUG = os.environ.get("ZIGBEE_SNIFFER_SLUG", "local_zigbee_sniffer")  # the installed Sniffer's add-on ID


def fname(path: str) -> str:
    return path.strip("/").replace("/", "_").replace("?", "__").replace("=", "-").replace("&", "_") + ".json"


async def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    OUT.mkdir(parents=True, exist_ok=True)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as s:
        sess, info = await ha_ws_call(s, [
            {"type": "supervisor/api", "endpoint": "/ingress/session", "method": "post"},
            {"type": "supervisor/api", "endpoint": f"/addons/{SLUG}/info", "method": "get"},
        ])
        base = ha_url() + info["ingress_entry"].rstrip("/")
        cookies = {"ingress_session": sess["session"]}

        async def get(path: str):
            async with s.get(base + path, cookies=cookies) as r:
                body = await r.read()
                if r.status != 200:
                    print(f"{path}: HTTP {r.status}")
                    return None
                (OUT / fname(path)).write_bytes(body)
                print(f"{path}: {len(body) / 1024:.1f} KiB")
                return json.loads(body)

        for p in ("/api/status", "/api/overview", "/api/overview?range=7d", "/api/devices", "/api/mesh",
                  "/api/live?decode=1", "/api/map"):
            await get(p)
        devs = json.loads((OUT / fname("/api/devices")).read_text()) if (OUT / fname("/api/devices")).exists() else None
        rows = devs.get("devices", devs) if isinstance(devs, dict) else (devs or [])
        rows = sorted(rows, key=lambda d: -(d.get("frames") or d.get("count") or 0))
        for d in rows[: limit or None]:
            addr = d.get("addr") or d.get("ieee") or d.get("key")
            if addr:
                await get(f"/api/device/{addr}")
                await get(f"/api/device/{addr}?range=7d")


if __name__ == "__main__":
    asyncio.run(main())
