"""Run Zigbee Studio on a workstation.

  --live  the real Zigbee2MQTT through Home Assistant's ingress, ALWAYS read-only; the real
          Zigbee Sniffer through its ingress too (read-only GETs)
  --sim   the simulators (dev/z2m_sim.py, dev/sniffer_sim.py, from recordings; dev/adapter_sim.py, a
          network adapter to link under Settings), control allowed

Rooms and sniffer health come from the real Home Assistant (read-only registry/state reads) when
HA_URL and HA_TOKEN_FILE are set; without them --sim serves the recorded registry (dev/ha_sim.py). The page is at http://127.0.0.1:8098/.

  HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/run_local.py --sim
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path
# recordings and local state: .dev/ (STUDIO_DEV_DIR=.dev-demo for the anonymised demo set, see dev/demo_data.py)
DEV_DIR = Path(os.environ.get("STUDIO_DEV_DIR") or Path(__file__).resolve().parent.parent / ".dev")

import aiohttp

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "app"))
os.environ.setdefault("STUDIO_DATA", str(DEV_DIR / "data"))

import adapter_sim
import ha_sim  # noqa: E402
import haconn  # noqa: E402
import main as studio  # noqa: E402
import sniffer as sniffer_mod  # noqa: E402
import sniffer_sim  # noqa: E402
import z2m_sim  # noqa: E402


SNIFFER_SLUG = os.environ.get("ZIGBEE_SNIFFER_SLUG", "local_zigbee_sniffer")  # the installed Sniffer's add-on ID


def ingress_sniffer():
    """(base, headers) for the real Sniffer through Home Assistant's ingress, a fresh ingress
    session every 10 minutes (they expire)."""
    cache = {"at": 0.0, "v": None}

    async def provider():
        import time
        if cache["v"] is None or time.monotonic() - cache["at"] > 600:
            async with aiohttp.ClientSession() as s:
                sess, info = await haconn.ha_ws_call(s, [
                    {"type": "supervisor/api", "endpoint": "/ingress/session", "method": "post"},
                    {"type": "supervisor/api", "endpoint": f"/addons/{SNIFFER_SLUG}/info", "method": "get"},
                ])
            cache["v"] = (haconn.ha_url() + info["ingress_entry"].rstrip("/"),
                          {"Cookie": f"ingress_session={sess['session']}"})
            cache["at"] = time.monotonic()
        return cache["v"]

    return provider


async def run(args) -> None:
    ha_provider = None
    if haconn.ha_url() and os.environ.get("HA_TOKEN_FILE"):
        token = haconn.ha_token()

        async def ha_provider() -> tuple[str, str]:
            return haconn.ha_url().replace("http", "ws", 1) + "/api/websocket", token

    if args.sim:
        await z2m_sim.start(args.sim_port)
        await sniffer_sim.start(args.sim_port + 1)
        await adapter_sim.start(args.sim_port + 2)  # link it in Studio: 127.0.0.1:<port> and adapter_sim.TOKEN
        print(f"Adapter simulator: 127.0.0.1:{args.sim_port + 2}, token {adapter_sim.TOKEN}")
        if ha_provider is None:  # no real Home Assistant: rooms from the recorded registry
            ha_ws = await ha_sim.start(args.sim_port + 3)

            async def ha_provider() -> tuple[str, str]:
                return ha_ws, ha_sim.TOKEN

        async def sniffer_provider():
            return f"http://127.0.0.1:{args.sim_port + 1}", {sniffer_mod.HEADER: sniffer_sim.KEY}

        async def z2m_provider() -> tuple[str, dict]:
            return f"ws://127.0.0.1:{args.sim_port}/api", {}

        control = not args.read_only
    else:
        async def z2m_provider() -> tuple[str, dict]:
            async with aiohttp.ClientSession() as s:
                return await haconn.z2m_via_ingress(s)

        control = False  # the real network is only ever watched from a workstation
        sniffer_provider = ingress_sniffer() if haconn.ha_url() else None
    await studio.serve(z2m_provider, ha_provider, control, "/45df7312_zigbee2mqtt", port=args.port, bind="127.0.0.1",
                       static_root=Path(args.static) if args.static else studio.STATIC,
                       sniffer_provider=sniffer_provider, sniffer_panel="/" + SNIFFER_SLUG)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true")
    mode.add_argument("--sim", action="store_true")
    p.add_argument("--read-only", action="store_true", help="simulator without control")
    p.add_argument("--port", type=int, default=8098)
    p.add_argument("--sim-port", type=int, default=18099)
    p.add_argument("--static", help="serve another build directory")
    asyncio.run(run(p.parse_args()))
