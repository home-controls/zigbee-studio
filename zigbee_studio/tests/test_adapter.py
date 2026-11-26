"""0.7.0: the network adapter (a Zigbee Ethernet bridge, "zbbridge/1") through Zigbee Studio - a link
kept in /data with a token the page never sees, read-only answers cached and shared, and only the
changes that can't cut Zigbee2MQTT off from its adapter."""

import asyncio
import json
import sys
from pathlib import Path

import pytest
from aiohttp import web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))
sys.path.insert(0, str(ROOT / "dev"))

import adapter_sim
from adapter import (
    Adapter,
    AdapterError,
    allows,
    check_change,
    check_host,
    check_read,
    check_token,
    suggested_host,
)
from hub import Hub
from z2m import Z2M

TOKEN = adapter_sim.TOKEN


def test_reads_are_an_allow_list():
    assert check_read("status", {}) == ("status", {})
    assert check_read("events", {"since": "12"}) == ("events", {"since": "12"})
    for path in ("ota", "reboot", "token", "password", "factory-reset", "log", "../status", "", "status/x"):
        with pytest.raises(ValueError):
            check_read(path, {})
    for q in ({"since": "x"}, {"since": "1;2"}, {"limit": "5"}):
        with pytest.raises(ValueError):
            check_read("events", q)


def test_host_and_token_checks():
    assert check_host(" http://192.168.1.50/ ") == "192.168.1.50"
    assert check_host("zigbee-eth-bridge.local:8080") == "zigbee-eth-bridge.local:8080"
    for bad in ("", "a b", "192.168.1.50/api", "user@host", "-x", "http://"):
        with pytest.raises(ValueError):
            check_host(bad)
    assert check_token(TOKEN.upper()) == TOKEN
    for bad in ("", "abc", TOKEN + "0", "g" * 64):
        with pytest.raises(ValueError):
            check_token(bad)


def test_the_adapter_is_suggested_from_zigbee2mqtts_serial_port():
    assert suggested_host({"serial": {"port": "tcp://192.168.1.50:6638"}}) == "192.168.1.50"
    assert suggested_host({"serial": {"port": "/dev/serial/by-id/usb-SONOFF"}}) is None
    assert suggested_host(None) is None


def test_only_changes_that_keep_zigbee2mqtt_connected():
    connected = {"client": {"connected": True, "ip": "192.168.1.10"}}
    assert check_change("allow", {"allow": "192.168.1.10"}, connected) == ("/api/config", {"allow": "192.168.1.10"})
    assert check_change("allow", {"allow": "192.168.1.0/24"}, connected)[1] == {"allow": "192.168.1.0/24"}
    assert check_change("allow", {"allow": "192.0.0.0/8"}, connected)[1] == {"allow": "192.0.0.0/8"}
    with pytest.raises(ValueError, match="shut out Zigbee2MQTT"):
        check_change("allow", {"allow": "192.168.1.20"}, connected)
    assert check_change("allow", {"allow": "192.168.1.20"}, {"client": {"connected": False}})[1] == {"allow": "192.168.1.20"}
    for bad in ("999.1.1.1", "1.2.3.4/40", "abc", "1.2.3.4; reboot"):
        with pytest.raises(ValueError):
            check_change("allow", {"allow": bad}, None)
    assert check_change("reboot", {}, None) == ("/api/reboot", {})
    assert check_change("stats_reset", {}, None) == ("/api/stats/reset", {})
    for action in ("config", "tcp_port", "network", "ota", "password", "token", "factory-reset", ""):
        with pytest.raises(ValueError):
            check_change(action, {"tcp_port": 1}, None)
    assert allows("", "1.2.3.4") and allows("10.0.0.0/8", "10.9.8.7") and not allows("10.0.0.1", "10.0.0.2")


def test_the_api_token_never_lets_anyone_in():
    """Zigbee Bridge 2.1.0+: the API token sets the allowed host only to one address or a range of /8 or
    narrower. Studio refuses the rest before asking, pointing at the adapter's own page."""
    for anyone in ("", "  ", "0.0.0.0/0"):
        with pytest.raises(ValueError, match="can't let anyone connect.*adapter's own page"):
            check_change("allow", {"allow": anyone}, None)
    with pytest.raises(ValueError, match="can't let anyone"):
        check_change("allow", {}, None)
    for wide in ("10.0.0.0/7", "128.0.0.0/1", "192.168.1.0/4"):
        with pytest.raises(ValueError, match=r"/[1-7] range is wider.*adapter's own page"):
            check_change("allow", {"allow": wide}, None)
    for ok in ("10.0.0.0/8", "10.1.0.0/16", "192.168.1.0/24", "192.168.1.50", "192.168.1.50/32"):
        assert check_change("allow", {"allow": ok}, None) == ("/api/config", {"allow": ok})
    # the guard that keeps Zigbee2MQTT connected still applies to a narrow rule
    with pytest.raises(ValueError, match="shut out Zigbee2MQTT"):
        check_change("allow", {"allow": "10.0.0.0/8"}, {"client": {"connected": True, "ip": "192.168.1.10"}})


def test_simulator_refuses_what_the_bridge_refuses():
    for rule in ("10.0.0.0/8", "192.168.1.0/24", "192.168.1.50"):
        assert adapter_sim.token_may_allow(rule)
    for rule in ("", "0.0.0.0/0", "10.0.0.0/7", "1.2.3.4/33", "abc", None, 5):
        assert not adapter_sim.token_may_allow(rule)


async def _sim():
    runner = web.AppRunner(adapter_sim.app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return f"127.0.0.1:{port}", runner


def test_link_read_change_and_unlink(tmp_path):
    async def run():
        host, runner = await _sim()
        a = Adapter(tmp_path / "adapter.json")
        try:
            assert not a.linked and a.info()["linked"] is False
            with pytest.raises(LookupError):
                await a.get("status")
            with pytest.raises(AdapterError, match="refused Zigbee Studio's token"):
                await a.link(host, "f" * 64)
            assert not a.linked
            status = await a.link(host, TOKEN)
            assert status["fw"]["version"] and a.linked
            saved = json.loads((tmp_path / "adapter.json").read_text())
            assert saved == {"host": host, "token": TOKEN}
            assert "token" not in a.info() and TOKEN not in json.dumps(a.info())
            assert Adapter(tmp_path / "adapter.json").linked  # kept across restarts
            many = await asyncio.gather(*(a.get("status") for _ in range(8)))
            assert all(m is many[0] for m in many)  # one request, shared
            h = await a.get("history")
            assert len(h["t"]) == 900
            ev = await a.get("events", {"since": "2"})
            assert all(e["id"] > 2 for e in ev["events"])
            # the simulated adapter has Zigbee2MQTT connected from 172.30.33.5
            with pytest.raises(ValueError, match="shut out"):
                await a.change("allow", {"allow": "192.168.1.20"})
            r = await a.change("allow", {"allow": "172.30.33.0/24"})
            assert r["allow"] == "172.30.33.0/24"
            assert (await a.get("status"))["client"]["allowed"] == "172.30.33.0/24"  # cache dropped after a change
            # the bridge's own refusal reaches the page as it is, and doesn't mark the link broken
            bridge_says = "The API token can only set radio 1's allowed host"
            for body in ({"allow": ""}, {"allow": "0.0.0.0/0"}, {"allow": "10.0.0.0/7"},
                         {"allow": "172.30.33.5", "tcp_port": 6639}, {"hostname": "x"}):
                with pytest.raises(ValueError, match=bridge_says):
                    await a._request("POST", "/api/config", json=body)
            assert a.info()["error"] == "" and a.linked
            assert (await a._request("GET", "/api/config"))["allow"] == "172.30.33.0/24"  # nothing changed
            await a.change("stats_reset", {})
            await a.change("reboot", {})
            a.unlink()
            assert not a.linked and not (tmp_path / "adapter.json").exists()
        finally:
            await a.close()
            await runner.cleanup()
    asyncio.run(run())


def test_unreachable_adapter_says_so(tmp_path):
    async def run():
        p = tmp_path / "adapter.json"
        p.write_text(json.dumps({"host": "127.0.0.1:9", "token": TOKEN}))
        a = Adapter(p)
        try:
            with pytest.raises(AdapterError, match="Can't reach the network adapter"):
                await a.get("status")
            assert "127.0.0.1:9" in a.info()["error"]
            assert not a.info()["error"].rstrip().endswith(":")  # the cause is named, never left blank
        finally:
            await a.close()
    asyncio.run(run())


def test_hub_ops_respect_read_only(tmp_path):
    async def run():
        host, runner = await _sim()

        async def z2m_provider():
            return "ws://127.0.0.1:9/api", {}

        z = Z2M(z2m_provider, read_only=True)
        a = Adapter(tmp_path / "adapter.json")
        ro = Hub(z, None, "test", control=False, adapter=a)
        rw = Hub(z, None, "test", control=True, adapter=a)
        try:
            with pytest.raises(PermissionError):
                await ro.op({"op": "adapter_link", "host": host, "token": TOKEN})
            assert (await ro.op({"op": "adapter_info"}))["linked"] is False
            await rw.op({"op": "adapter_link", "host": host, "token": TOKEN})
            assert ro.snapshot(set())["adp"]["linked"] is True and "token" not in ro.snapshot(set())["adp"]
            st = await ro.op({"op": "adapter", "path": "status"})  # reading needs no control
            assert st["client"]["connected"]
            with pytest.raises(PermissionError):
                await ro.op({"op": "adapter_set", "action": "reboot"})
            with pytest.raises(ValueError):
                await rw.op({"op": "adapter", "path": "ota"})
            with pytest.raises(ValueError):
                await rw.op({"op": "adapter_set", "action": "config", "args": {"tcp_port": 1}})
            assert await rw.op({"op": "adapter_set", "action": "stats_reset"}) == {"ok": True}
            with pytest.raises(PermissionError):
                await ro.op({"op": "adapter_unlink"})
            await rw.op({"op": "adapter_unlink"})
            assert ro.snapshot(set())["adp"]["linked"] is False
        finally:
            await a.close()
            await runner.cleanup()
    asyncio.run(run())
