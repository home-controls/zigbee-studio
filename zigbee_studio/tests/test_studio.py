"""Zigbee Studio backend tests: lean snapshot, Zigbee2MQTT message handling, the read-only gate
(end to end against a fake Zigbee2MQTT), Home Assistant parsing and static serving.

  uv run --python 3.12 --with pytest --with aiohttp==3.10.10 --with pyyaml python -m pytest -q tests
"""

import asyncio
import gzip
import json
import re
import sys
import time
from pathlib import Path

import aiohttp
import pytest
import yaml
from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import hass  # noqa: E402
import lean  # noqa: E402
import main  # noqa: E402
import z2m as z2m_mod  # noqa: E402
from hub import Hub  # noqa: E402
from z2m import Z2M  # noqa: E402

LIGHT_EXPOSES = [{"type": "light", "features": [
    {"type": "binary", "name": "state", "property": "state", "access": 7, "value_on": "ON", "value_off": "OFF"},
    {"type": "numeric", "name": "brightness", "property": "brightness", "access": 7, "value_min": 0, "value_max": 254}]},
    {"type": "numeric", "name": "linkquality", "property": "linkquality", "access": 1}]
SENSOR_EXPOSES = [{"type": "binary", "name": "contact", "property": "contact", "access": 1, "value_on": False, "value_off": True}]


def device(ieee: str, name: str, exposes: list, typ: str = "Router") -> dict:
    return {"ieee_address": ieee, "friendly_name": name, "type": typ, "network_address": 1234, "supported": True,
            "disabled": False, "interview_state": "SUCCESSFUL", "power_source": "Mains (single phase)",
            "endpoints": {"1": {"bindings": [], "clusters": {"input": ["genOnOff"], "output": []}, "configured_reportings": []}},
            "definition": {"model": "M1", "vendor": "V", "description": "d", "exposes": exposes, "options": [], "supports_ota": False}}


DEVICES = [
    device("0x0000000000000001", "Lamp A", LIGHT_EXPOSES),
    device("0x0000000000000002", "Lamp B", LIGHT_EXPOSES),
    device("0x0000000000000003", "Up/Door", SENSOR_EXPOSES, "EndDevice"),
]
GROUPS = [{"id": 7, "friendly_name": "Lamps", "members": [{"ieee_address": "0x0000000000000001", "endpoint": 1}], "scenes": []}]


def msg(topic: str, payload) -> str:
    return json.dumps({"topic": topic, "payload": payload})


def fed(read_only: bool = True) -> Z2M:
    async def provider():
        return "ws://unused", {}
    z = Z2M(provider, read_only=read_only)
    z._connected_at = time.monotonic() - 60  # past the cache replay window
    z.feed(msg("bridge/devices", DEVICES))
    z.feed(msg("bridge/groups", GROUPS))
    return z


# ---------------------------------------------------------------------- packaging

def test_version_matches_config():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["version"] == main.VERSION
    assert cfg["options"]["allow_control"] is False, "must install read-only"
    web_pkg = json.loads((ROOT / "web" / "package.json").read_text(encoding="utf-8"))
    assert web_pkg["version"] == main.VERSION


def test_built_page_is_committed():
    index = (ROOT / "app" / "static" / "index.html").read_text(encoding="utf-8")
    for ref in re.findall(r'(?:src|href)="\./(assets/[^"]+)"', index):
        assert (ROOT / "app" / "static" / ref).is_file(), ref
    assert "./assets/" in index, "assets must be relative (the page lives under the ingress path)"


# ---------------------------------------------------------------------- lean

def test_devices_share_one_exposes_list():
    rows, table = lean.devices({d["ieee_address"]: d for d in DEVICES})
    assert len(table) == 2
    a, b, c = rows
    assert a["x"] == b["x"] != c["x"]
    assert "definition" not in a and "endpoints" not in a
    assert table[a["x"]] == LIGHT_EXPOSES


def test_device_detail_has_endpoints():
    d = lean.device_detail(DEVICES[0])
    assert d["endpoints"]["1"]["clusters"]["input"] == ["genOnOff"]


# ---------------------------------------------------------------------- Zigbee2MQTT messages

def test_state_diffs_and_slash_names():
    z = fed()
    seen = []
    z.listen(lambda kind, *a: seen.append((kind, a)))
    z.feed(msg("Lamp A", {"state": "ON", "brightness": 10, "linkquality": 100}))
    z.feed(msg("Lamp A", {"state": "ON", "brightness": 20, "linkquality": 100}))
    z.feed(msg("Up/Door", {"contact": True}))
    z.feed(msg("Up/Door/availability", {"state": "online"}))
    states = [a for k, a in seen if k == "state"]
    assert states[0][1] == {"state": "ON", "brightness": 10, "linkquality": 100}
    assert states[1][1] == {"brightness": 20}, "only what changed"
    assert states[2][0] == "0x0000000000000003"
    assert z.avail["0x0000000000000003"] == "online"
    assert z.states["0x0000000000000001"]["brightness"] == 20
    assert z.heard["0x0000000000000001"] > 0


def test_cache_replay_is_not_heard():
    z = fed()
    z._connected_at = time.monotonic()  # just connected: Zigbee2MQTT replays its cache
    z.feed(msg("Lamp A", {"state": "OFF"}))
    assert "0x0000000000000001" not in z.heard
    z.feed(msg("Lamp A", {"state": "ON"}))  # a second message is real
    assert "0x0000000000000001" in z.heard


def test_state_before_devices_is_kept():
    async def provider():
        return "", {}
    z = Z2M(provider)
    z._connected_at = time.monotonic() - 60
    z.feed(msg("Lamp A", {"state": "ON"}))
    z.feed(msg("Lamp A/availability", {"state": "offline"}))
    z.feed(msg("bridge/devices", DEVICES))
    assert z.states["0x0000000000000001"] == {"state": "ON"}
    assert z.avail["0x0000000000000001"] == "offline"


def test_group_state_and_availability_events():
    z = fed()
    z.feed(msg("Lamps", {"state": "ON"}))
    assert z.states["g7"] == {"state": "ON"}
    z.feed(msg("Lamp B/availability", {"state": "online"}))
    z.feed(msg("Lamp B/availability", {"state": "offline"}))
    assert [e["type"] for e in z.events] == ["availability"]
    assert z.events[-1]["state"] == "offline"


def test_logs_and_extension_names_only():
    z = fed()
    z.feed(msg("bridge/logging", {"level": "error", "message": "boom", "namespace": "z2m"}))
    z.feed(msg("bridge/extensions", [{"name": "control4.mjs", "code": "x" * 100000}]))
    assert z.logs[-1]["msg"] == "boom"
    assert z.extensions == ["control4.mjs"]
    assert "x" * 100 not in json.dumps(lean.bridge(z))


def test_log_namespace_split_from_message():
    # Zigbee2MQTT 2.x: the namespace is inside the message and there is no namespace field
    z = fed()
    z.feed(msg("bridge/logging", {"level": "info", "message": "zhc:tz: Read result of 'genBasic': {\"zclVersion\":8}"}))
    assert (z.logs[-1]["ns"], z.logs[-1]["msg"]) == ("zhc:tz", "Read result of 'genBasic': {\"zclVersion\":8}")
    z.feed(msg("bridge/logging", {"level": "info", "message": "z2m:mqtt: MQTT publish: topic 'x'"}))
    assert (z.logs[-1]["ns"], z.logs[-1]["msg"]) == ("z2m:mqtt", "MQTT publish: topic 'x'")
    z.feed(msg("bridge/logging", {"level": "info", "message": "zh:ember:uart:ash: Frame received"}))
    assert z.logs[-1]["ns"] == "zh:ember:uart:ash"
    # a namespace field, with or without the prefix repeated, and messages that only look like one
    assert z2m_mod.split_ns("z2m: Started", "z2m") == ("z2m", "Started")
    assert z2m_mod.split_ns("Started", "z2m") == ("z2m", "Started")
    assert z2m_mod.split_ns("Error: ZCL command failed", None) == ("", "Error: ZCL command failed")
    assert z2m_mod.split_ns("zigbee: up", None) == ("", "zigbee: up")


def test_log_kept_across_restarts(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    z = fed()
    z.feed(msg("bridge/logging", {"level": "info", "message": "zhc:tz: Read result of 'genBasic': {\"zclVersion\":8}"}))
    z.feed(msg("bridge/logging", {"level": "error", "message": "z2m: boom"}))
    main.save_logs(z)
    again = fed()
    main.load_logs(again)  # a restarted add-on
    assert [(e["ns"], e["msg"]) for e in again.logs][-2:] == [("zhc:tz", "Read result of 'genBasic': {\"zclVersion\":8}"), ("z2m", "boom")]
    (tmp_path / main.LOGS_FILE).write_text('[{"msg": 1}, "x", {"ts": 1.0, "msg": "kept", "level": "info", "ns": ""}]')
    third = fed()
    main.load_logs(third)  # only well-formed lines come back
    assert [e["msg"] for e in third.logs] == ["kept"]
    (tmp_path / main.LOGS_FILE).write_text("not json")
    fourth = fed()
    main.load_logs(fourth)
    assert not fourth.logs


def test_read_only_never_sends():
    z = fed(read_only=True)

    class Boom:
        async def send_str(self, _):
            raise AssertionError("sent while read-only")
    z._ws = Boom()
    with pytest.raises(PermissionError):
        asyncio.run(z.send("Lamp A/set", {"state": "ON"}))


# ---------------------------------------------------------------------- end to end

class FakeZ2M:
    """Zigbee2MQTT's WebSocket: sends a snapshot, records what it gets, answers requests."""

    def __init__(self) -> None:
        self.received: list[dict] = []

    async def handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_str(msg("bridge/state", {"state": "online"}))
        await ws.send_str(msg("bridge/info", {"version": "2.14.3", "config": {}, "coordinator": {"type": "EmberZNet"}}))
        await ws.send_str(msg("bridge/devices", DEVICES))
        await ws.send_str(msg("bridge/groups", GROUPS))
        await ws.send_str(msg("Lamp A", {"state": "OFF", "brightness": 5}))
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            data = json.loads(m.data)
            self.received.append(data)
            if data["topic"].startswith("bridge/request/"):
                sub = data["topic"][15:]
                await ws.send_str(msg(f"bridge/response/{sub}", {"status": "ok", "data": {"echo": sub},
                                                                 "transaction": data["payload"]["transaction"]}))
            elif data["topic"].endswith("/set"):
                await ws.send_str(msg(data["topic"][:-4], data["payload"]))
        return ws


async def _studio(control: bool):
    fake = FakeZ2M()
    zapp = web.Application()
    zapp.router.add_get("/api", fake.handler)
    zrunner = web.AppRunner(zapp)
    await zrunner.setup()
    zsite = web.TCPSite(zrunner, "127.0.0.1", 0)
    await zsite.start()
    zport = zsite._server.sockets[0].getsockname()[1]

    async def provider():
        return f"ws://127.0.0.1:{zport}/api", {}

    z = Z2M(provider, read_only=not control)
    hub = Hub(z, hass.HomeAssistant(None), main.VERSION, control, "/x_zigbee2mqtt")
    task = asyncio.create_task(z.run())
    for _ in range(100):
        if z.devices and "0x0000000000000001" in z.states:
            break
        await asyncio.sleep(0.02)
    srunner = web.AppRunner(main.build_app(hub, ROOT / "app" / "static"))
    await srunner.setup()
    ssite = web.TCPSite(srunner, "127.0.0.1", 0)
    await ssite.start()
    sport = ssite._server.sockets[0].getsockname()[1]

    async def close():
        task.cancel()
        await srunner.cleanup()
        await zrunner.cleanup()
    return fake, z, f"http://127.0.0.1:{sport}", close


async def _reply(ws, rid):
    while True:
        m = json.loads((await asyncio.wait_for(ws.receive(), 5)).data)
        for one in m["m"] if m.get("t") == "b" else [m]:
            if one.get("t") == "r" and one.get("id") == rid:
                return one


def test_end_to_end_control():
    async def run():
        fake, z, base, close = await _studio(control=True)
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(base + "/ws") as ws:
                    await ws.send_json({"op": "hello", "have": []})
                    snap = json.loads((await ws.receive()).data)
                    assert snap["t"] == "snap" and snap["control"] is True
                    assert len(snap["devices"]) == 3 and len(snap["x"]) == 2
                    assert snap["states"]["0x0000000000000001"]["brightness"] == 5
                    have = list(snap["x"])
                    await ws.send_json({"op": "set", "id": 1, "key": "0x0000000000000001", "payload": {"state": "ON"}})
                    assert (await _reply(ws, 1))["ok"]
                    await ws.send_json({"op": "req", "id": 2, "topic": "device/rename", "payload": {"from": "a", "to": "b"}})
                    r = await _reply(ws, 2)
                    assert r["ok"] and r["d"] == {"echo": "device/rename"}
                    await ws.send_json({"op": "set", "id": 3, "key": "g7", "payload": {"brightness": 9}})
                    assert (await _reply(ws, 3))["ok"]
                async with s.ws_connect(base + "/ws") as ws:  # a second visit with the exposes cached
                    await ws.send_json({"op": "hello", "have": have})
                    snap = json.loads((await ws.receive()).data)
                    assert snap["x"] == {}
                async with s.get(base + "/api/status") as r:
                    assert (await r.json())["z2m_connected"] is True
            topics = [m["topic"] for m in fake.received]
            assert topics[0] == "Lamp A/set" and fake.received[0]["payload"] == {"state": "ON"}
            assert topics[1] == "bridge/request/device/rename"
            assert topics[2] == "Lamps/set"
        finally:
            await close()
    asyncio.run(run())


def test_end_to_end_read_only_sends_nothing():
    async def run():
        fake, z, base, close = await _studio(control=False)
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(base + "/ws") as ws:
                    await ws.send_json({"op": "hello", "have": []})
                    snap = json.loads((await ws.receive()).data)
                    assert snap["control"] is False
                    for i, op in enumerate([
                        {"op": "set", "key": "0x0000000000000001", "payload": {"state": "ON"}},
                        {"op": "get", "key": "0x0000000000000001", "payload": {"state": ""}},
                        {"op": "req", "topic": "permit_join", "payload": {"time": 60}},
                    ], 1):
                        await ws.send_json({**op, "id": i})
                        r = await _reply(ws, i)
                        assert r["ok"] is False and r["ro"] is True
                    await ws.send_json({"op": "device", "id": 9, "key": "0x0000000000000002"})
                    r = await _reply(ws, 9)
                    assert r["ok"] and "endpoints" in r["d"]
            await asyncio.sleep(0.1)
            assert fake.received == []
        finally:
            await close()
    asyncio.run(run())


def test_live_changes_reach_the_page():
    async def run():
        fake, z, base, close = await _studio(control=True)
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(base + "/ws") as ws:
                    await ws.send_json({"op": "hello", "have": []})
                    await ws.receive()
                    z._connected_at = time.monotonic() - 60  # past the cache replay: a real message
                    z.feed(msg("Lamp B", {"state": "ON"}))
                    z.feed(msg("bridge/logging", {"level": "info", "message": "hi"}))
                    got = []
                    while len(got) < 2:
                        m = json.loads((await asyncio.wait_for(ws.receive(), 5)).data)
                        got += m["m"] if m["t"] == "b" else [m]
                    assert got[0] == {"t": "s", "k": "0x0000000000000002", "p": {"state": "ON"}, "h": got[0]["h"]}
                    assert got[1]["t"] == "l" and got[1]["e"]["msg"] == "hi"
        finally:
            await close()
    asyncio.run(run())


def test_only_ingress_may_connect():
    async def run():
        fake, z, base, close = await _studio(control=False)
        main.ALLOW.discard("127.0.0.1")
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(base + "/") as r:
                    assert r.status == 403
        finally:
            main.ALLOW.add("127.0.0.1")
            await close()
    asyncio.run(run())


# ---------------------------------------------------------------------- Home Assistant

def test_registry_maps_devices_to_rooms():
    ha = hass.HomeAssistant(None)
    results = {
        "config/floor_registry/list": [{"floor_id": "main", "name": "Main", "level": 1}, {"floor_id": "up", "name": "Upper", "level": 2}],
        "config/area_registry/list": [{"area_id": "kitchen", "name": "Kitchen", "floor_id": "main"}],
        "config/device_registry/list": [
            {"id": "d1", "area_id": "kitchen", "identifiers": [["mqtt", "zigbee2mqtt_0x0000000000000001"]]},
            {"id": "d2", "area_id": None, "identifiers": [["mqtt", "zigbee2mqtt_1221051039810110150109113116116_7"]]},
            {"id": "d3", "area_id": "kitchen", "identifiers": [["hue", "a", "b"], ["esphome", "x"]]},
        ],
        "config/entity_registry/list": [
            {"entity_id": "sensor.lamp_a_zigbee_health", "platform": "mqtt", "unique_id": "zigbee_sniffer_0x0000000000000001_health"},
            {"entity_id": "sensor.other", "platform": "mqtt", "unique_id": "something"},
        ],
    }

    async def call(m):
        return results[m["type"]]
    asyncio.run(ha._load(call))
    assert [f["id"] for f in ha.floors] == ["up", "main"], "top floor first"
    assert ha.dev["0x0000000000000001"] == {"area": "kitchen", "id": "d1", "ha_name": None}
    assert ha.dev["g7"]["id"] == "d2"
    assert ha._sniffer_entities == {"sensor.lamp_a_zigbee_health": "0x0000000000000001"}


def test_sniffer_health_from_compressed_states():
    ha = hass.HomeAssistant(None)
    ha._sniffer_entities = {"sensor.h": "0x0000000000000001"}
    seen = []
    ha.listen(lambda kind, *a: seen.append((kind, a)))
    ha._entities({"a": {"sensor.h": {"s": "ok", "a": {"signal_at_sniffer": -70, "findings": []}}}})
    ha._entities({"c": {"sensor.h": {"+": {"s": "warning", "a": {"findings": ["resent 30%"]}}}}})
    assert ha.sniffer["0x0000000000000001"]["s"] == "warning"
    assert ha.sniffer["0x0000000000000001"]["signal"] == -70
    assert ha.sniffer["0x0000000000000001"]["findings"] == ["resent 30%"]
    ha._entities({"r": ["sensor.h"]})
    assert "0x0000000000000001" not in ha.sniffer
    assert [k for k, _ in seen] == ["sniffer", "sniffer", "sniffer"]


# ---------------------------------------------------------------------- static

def test_static_gzip_and_caching(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html>" + "x" * 2000)
    (tmp_path / "assets" / "a-1.js").write_text("console.log(1);" * 200)
    (tmp_path.parent / "secret.txt").write_text("no")

    async def run():
        st = main.Static(tmp_path)
        app = web.Application()
        app.router.add_get("/", st.serve)
        app.router.add_get("/{path:.+}", st.serve)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            async with aiohttp.ClientSession(auto_decompress=False) as s:
                async with s.get(f"http://127.0.0.1:{port}/", headers={"Accept-Encoding": "gzip"}) as r:
                    assert r.headers["Content-Encoding"] == "gzip"
                    assert r.headers["Cache-Control"] == "no-cache"
                    assert gzip.decompress(await r.read()).startswith(b"<!doctype html>")
                async with s.get(f"http://127.0.0.1:{port}/assets/a-1.js", headers={"Accept-Encoding": "identity"}) as r:
                    assert "immutable" in r.headers["Cache-Control"]
                    assert "Content-Encoding" not in r.headers
                async with s.get(f"http://127.0.0.1:{port}/..%2Fsecret.txt") as r:
                    assert r.status == 404
        finally:
            await runner.cleanup()
    asyncio.run(run())


def test_changed_keys():
    assert z2m_mod.changed(None, {"a": 1}) == {"a": 1}
    assert z2m_mod.changed({"a": 1, "b": {"x": 1}}, {"a": 1, "b": {"x": 2}}) == {"b": {"x": 2}}


def test_picks_the_running_stable_z2m():
    addons = [
        {"slug": "core_mosquitto", "state": "started"},
        {"slug": "45df7312_zigbee2mqtt_edge", "state": "started"},
        {"slug": "45df7312_zigbee2mqtt", "state": "stopped"},
        {"slug": "a1b2c3d4_zigbee_studio", "state": "started"},
    ]
    assert main.pick_z2m(addons) == "45df7312_zigbee2mqtt_edge"
    addons[2]["state"] = "started"
    assert main.pick_z2m(addons) == "45df7312_zigbee2mqtt"
    assert main.pick_z2m([{"slug": "core_ssh"}]) is None


def test_device_detail_has_options_and_config():
    info = {"config": {"devices": {"0x0000000000000001": {"friendly_name": "Lamp A", "retain": True}},
                       "device_options": {"transition": 0.5}}}
    d = lean.device_detail(DEVICES[0], info)
    assert d["config"] == {"retain": True}, "friendly_name is not an option"
    assert d["global"] == {"transition": 0.5}
    assert d["endpoints"]["1"]["bindings"] == []


def test_cluster_names_are_slim():
    defs = {"clusters": {"genOnOff": {"ID": 6, "attributes": {"onOff": {"ID": 0, "type": 16}}, "commands": {"toggle": {}}}},
            "custom_clusters": {"0x0000000000000001": {"manuX": {"ID": 64516, "attributes": {"a": {}}, "commands": {}}}}}
    out = lean.clusters(defs, "0x0000000000000001")
    assert out["clusters"]["genOnOff"] == {"id": 6, "attributes": ["onOff"], "commands": ["toggle"]}
    assert out["custom"]["manuX"]["attributes"] == ["a"]


def test_bridge_request_timeout_is_capped():
    async def run():
        fake, z, base, close = await _studio(control=True)
        seen = {}

        async def spy(topic, payload, timeout=30):
            seen["timeout"] = timeout
            return {"status": "ok", "data": {}}
        z.request = spy
        hub = Hub(z, hass.HomeAssistant(None), main.VERSION, True)
        try:
            await hub.op({"op": "req", "topic": "device/ota_update/update", "payload": {"id": "x"}, "timeout": 99999})
            assert seen["timeout"] == 4 * 3600
            await hub.op({"op": "req", "topic": "permit_join", "payload": {}})
            assert seen["timeout"] == 30
            schema = await hub.op({"op": "schema"})
            assert isinstance(schema, dict)
        finally:
            await close()
    asyncio.run(run())
