"""0.4.0: the maps. The mesh slimmed for the page; floor-map changes checked here, needing Allow
control, sent to the Sniffer with its key; plans read and uploaded over HTTP."""

import asyncio
import sys
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import hass  # noqa: E402
import main  # noqa: E402
import sniffer as sniffer_mod  # noqa: E402
from hub import Hub  # noqa: E402
from sniffer import Sniffer, map_change, slim  # noqa: E402
from z2m import Z2M  # noqa: E402

KEY = "k" * 43
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


def test_map_changes_are_checked():
    assert map_change("add_floor", {"name": " Main floor ", "level": 0, "width_m": 20, "height_m": 12}) == \
        ("POST", "/api/map/floors", {"name": "Main floor", "level": 0, "width_m": 20.0, "height_m": 12.0})
    assert map_change("add_floor", {"name": "Upper", "level": 1}) == ("POST", "/api/map/floors", {"name": "Upper", "level": 1})
    assert map_change("update_floor", {"floor": "1a2b3c4d", "scale": 41.5}) == \
        ("POST", "/api/map/floors/1a2b3c4d", {"scale": 41.5})
    assert map_change("update_floor", {"floor": "1a2b3c4d", "floor_height_m": 2.8})[2] == {"floor_height_m": 2.8}
    assert map_change("delete_floor", {"floor": "1a2b3c4d"}) == ("DELETE", "/api/map/floors/1a2b3c4d", None)
    assert map_change("positions", {"set": {"0x000fff00002499ef": {"floor": "f1", "x": 0.25, "y": 1}, "sniffer:main":
                                            {"floor": "f1", "x": 0, "y": 0.5}}, "clear": ["addr:0x072f"]}) == \
        ("POST", "/api/map/positions", {"set": {"0x000fff00002499ef": {"floor": "f1", "x": 0.25, "y": 1.0},
                                                "sniffer:main": {"floor": "f1", "x": 0.0, "y": 0.5}},
                                        "clear": ["addr:0x072f"]})
    for action, args in (
        ("channel", {}), ("set_image", {"floor": "f1"}), ("add_floor", {"name": ""}), ("add_floor", {"name": "x", "level": "1"}),
        ("add_floor", {"name": "x", "width_m": 20}), ("add_floor", {"name": "x", "width_m": -1, "height_m": 5}),
        ("update_floor", {"floor": "f1"}), ("update_floor", {"floor": "../channel", "name": "x"}),
        ("update_floor", {"floor": "f1", "scale": True}), ("update_floor", {"floor": "f1", "floor_height_m": 40}),
        ("update_floor", {"floor": "f1", "scale": float("nan")}), ("delete_floor", {"floor": "a/b"}),
        ("positions", {"set": {"0x07": {"floor": "f1", "x": 0, "y": 0}}}),
        ("positions", {"set": {"sniffer:main": {"floor": "f1", "x": 1.5, "y": 0}}}),
        ("positions", {"clear": ["../x"]}), ("positions", {"set": []}),
    ):
        with pytest.raises(ValueError):
            map_change(action, args)


def test_the_mesh_is_slimmed():
    big = {"range": "24h",
           "nodes": [{"addr": "0x0000", "name": "Coordinator", "type": "Coordinator", "rssi_avg": -58.0, "sev": 0,
                      "last_seen": 1.0, "tx": 5, "mesh": {"n": 27}, "extra": "x" * 50}],
           "edges": [{"a": "0x0000", "b": "0x017e", "ab": 1, "ba": 3, "ab_own": True, "ba_own": True, "ts": 1795152863.28}] * 3,
           "children": [{"child": "0x5e67", "parent": "0xa495", "n": 63}],
           "traffic": [{"a": "0x0000", "b": "0x24cb", "n": 45169}] * 400}
    s = slim("mesh", big)
    assert "traffic" not in s and "extra" not in s["nodes"][0] and s["nodes"][0]["mesh"] == {"n": 27}
    assert s["links"][0] == ["0x0000", "0x017e", 1, 3, 1795152863] and s["children"] == [["0x5e67", "0xa495"]]


class FakeSniffer:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def handler(self, request: web.Request) -> web.StreamResponse:
        body = await request.read()
        self.calls.append((request.method, request.path, dict(request.query), request.headers.get(sniffer_mod.HEADER),
                           request.content_type, body))
        if request.path.endswith("/image") and request.method == "GET":
            if "missing" in request.path:
                raise web.HTTPNotFound()
            return web.Response(body=PNG, content_type="image/png")
        if request.method == "GET":
            return web.json_response({"floors": [], "positions": {}, "items": []})
        return web.json_response({"ok": True, "id": "1a2b3c4d"})


async def _fake():
    fake = FakeSniffer()
    app = web.Application(client_max_size=sniffer_mod.IMAGE_MAX + 65536)
    app.router.add_route("*", "/{tail:.*}", fake.handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return fake, f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", runner


def _hub(base: str, control: bool) -> Hub:
    async def provider():
        return base, {sniffer_mod.HEADER: KEY}

    async def z2m_provider():
        return "ws://127.0.0.1:1/api", {}

    return Hub(Z2M(z2m_provider, read_only=not control), hass.HomeAssistant(None), main.VERSION, control,
               sniffer=Sniffer(provider), sniffer_panel="/x_zigbee_sniffer")


def test_a_map_change_needs_control_and_reaches_the_sniffer():
    async def run():
        fake, base, runner = await _fake()
        ro, rw = _hub(base, False), _hub(base, True)
        try:
            with pytest.raises(PermissionError):
                await ro.op({"op": "map", "action": "add_floor", "args": {"name": "Main floor"}})
            assert fake.calls == []
            await rw.op({"op": "sniffer", "path": "/api/map"})
            await rw.op({"op": "sniffer", "path": "/api/map"})
            assert len(fake.calls) == 1  # cached
            d = await rw.op({"op": "map", "action": "add_floor", "args": {"name": "Main floor", "level": 0, "width_m": 20,
                                                                           "height_m": 12}})
            assert d["id"] == "1a2b3c4d"
            method, path, _q, key, ctype, body = fake.calls[-1]
            assert (method, path, key, ctype) == ("POST", "/api/map/floors", KEY, "application/json")
            assert b'"width_m": 20.0' in body
            await rw.op({"op": "sniffer", "path": "/api/map"})
            assert len(fake.calls) == 3  # the change dropped the cached map
            await rw.op({"op": "map", "action": "delete_floor", "args": {"floor": "1a2b3c4d"}})
            assert fake.calls[-1][:2] == ("DELETE", "/api/map/floors/1a2b3c4d")
            with pytest.raises(ValueError):
                await rw.op({"op": "map", "action": "update_floor", "args": {"floor": "../../channel", "name": "x"}})
            assert len(fake.calls) == 4
        finally:
            await ro.sniffer.close()
            await rw.sniffer.close()
            await runner.cleanup()
    asyncio.run(run())


async def _studio(hub: Hub):
    runner = web.AppRunner(main.build_app(hub))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", runner


def test_plans_are_read_and_uploaded_over_http():
    async def run():
        fake, base, runner = await _fake()
        ro, rw = _hub(base, False), _hub(base, True)
        ro_url, ro_runner = await _studio(ro)
        rw_url, rw_runner = await _studio(rw)
        try:
            async with aiohttp.ClientSession() as s:
                for _ in range(2):
                    async with s.get(ro_url + "/sniffer/floor/1a2b3c4d/plan?v=1a2b3c4d-1.png") as r:
                        assert r.status == 200 and await r.read() == PNG
                        assert r.headers["Content-Type"] == "image/png"
                        assert r.headers["X-Content-Type-Options"] == "nosniff"
                        assert r.headers["Content-Security-Policy"].startswith("sandbox")
                assert len(fake.calls) == 1  # kept until the plan is replaced
                async with s.get(ro_url + "/sniffer/floor/missing/plan?v=x.png") as r:
                    assert r.status == 404
                up = "/sniffer/floor/1a2b3c4d/plan?w=1200&h=800"
                hdr = {"Content-Type": "image/png", "X-Studio": "1"}
                async with s.post(ro_url + up, data=PNG, headers=hdr) as r:
                    assert r.status == 403 and (await r.json())["ro"]
                async with s.post(rw_url + up, data=PNG, headers={"Content-Type": "image/png"}) as r:
                    assert r.status == 403  # not from this page
                async with s.post(rw_url + up, data=b"<html>", headers={**hdr, "Content-Type": "text/html"}) as r:
                    assert r.status == 400
                async with s.post(rw_url + "/sniffer/floor/1a2b3c4d/plan?w=0&h=800", data=PNG, headers=hdr) as r:
                    assert r.status == 400
                async with s.post(rw_url + "/sniffer/floor/a.b/plan?w=1&h=1", data=PNG, headers=hdr) as r:
                    assert r.status == 400
                n = len(fake.calls)
                async with s.post(rw_url + up, data=PNG, headers=hdr) as r:
                    assert r.status == 200
                assert len(fake.calls) == n + 1
                method, path, q, key, ctype, body = fake.calls[-1]
                assert (method, path, q, key, ctype, body) == ("POST", "/api/map/floors/1a2b3c4d/image",
                                                               {"w": "1200", "h": "800"}, KEY, "image/png", PNG)
        finally:
            await ro.sniffer.close()
            await rw.sniffer.close()
            await ro_runner.cleanup()
            await rw_runner.cleanup()
            await runner.cleanup()
    asyncio.run(run())
