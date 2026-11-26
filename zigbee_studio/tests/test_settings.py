"""0.5.0: Zigbee2MQTT's settings and tools from Studio. Settings that would cut Zigbee2MQTT off
from its adapter, the network, MQTT, Home Assistant or Studio are refused in the hub, not only
greyed out on the page; requests that run code in Zigbee2MQTT are never sent."""

import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import hass  # noqa: E402
import main  # noqa: E402
from hub import LOCKED, Hub, touches_locked  # noqa: E402
from z2m import Z2M  # noqa: E402


def test_what_a_change_touches():
    assert touches_locked({"advanced": {"log_level": "debug", "transmit_power": 10}}) == []
    assert touches_locked({"advanced": {"channel": 15}}) == ["advanced.channel"]
    assert touches_locked({"advanced": None}) == ["advanced"]  # removing the section takes the channel with it
    assert touches_locked({"serial": {"disable_led": True}}) == []
    assert touches_locked({"serial": {"port": "/dev/ttyUSB1"}}) == ["serial.port"]
    assert touches_locked({"mqtt": {"base_topic": "z"}, "frontend": {"port": 8080}}) == ["mqtt.base_topic", "frontend.port"]
    assert touches_locked({"frontend": {"package": "zigbee2mqtt-windfront"}}) == []
    assert touches_locked({"homeassistant": {"enabled": False}}) == ["homeassistant.enabled"]
    assert touches_locked({"homeassistant": {"experimental_event_entities": True}}) == []
    assert touches_locked({"devices": {"0x01": {"retain": True}}}) == ["devices"]
    assert touches_locked({"advanced": {"enable_external_js": False}}) == ["advanced.enable_external_js"]
    assert all(LOCKED.values())


def _hub(control: bool = True, info: dict | None = None):
    async def provider():
        return "ws://127.0.0.1:1/api", {}

    z = Z2M(provider, read_only=not control)
    z.info = info or {}
    sent: list[tuple[str, dict]] = []

    async def spy(topic, payload, timeout=30):
        sent.append((topic, payload))
        return {"status": "ok", "data": {"restart_required": True}}
    z.request = spy
    return Hub(z, hass.HomeAssistant(None), main.VERSION, control), sent


def test_options_are_checked_before_they_are_sent():
    async def run():
        hub, sent = _hub()
        d = await hub.op({"op": "req", "topic": "options", "payload": {"options": {"advanced": {"log_level": "debug"}}}})
        assert d == {"restart_required": True} and sent == [("options", {"options": {"advanced": {"log_level": "debug"}}})]
        for bad in ({"advanced": {"channel": 11}}, {"serial": None}, {"mqtt": {"server": "mqtt://x"}}, {}, None, "x"):
            with pytest.raises(ValueError):
                await hub.op({"op": "req", "topic": "options", "payload": {"options": bad}})
        assert len(sent) == 1
    asyncio.run(run())


def test_code_and_adapter_actions_are_never_sent():
    async def run():
        hub, sent = _hub()
        for topic in ("extension/save", "extension/remove", "converter/save", "converter/remove", "action"):
            with pytest.raises(ValueError):
                await hub.op({"op": "req", "topic": topic, "payload": {"name": "x.js", "code": "process.exit()"}})
        for topic in ("restart", "backup", "health_check", "coordinator_check", "touchlink/scan"):
            await hub.op({"op": "req", "topic": topic, "payload": {}})
        assert [t for t, _ in sent] == ["restart", "backup", "health_check", "coordinator_check", "touchlink/scan"]
    asyncio.run(run())


def test_the_settings_page_gets_values_schema_and_locks_even_read_only():
    async def run():
        hub, sent = _hub(control=False, info={"config": {"advanced": {"log_level": "info"}}, "restart_required": True,
                                              "config_schema": {"properties": {"advanced": {}}}})
        d = await hub.op({"op": "settings"})
        assert d["config"]["advanced"]["log_level"] == "info" and d["restart_required"] is True
        assert "advanced.channel" in d["locked"] and d["schema"]["properties"]
        with pytest.raises(PermissionError):
            await hub.op({"op": "req", "topic": "restart", "payload": {}})
        assert sent == []
    asyncio.run(run())


def test_a_groups_own_options_come_from_the_configuration():
    async def run():
        hub, _ = _hub(control=False, info={"config": {"groups": {
            "2": {"friendly_name": "Master Accents Group", "retain": True, "off_state": "last_member_state", "devices": ["0x01"]}}}})
        assert await hub.op({"op": "group_options", "group": 2}) == {"retain": True, "off_state": "last_member_state"}
        assert await hub.op({"op": "group_options", "group": 9}) == {}
    asyncio.run(run())
