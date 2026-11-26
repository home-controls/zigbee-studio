"""One connection to Zigbee2MQTT's frontend WebSocket (the API its own page uses), kept up with
reconnects. Everything Zigbee2MQTT says is kept here, and each change is handed to the listener
as a small event, so web pages get a compact snapshot and then only what changed.

Zigbee2MQTT's own configuration is never touched: this is one more client of the WebSocket it
already serves. With `read_only` set, nothing at all is sent to it (send() refuses), whatever a
page asks for.
"""

import asyncio
import itertools
import json
import logging
import re
import time
from collections import deque
from typing import Any, Awaitable, Callable

import aiohttp

log = logging.getLogger("z2m")

Provider = Callable[[], Awaitable[tuple[str, dict]]]  # -> (ws url, extra headers)
Listener = Callable[..., None]

CACHE_DUMP_S = 3.0  # Zigbee2MQTT replays its cached states right after a connect: not "heard"
LOG_KEEP = 1000
EVENT_KEEP = 300
REQUEST_TIMEOUT_S = 30.0
_MISSING = object()
# Zigbee2MQTT 2.x writes the namespace into the message ("zhc:tz: Read result of ...") and
# usually sends no namespace field with bridge/logging; its namespaces start z2m / zh / zhc.
NS_PREFIX = re.compile(r"((?:z2m|zhc|zh)(?::[\w.-]+)*): ")


def split_ns(message: str, namespace: str | None) -> tuple[str, str]:
    """(namespace, message without it), however Zigbee2MQTT sent them."""
    if namespace:
        return namespace, message.removeprefix(f"{namespace}: ")
    m = NS_PREFIX.match(message)
    return (m.group(1), message[m.end():]) if m else ("", message)


def changed(old: dict | None, new: dict) -> dict:
    """The keys of `new` whose values differ from `old` (all of them if there was no old)."""
    if not old:
        return dict(new)
    return {k: v for k, v in new.items() if old.get(k, _MISSING) != v}


class Z2M:
    def __init__(self, provider: Provider, read_only: bool = True) -> None:
        self.provider = provider
        self.read_only = read_only
        self.connected = False
        self.bridge_state: str | None = None
        self.info: dict = {}
        self.devices: dict[str, dict] = {}  # ieee -> Zigbee2MQTT's device entry
        self.groups: dict[str, dict] = {}  # "g<id>" -> group entry
        self.names: dict[str, str] = {}  # friendly name -> key (ieee or "g<id>")
        self.states: dict[str, dict] = {}  # key -> last state
        self.avail: dict[str, str] = {}  # key -> online / offline
        self.heard: dict[str, float] = {}  # key -> when a message last came from it (not the cache replay)
        self.health: dict | None = None
        self.extensions: list[str] = []
        self.converters: list[str] = []
        self.definitions: dict | None = None
        self.logs: deque = deque(maxlen=LOG_KEEP)
        self.events: deque = deque(maxlen=EVENT_KEEP)
        self.connects = 0
        self._listeners: list[Listener] = []
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._tid = itertools.count(1)
        self._connected_at = 0.0
        self._replayed: set[str] = set()  # keys whose cached state arrived since the connect
        self._unresolved: dict[str, dict] = {}  # state for a name not (yet) in bridge/devices
        self._unresolved_avail: dict[str, Any] = {}

    # ------------------------------------------------------------------ listeners

    def listen(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def _emit(self, kind: str, *args: Any) -> None:
        for fn in self._listeners:
            try:
                fn(kind, *args)
            except Exception:  # a broken listener must not stop the connection
                log.exception("listener failed on %s", kind)

    # ------------------------------------------------------------------ connection

    async def run(self) -> None:
        delay = 1.0
        async with aiohttp.ClientSession() as session:
            while True:
                try:
                    url, headers = await self.provider()
                    async with session.ws_connect(url, headers=headers, heartbeat=30, max_msg_size=0) as ws:
                        self._ws = ws
                        self._on_connect()
                        delay = 1.0
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                self.feed(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                                break
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # unreachable, refused, dropped: try again
                    log.warning("Zigbee2MQTT connection: %s", e or type(e).__name__)
                finally:
                    if self._ws is not None:
                        self._ws = None
                        self._on_disconnect()
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15.0)

    def _on_connect(self) -> None:
        self.connected = True
        self.connects += 1
        self._connected_at = time.monotonic()
        self._replayed.clear()
        log.info("Connected to Zigbee2MQTT")
        self._emit("conn", True)

    def _on_disconnect(self) -> None:
        self.connected = False
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("Zigbee2MQTT disconnected"))
        self._pending.clear()
        log.info("Disconnected from Zigbee2MQTT")
        self._emit("conn", False)

    # ------------------------------------------------------------------ sending

    async def send(self, topic: str, payload: Any) -> None:
        """Publish through Zigbee2MQTT (topic relative to its base topic)."""
        if self.read_only:
            raise PermissionError("Zigbee Studio is read-only: turn on Allow control in the add-on's configuration")
        if self._ws is None:
            raise ConnectionError("Not connected to Zigbee2MQTT")
        await self._ws.send_str(json.dumps({"topic": topic, "payload": payload}))

    async def request(self, topic: str, payload: dict | None = None, timeout: float = REQUEST_TIMEOUT_S) -> dict:
        """A bridge request (e.g. 'device/rename'); returns Zigbee2MQTT's response payload."""
        tid = f"zs-{next(self._tid)}"
        fut = asyncio.get_running_loop().create_future()
        self._pending[tid] = fut
        try:
            await self.send(f"bridge/request/{topic}", {**(payload or {}), "transaction": tid})
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(tid, None)

    def name_of(self, key: str) -> str | None:
        """Current friendly name of a device (ieee) or group ("g<id>")."""
        entry = self.devices.get(key) or self.groups.get(key)
        return entry.get("friendly_name") if entry else None

    # ------------------------------------------------------------------ receiving

    def feed(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
            topic, payload = msg["topic"], msg.get("payload")
        except (ValueError, KeyError, TypeError):
            return
        if topic.startswith("bridge/"):
            self._bridge(topic[7:], payload)
            return
        if topic in self.names or topic in self._unresolved:
            self._state(topic, payload)
            return
        if topic.endswith("/availability"):
            name = topic[: -len("/availability")]
            if name in self.names:
                self._availability(name, payload)
            else:
                self._unresolved_avail[name] = payload
            return
        if isinstance(payload, dict) and "/" not in topic:
            self._state(topic, payload)  # a device bridge/devices hasn't listed yet

    def _bridge(self, sub: str, payload: Any) -> None:
        if sub == "state":
            state = payload.get("state") if isinstance(payload, dict) else payload
            if state != self.bridge_state:
                was, self.bridge_state = self.bridge_state, state
                if was is not None:
                    self._event("bridge", {"state": state})
                self._emit("bridge")
        elif sub == "info":
            self.info = payload or {}
            self._emit("bridge")
        elif sub == "devices":
            self._set_devices(payload or [])
        elif sub == "groups":
            self.groups = {f"g{g['id']}": g for g in payload or [] if "id" in g}
            self._reindex()
            self._emit("groups")
        elif sub == "health":
            self.health = payload
            self._emit("health")
        elif sub == "extensions":
            self.extensions = [e.get("name", "?") for e in payload or []]
            self._emit("bridge")
        elif sub == "converters":
            self.converters = [c.get("name", "?") for c in payload or []]
            self._emit("bridge")
        elif sub == "definitions":
            self.definitions = payload
        elif sub == "logging":
            if isinstance(payload, dict):
                ns, msg = split_ns(str(payload.get("message", "")), payload.get("namespace"))
                entry = {"ts": time.time(), "level": payload.get("level", "info"), "ns": ns, "msg": msg}
                self.logs.append(entry)
                self._emit("log", entry)
        elif sub == "event":
            if isinstance(payload, dict):
                data = payload.get("data") or {}
                key = data.get("ieee_address") or self.names.get(data.get("friendly_name", ""))
                self._event(payload.get("type", "event"), {**data, "key": key})
        elif sub.startswith("response/"):
            tid = payload.get("transaction") if isinstance(payload, dict) else None
            fut = self._pending.get(tid) if tid else None
            if fut and not fut.done():
                fut.set_result(payload)

    def _set_devices(self, devices: list) -> None:
        old = self.devices
        self.devices = {d["ieee_address"]: d for d in devices if "ieee_address" in d}
        if old:
            for ieee in self.devices.keys() - old.keys():
                self._event("device_added", {"key": ieee, "friendly_name": self.devices[ieee].get("friendly_name")})
            for ieee in old.keys() - self.devices.keys():
                self._event("device_removed", {"key": ieee, "friendly_name": old[ieee].get("friendly_name")})
                self.states.pop(ieee, None)
                self.avail.pop(ieee, None)
        self._reindex()
        for name in list(self._unresolved):  # states that came before their device was listed
            if name in self.names:
                self._state(name, self._unresolved.pop(name))
        for name in list(self._unresolved_avail):
            if name in self.names:
                self._availability(name, self._unresolved_avail.pop(name))
        self._emit("devices")

    def _reindex(self) -> None:
        self.names = {d["friendly_name"]: k for k, d in self.devices.items() if d.get("friendly_name")}
        self.names.update({g["friendly_name"]: k for k, g in self.groups.items() if g.get("friendly_name")})

    def _state(self, name: str, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        key = self.names.get(name)
        if key is None:
            self._unresolved[name] = {**self._unresolved.get(name, {}), **payload}
            return
        old = self.states.get(key)
        diff = changed(old, payload)
        self.states[key] = {**(old or {}), **payload}
        replay = key not in self._replayed and time.monotonic() - self._connected_at < CACHE_DUMP_S
        self._replayed.add(key)
        if not replay:
            self.heard[key] = time.time()
        if diff or not replay:
            self._emit("state", key, diff, None if replay else self.heard[key])

    def _availability(self, name: str, payload: Any) -> None:
        value = payload.get("state") if isinstance(payload, dict) else payload
        key = self.names[name]
        was = self.avail.get(key)
        if value == was:
            return
        self.avail[key] = value
        if was is not None:
            self._event("availability", {"key": key, "friendly_name": name, "state": value})
        self._emit("avail", key, value)

    def _event(self, kind: str, data: dict) -> None:
        entry = {"ts": time.time(), "type": kind, **data}
        self.events.append(entry)
        self._emit("event", entry)
