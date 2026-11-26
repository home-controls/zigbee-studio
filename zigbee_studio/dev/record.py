"""Record what Zigbee2MQTT's WebSocket sends (plus Home Assistant's floors/areas/devices) to
.dev/ for the simulator and tests. Read-only: nothing is sent to Zigbee2MQTT.

  HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/record.py [seconds]
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).parent))
from haconn import ha_ws_call, z2m_via_ingress  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / ".dev"


async def main(seconds: float) -> None:
    OUT.mkdir(exist_ok=True)
    async with aiohttp.ClientSession() as s:
        floors, areas, devices = await ha_ws_call(s, [
            {"type": "config/floor_registry/list"},
            {"type": "config/area_registry/list"},
            {"type": "config/device_registry/list"},
        ])
        z2m_devices = [d for d in devices if any(i[0] == "mqtt" and str(i[1]).startswith("zigbee2mqtt") for i in d.get("identifiers", []))]
        registry = {"floors": floors, "areas": areas, "devices": z2m_devices}
        (OUT / "ha_registry.json").write_text(json.dumps(registry, indent=1), encoding="utf-8")
        url, headers = await z2m_via_ingress(s)
        n, t0 = 0, time.monotonic()
        with open(OUT / "z2m_recording.jsonl", "w", encoding="utf-8") as f:
            async with s.ws_connect(url, headers=headers, max_msg_size=0) as ws:
                while (left := seconds - (time.monotonic() - t0)) > 0:
                    try:
                        msg = await asyncio.wait_for(ws.receive(), left)
                    except asyncio.TimeoutError:
                        break
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    f.write(json.dumps({"t": round(time.monotonic() - t0, 3), "m": json.loads(msg.data)}) + "\n")
                    n += 1
    print(f"{n} messages, {len(z2m_devices)} HA devices -> {OUT}")


if __name__ == "__main__":
    asyncio.run(main(float(sys.argv[1]) if len(sys.argv) > 1 else 60))
