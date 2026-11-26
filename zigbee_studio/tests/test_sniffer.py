"""0.3.0: the Zigbee Sniffer's findings through Zigbee Studio - only read-only answers, slimmed,
cached and shared between pages, with the key the Sniffer shares on /share."""

import asyncio
import sys
from pathlib import Path

import pytest
from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import hass  # noqa: E402
import main  # noqa: E402
import sniffer as sniffer_mod  # noqa: E402
from hub import Hub  # noqa: E402
from sniffer import Sniffer, SnifferError, check, slim  # noqa: E402
from z2m import Z2M  # noqa: E402

KEY = "k" * 43


def test_only_read_only_paths_and_queries():
    assert check("/api/device/0x072f", {"range": "7d"}) == ("device", "/api/device/0x072f", {"range": "7d"})
    assert check("/api/live", {"after": "16138949", "decode": "1"})[0] == "live"
    assert check("/api/map/coverage", {"floor": "upper"})[0] == "map/coverage"
    for path in ("/api/overview", "/api/devices", "/api/mesh", "/api/status", "/api/map"):
        assert check(path, {})[1] == path
    for path in ("/api/decode", "/api/frame", "/api/captures", "/api/trace/0x072f", "/api/device/0x072f/hours",
                 "/api/channel", "/api/sniffer", "/download/2026-11-19/x.pcap", "/api/device", "/api/status/0x072f",
                 "/api/device/0x72f", "/api/device/0xABCD", "/api/device/../decode", "", "/"):
        with pytest.raises(ValueError):
            check(path, {})
    for q in ({"range": "30d"}, {"after": "x"}, {"addr": "0x07"}, {"file": "a.pcap"}, {"range": "24h&decode=1"}):
        with pytest.raises(ValueError):
            check("/api/live", q)


def test_a_device_answer_is_slimmed():
    big = {
        "range": "24h", "span": 86400, "bucket": 900, "now": 1.0,
        "device": {"addr": "0x072f", "name": "Guest Bed", "spark": [[1, 2]] * 25, "cmds": {"x": 1}, "flags": [{"sev": "warn"}],
                   "signal": [{"sniffer": "main", "rssi_avg": -76.0}]},
        "series": [[1, 2, -76.0]], "signal_series": [{"sniffer": "main", "data": [[1, -74.2, -81, -65, 60]], "ref": -73.0}],
        "cmds": [[1, "link_status", 4]] * 200, "link_history": {"0x0000": [[1, 1.0, 0.0]] * 25},
        "neighbours": [{"addr": "0x3be9", "name": "Cans", "in": 1, "out": 1, "cost": 1, "in_avg": 1.1, "out_avg": 1.3,
                        "ts": 1.0, "own": False, "reported": True, "extra": "x" * 100}],
        "events": [{"ts": 1.0, "kind": "network_status", "what": "route error", "detail": "d", "file": "f.pcap", "n": 3,
                    "ieee": ""}] * 100,
        "incidents": [{"id": "inc-1", "start": 1, "end": 2, "sev": "warn", "title": "t", "evidence": {"x": 1}}],
        "frames": [{"id": i, "ts": 1.0, "rssi": -74, "lqi": 10, "kind": "NWK command", "info": "Link Status",
                    "file": "f.pcap", "n": 5, "pan": "0x852c", "heard_by": [{"sniffer": "main", "name": "Main", "rssi": -74}]}
                   for i in range(100)],
        "routes_out": [{"addr": "0x0000", "path": []}], "next_hops": [], "marks": [],
    }
    s = slim("device", big)
    assert "link_history" not in s and "cmds" not in s
    assert "spark" not in s["device"] and "cmds" not in s["device"] and s["device"]["flags"]
    assert s["series"] and s["signal_series"][0]["ref"] == -73.0 and s["routes_out"]
    assert "extra" not in s["neighbours"][0] and s["neighbours"][0]["cost"] == 1
    assert len(s["events"]) == 80 and "file" not in s["events"][0]
    assert "evidence" not in s["incidents"][0]
    assert len(s["frames"]) == 60 and s["frames"][0]["by"] == [["Main", -74]] and "file" not in s["frames"][0]


class FakeSniffer:
    def __init__(self) -> None:
        self.hits = 0
        self.keys: list[str | None] = []
        self.status = 200

    async def handler(self, request: web.Request) -> web.Response:
        self.hits += 1
        self.keys.append(request.headers.get(sniffer_mod.HEADER))
        await asyncio.sleep(0.05)
        if self.status != 200:
            raise web.HTTPForbidden()
        return web.json_response({"version": "0.5.12", "channel": 25, "connected": True, "secret": "x",
                                  "path": request.path, "q": dict(request.query)})


async def _fake():
    fake = FakeSniffer()
    app = web.Application()
    app.router.add_get("/{tail:.*}", fake.handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return fake, f"http://127.0.0.1:{port}", runner


def test_answers_are_cached_and_shared_and_carry_the_key():
    async def run():
        fake, base, runner = await _fake()

        async def provider():
            return base, {sniffer_mod.HEADER: KEY}

        sn = Sniffer(provider)
        try:
            many = await asyncio.gather(*(sn.get("/api/status") for _ in range(10)))
            assert fake.hits == 1  # ten pages, one request
            assert many[0]["channel"] == 25 and "secret" not in many[0]  # slimmed
            await sn.get("/api/status")
            assert fake.hits == 1  # cached
            await sn.get("/api/device/0x072f", {"range": "7d"})
            assert fake.hits == 2 and fake.keys == [KEY, KEY]
        finally:
            await sn.close()
            await runner.cleanup()
    asyncio.run(run())


def test_a_refused_key_says_what_to_do():
    async def run():
        fake, base, runner = await _fake()
        fake.status = 403

        async def provider():
            return base, {sniffer_mod.HEADER: "old"}

        sn = Sniffer(provider)
        try:
            with pytest.raises(SnifferError, match="0.5.12"):
                await sn.get("/api/overview")
            assert "Share with Zigbee Studio" in sn.error
        finally:
            await sn.close()
            await runner.cleanup()
    asyncio.run(run())


def test_no_sniffer_installed():
    async def run():
        async def provider():
            return None

        sn = Sniffer(provider)
        with pytest.raises(SnifferError, match="No Zigbee Sniffer"):
            await sn.get("/api/status")
        await sn.close()
    asyncio.run(run())


def test_the_sniffer_op_works_read_only_and_refuses_the_rest():
    async def run():
        fake, base, runner = await _fake()

        async def provider():
            return base, {sniffer_mod.HEADER: KEY}

        async def z2m_provider():
            return "ws://127.0.0.1:1/api", {}

        hub = Hub(Z2M(z2m_provider, read_only=True), hass.HomeAssistant(None), main.VERSION, False,
                  sniffer=Sniffer(provider), sniffer_panel="/x_zigbee_sniffer")
        try:
            d = await hub.op({"op": "sniffer", "path": "/api/status"})
            assert d["version"] == "0.5.12"
            with pytest.raises(ValueError):
                await hub.op({"op": "sniffer", "path": "/api/channel"})
            assert hub.snapshot(set())["snp"] == "/x_zigbee_sniffer"
            assert fake.hits == 1
        finally:
            await hub.sniffer.close()
            await runner.cleanup()
    asyncio.run(run())


def test_without_a_sniffer_the_page_is_told():
    async def z2m_provider():
        return "ws://127.0.0.1:1/api", {}

    hub = Hub(Z2M(z2m_provider, read_only=True), hass.HomeAssistant(None), main.VERSION, False)
    assert hub.snapshot(set())["snp"] is None
    with pytest.raises(LookupError):
        asyncio.run(hub.op({"op": "sniffer", "path": "/api/status"}))


def test_picks_the_sniffer_addon():
    assert main.pick_sniffer([{"slug": "45df7312_zigbee2mqtt"}, {"slug": "a1b2c3d4_zigbee_sniffer", "state": "started"}]) \
        == "a1b2c3d4_zigbee_sniffer"
    assert main.pick_sniffer([{"slug": "local_zigbee_sniffer", "state": "stopped"},
                              {"slug": "a1b2c3d4_zigbee_sniffer", "state": "started"}]) == "a1b2c3d4_zigbee_sniffer"
    assert main.pick_sniffer([{"slug": "core_mosquitto"}]) is None


def test_the_key_comes_from_share(tmp_path, monkeypatch):
    async def run():
        provider, _state = main.sniffer_provider("", ("http://a1b2c3d4-zigbee-sniffer:8099", "/a1b2c3d4_zigbee_sniffer"))
        monkeypatch.setattr(sniffer_mod, "KEY_FILE", tmp_path / "studio.key")
        with pytest.raises(SnifferError, match="hasn't shared a key"):
            await provider()
        (tmp_path / "studio.key").write_text(KEY + "\n")
        base, headers = await provider()
        assert base == "http://a1b2c3d4-zigbee-sniffer:8099" and headers == {sniffer_mod.HEADER: KEY}
        none, _ = main.sniffer_provider("", (None, None))
        assert await none() is None
    asyncio.run(run())
