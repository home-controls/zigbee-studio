"""Home Assistant's side: floors, areas and devices (so Zigbee devices show by room) and the
Zigbee Sniffer's per-device "Zigbee health" sensors, kept live over Core's WebSocket API.

Read-only: it lists registries and subscribes to states and registry changes, nothing else.
Inside the add-on it goes through the Supervisor's proxy with the add-on's token; outside one
(development) the provider gives Home Assistant's address and a long-lived token.
"""

import asyncio
import itertools
import logging
import re
from typing import Any, Awaitable, Callable

import aiohttp

log = logging.getLogger("hass")

Provider = Callable[[], Awaitable[tuple[str, str]]]  # -> (ws url, token)
Listener = Callable[..., None]

Z2M_ID = re.compile(r"^zigbee2mqtt_(0x[0-9a-fA-F]{16})$")
Z2M_GROUP_ID = re.compile(r"^zigbee2mqtt_1221051039810110150109113116116_(\d+)$")
SNIFFER_UID = re.compile(r"^zigbee_sniffer_(0x[0-9a-fA-F]{16})_health$")
REGISTRY_EVENTS = ("floor_registry_updated", "area_registry_updated", "device_registry_updated", "entity_registry_updated")


def sniffer_health(state: str, attrs: dict) -> dict:
    """The Zigbee Sniffer's health sensor, in the page's terms."""
    return {
        "s": state,
        "findings": attrs.get("findings") or [],
        "signal": attrs.get("signal_at_sniffer"),
        "by": attrs.get("heard_best_by"),
        "resent": attrs.get("resent_pct"),
        "noack": attrs.get("no_ack_pct"),
        "lost": attrs.get("lost_pct"),
        "cost": attrs.get("best_link_cost"),
        "nb": attrs.get("mesh_neighbours"),
        "hop": attrs.get("next_hop"),
        "msgs": attrs.get("messages_last_hour"),
        "heard": attrs.get("last_heard"),
    }


class HomeAssistant:
    def __init__(self, provider: Provider | None) -> None:
        self.provider = provider
        self.connected = False
        self.floors: list[dict] = []
        self.areas: list[dict] = []
        self.dev: dict[str, dict] = {}  # ieee or "g<id>" -> {"area": area_id, "id": ha device id}
        self.sniffer: dict[str, dict] = {}  # ieee -> sniffer_health(...)
        self._sniffer_entities: dict[str, str] = {}  # entity_id -> ieee
        self._sniffer_attrs: dict[str, dict] = {}  # entity_id -> raw attributes (changes come as diffs)
        self._sniffer_state: dict[str, str] = {}
        self._listeners: list[Listener] = []
        self._ids = itertools.count(1)
        self._refresh = asyncio.Event()

    def listen(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def _emit(self, kind: str, *args: Any) -> None:
        for fn in self._listeners:
            try:
                fn(kind, *args)
            except Exception:
                log.exception("listener failed on %s", kind)

    def rooms(self) -> dict:
        return {"floors": self.floors, "areas": self.areas, "dev": self.dev}

    # ------------------------------------------------------------------ connection

    async def run(self) -> None:
        if self.provider is None:
            log.info("No Home Assistant API (not running as an add-on): rooms and sniffer health are off")
            return
        delay = 2.0
        async with aiohttp.ClientSession() as session:
            while True:
                try:
                    url, token = await self.provider()
                    async with session.ws_connect(url, heartbeat=30, max_msg_size=0) as ws:
                        await self._session(ws, token)
                        delay = 2.0
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    log.warning("Home Assistant connection: %s", e or type(e).__name__)
                if self.connected:
                    self.connected = False
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def _session(self, ws: aiohttp.ClientWebSocketResponse, token: str) -> None:
        hello = await ws.receive_json()
        if hello.get("type") == "auth_required":
            await ws.send_json({"type": "auth", "access_token": token})
            if (await ws.receive_json()).get("type") != "auth_ok":
                raise PermissionError("Home Assistant refused the token")
        self.connected = True
        replies: dict[int, asyncio.Future] = {}
        subs: dict[int, str] = {}

        async def call(msg: dict) -> Any:
            i = next(self._ids)
            fut = asyncio.get_running_loop().create_future()
            replies[i] = fut
            await ws.send_json({"id": i, **msg})
            res = await asyncio.wait_for(fut, 60)
            return res

        async def subscribe(msg: dict, kind: str) -> None:
            i = next(self._ids)
            subs[i] = kind
            fut = asyncio.get_running_loop().create_future()
            replies[i] = fut
            await ws.send_json({"id": i, **msg})
            await asyncio.wait_for(fut, 60)

        async def reader() -> None:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                data = msg.json()
                for m in data if isinstance(data, list) else [data]:
                    i = m.get("id")
                    if m.get("type") == "result" and i in replies:
                        fut = replies.pop(i)
                        if not fut.done():
                            if m.get("success"):
                                fut.set_result(m.get("result"))
                            else:
                                fut.set_exception(RuntimeError(str(m.get("error"))))
                    elif m.get("type") == "event" and i in subs:
                        if subs[i] == "registry":
                            self._refresh.set()
                        elif subs[i] == "entities":
                            self._entities(m.get("event") or {})
            raise ConnectionError("Home Assistant closed the connection")

        read_task = asyncio.create_task(reader())
        try:
            await self._load(call)
            for ev in REGISTRY_EVENTS:
                await subscribe({"type": "subscribe_events", "event_type": ev}, "registry")
            if self._sniffer_entities:
                await subscribe({"type": "subscribe_entities", "entity_ids": list(self._sniffer_entities)}, "entities")
            while True:
                waiter = asyncio.create_task(self._refresh.wait())
                done, _ = await asyncio.wait({read_task, waiter}, return_when=asyncio.FIRST_COMPLETED)
                if read_task in done:
                    waiter.cancel()
                    read_task.result()
                    return
                await asyncio.sleep(1.0)  # registry edits come in bursts
                self._refresh.clear()
                before = set(self._sniffer_entities)
                await self._load(call)
                if set(self._sniffer_entities) - before:
                    await subscribe({"type": "subscribe_entities", "entity_ids": list(self._sniffer_entities)}, "entities")
        finally:
            read_task.cancel()

    async def _load(self, call) -> None:
        floors = await call({"type": "config/floor_registry/list"})
        areas = await call({"type": "config/area_registry/list"})
        devices = await call({"type": "config/device_registry/list"})
        entities = await call({"type": "config/entity_registry/list"})
        self.floors = sorted(
            ({"id": f["floor_id"], "name": f.get("name"), "level": f.get("level"), "icon": f.get("icon")} for f in floors or []),
            key=lambda f: (f["level"] is None, -(f["level"] or 0), f["name"] or ""))  # top floor first
        self.areas = sorted(
            ({"id": a["area_id"], "name": a.get("name"), "floor": a.get("floor_id"), "icon": a.get("icon")} for a in areas or []),
            key=lambda a: (a["name"] or "").lower())
        dev = {}
        for d in devices or []:
            for parts in d.get("identifiers") or []:
                if len(parts) < 2 or parts[0] != "mqtt":
                    continue
                ident = parts[1]
                m = Z2M_ID.match(str(ident))
                key = m.group(1).lower() if m else None
                if key is None and (g := Z2M_GROUP_ID.match(str(ident))):
                    key = f"g{g.group(1)}"
                if key:
                    dev[key] = {"area": d.get("area_id"), "id": d.get("id"), "ha_name": d.get("name_by_user")}
        self.dev = dev
        self._sniffer_entities = {
            e["entity_id"]: m.group(1).lower()
            for e in entities or [] if e.get("platform") == "mqtt" and (m := SNIFFER_UID.match(e.get("unique_id") or ""))
        }
        self._emit("rooms")

    def _entities(self, ev: dict) -> None:
        """subscribe_entities' compressed states: a = added (full), c = changed (+ diff / - removed
        attributes), r = removed."""
        touched = set()
        for eid, st in (ev.get("a") or {}).items():
            self._sniffer_state[eid] = st.get("s")
            self._sniffer_attrs[eid] = dict(st.get("a") or {})
            touched.add(eid)
        for eid, ch in (ev.get("c") or {}).items():
            plus, minus = ch.get("+") or {}, ch.get("-") or {}
            if "s" in plus:
                self._sniffer_state[eid] = plus["s"]
            attrs = self._sniffer_attrs.setdefault(eid, {})
            attrs.update(plus.get("a") or {})
            for k in minus.get("a") or []:
                attrs.pop(k, None)
            touched.add(eid)
        for eid in ev.get("r") or []:
            ieee = self._sniffer_entities.get(eid)
            if ieee and self.sniffer.pop(ieee, None) is not None:
                self._emit("sniffer", ieee, None)
        for eid in touched:
            ieee = self._sniffer_entities.get(eid)
            if not ieee:
                continue
            row = sniffer_health(self._sniffer_state.get(eid) or "unknown", self._sniffer_attrs.get(eid) or {})
            if self.sniffer.get(ieee) != row:
                self.sniffer[ieee] = row
                self._emit("sniffer", ieee, row)
