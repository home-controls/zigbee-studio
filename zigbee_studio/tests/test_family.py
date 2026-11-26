"""/api/family: what the other Zigbee apps' menus may know about Studio's neighbours."""

import asyncio
import json
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import adapter as adapter_mod  # noqa: E402
import hass  # noqa: E402
import main  # noqa: E402
from hub import Hub  # noqa: E402
from z2m import Z2M  # noqa: E402


async def _get(hub: Hub) -> dict:
    runner = web.AppRunner(main.build_app(hub))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/api/family"
    try:
        async with aiohttp.ClientSession() as s, s.get(url) as r:
            assert r.status == 200
            return await r.json()
    finally:
        await runner.cleanup()


def _hub(adapter_file: Path) -> Hub:
    async def z2m_provider():
        return "ws://127.0.0.1:1/api", {}

    return Hub(Z2M(z2m_provider, read_only=True), hass.HomeAssistant(None), main.VERSION, False,
               adapter=adapter_mod.Adapter(adapter_file))


def test_family_gives_the_bridge_page_but_never_its_token(tmp_path):
    f = tmp_path / "adapter.json"
    f.write_text(json.dumps({"host": "192.168.1.50", "token": "a" * 64}))
    d = asyncio.run(_get(_hub(f)))
    assert d == {"app": "studio", "version": main.VERSION, "bridge": "http://192.168.1.50/"}
    assert "a" * 16 not in json.dumps(d)


def test_family_without_a_linked_bridge(tmp_path):
    d = asyncio.run(_get(_hub(tmp_path / "missing.json")))
    assert d["bridge"] is None
