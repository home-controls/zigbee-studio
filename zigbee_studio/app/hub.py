"""The browser side: one WebSocket per open page.

A page says hello (with the exposes hashes it already has from an earlier visit), gets one
snapshot, then only changes: a state message carries just the values that changed. Messages for a
page are queued and written by one task per page, so a burst (a group switching ten lights)
goes out as one batch, and a page that stops reading is dropped instead of holding up the rest.

Pages ask for things with {"op": ..., "id": n}: a device's details, a /set or /get, a bridge
request. Everything that would send something to Zigbee2MQTT is refused in read-only mode
(here, and again in Z2M.send).
"""

import asyncio
import json
import logging
import time
from typing import Any

import lean
import sniffer as sniffer_mod
from adapter import AdapterError
from aiohttp import WSMsgType, web
from sniffer import SnifferError

log = logging.getLogger("hub")

QUEUE_MAX = 5000  # a page this far behind is closed (it reconnects and gets a fresh snapshot)
HELLO_WAIT_S = 3.0
LOG_SNAPSHOT = 300
EVENT_SNAPSHOT = 100
WRITE_OPS = {"set", "get", "req", "map", "adapter_link", "adapter_unlink", "adapter_set"}

# Zigbee2MQTT settings Zigbee Studio shows but won't change (0.5.0): from a page, a slip would cut
# Zigbee2MQTT off from its adapter, every device, MQTT, Home Assistant or this add-on, or unload the
# external converters the house's devices depend on. They belong in the Zigbee2MQTT add-on's own
# configuration. A change touching one (or a section holding one) is refused here, not only greyed
# out on the page.
_NETWORK = "the network's identity: every device would have to be paired again"
_ADAPTER = "how Zigbee2MQTT reaches its adapter: set it in the Zigbee2MQTT add-on's configuration"
_MQTT = "how Zigbee2MQTT reaches MQTT and where Home Assistant and the Zigbee Sniffer listen"
_FRONTEND = "how Home Assistant and Zigbee Studio reach Zigbee2MQTT"
_HA = "Home Assistant's Zigbee devices and entities depend on it"
LOCKED = {
    "advanced.channel": _NETWORK, "advanced.pan_id": _NETWORK, "advanced.ext_pan_id": _NETWORK,
    "advanced.network_key": _NETWORK,
    "advanced.enable_external_js": "turning it off unloads your external converters and extensions",
    "serial.port": _ADAPTER, "serial.adapter": _ADAPTER, "serial.baudrate": _ADAPTER, "serial.rtscts": _ADAPTER,
    "mqtt.server": _MQTT, "mqtt.base_topic": _MQTT, "mqtt.user": _MQTT, "mqtt.password": _MQTT, "mqtt.ca": _MQTT,
    "mqtt.key": _MQTT, "mqtt.cert": _MQTT,
    "frontend.enabled": _FRONTEND, "frontend.port": _FRONTEND, "frontend.host": _FRONTEND,
    "frontend.auth_token": _FRONTEND, "frontend.ssl_cert": _FRONTEND, "frontend.ssl_key": _FRONTEND,
    "frontend.base_url": _FRONTEND,
    "homeassistant.enabled": _HA, "homeassistant.discovery_topic": _HA, "homeassistant.status_topic": _HA,
    "devices": "each device's own settings: on its page", "groups": "each group's own settings: on the Groups page",
    "version": "the settings file's format",
}
# requests that run code in Zigbee2MQTT or reach into the adapter: never sent from a page
REFUSED = ("extension/", "converter/", "action")


def touches_locked(options: Any, path: str = "") -> list[str]:
    """The locked settings a change to `options` would touch, at any depth (removing a section
    with null touches everything in it)."""
    if not isinstance(options, dict):
        return []
    hits = []
    for k, v in options.items():
        here = f"{path}.{k}" if path else str(k)
        if here in LOCKED or any(lk.startswith(here + ".") for lk in LOCKED) and not isinstance(v, dict):
            hits.append(here)
        elif isinstance(v, dict):
            hits += touches_locked(v, here)
    return hits


def dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


class Client:
    def __init__(self, ws: web.WebSocketResponse) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.task: asyncio.Task | None = None
        self.have: set[str] = set()

    def push(self, text: str) -> bool:
        if self.queue.qsize() >= QUEUE_MAX:
            return False
        self.queue.put_nowait(text)
        return True

    async def writer(self) -> None:
        try:
            while True:
                first = await self.queue.get()
                batch = [first]
                while not self.queue.empty() and len(batch) < 500:
                    batch.append(self.queue.get_nowait())
                await self.ws.send_str(first if len(batch) == 1 else '{"t":"b","m":[' + ",".join(batch) + "]}")
        except (ConnectionError, RuntimeError, asyncio.CancelledError):
            pass


class Hub:
    def __init__(self, z2m, ha, version: str, control: bool, windfront: str | None = None, sniffer=None,
                 sniffer_panel=None, adapter=None) -> None:
        self.z2m = z2m
        self.adapter = adapter
        self.ha = ha
        self.sniffer = sniffer
        self.sniffer_panel = sniffer_panel
        self.version = version
        self.control = control
        self.windfront = windfront
        self.clients: set[Client] = set()
        self.stats = {"pages": 0, "sent": 0}
        z2m.listen(self._on_z2m)
        if ha is not None:
            ha.listen(self._on_ha)

    def panel(self) -> str | None:
        """The Sniffer's panel path: a string, or a callable when it is looked up as it comes and goes
        (its add-on ID depends on the store it was installed from)."""
        p = self.sniffer_panel
        return p() if callable(p) else p

    # ------------------------------------------------------------------ fan-out

    def broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        text = dumps(msg)
        for c in list(self.clients):
            if not c.push(text):
                log.warning("A page fell %d messages behind; closing it", QUEUE_MAX)
                self.clients.discard(c)
                asyncio.ensure_future(c.ws.close())
        self.stats["sent"] += 1

    def _on_z2m(self, kind: str, *args: Any) -> None:
        z = self.z2m
        if kind == "state":
            key, diff, heard = args
            msg = {"t": "s", "k": key, "p": diff}
            if heard:
                msg["h"] = round(heard)
            self.broadcast(msg)
        elif kind == "avail":
            self.broadcast({"t": "a", "k": args[0], "v": args[1]})
        elif kind == "log":
            self.broadcast({"t": "l", "e": args[0]})
        elif kind == "event":
            self.broadcast({"t": "e", "e": args[0]})
        elif kind in ("bridge", "conn"):
            self.broadcast({"t": "bridge", "b": lean.bridge(z)})
        elif kind == "devices":
            self._send_devices()
        elif kind == "groups":
            self.broadcast({"t": "groups", "g": [lean.group(k, g) for k, g in z.groups.items()]})
        elif kind == "health":
            self.broadcast({"t": "health", "h": lean.health(z.health)})

    def _send_devices(self) -> None:
        rows, table = lean.devices(self.z2m.devices)
        text = None
        for c in list(self.clients):
            missing = {h: x for h, x in table.items() if h not in c.have}
            c.have.update(missing)
            if missing:
                c.push(dumps({"t": "devices", "d": rows, "x": missing}))
            else:
                text = text or dumps({"t": "devices", "d": rows, "x": {}})
                c.push(text)

    def _on_ha(self, kind: str, *args: Any) -> None:
        if kind == "rooms":
            self.broadcast({"t": "rooms", "r": self.ha.rooms()})
        elif kind == "sniffer":
            self.broadcast({"t": "sn", "k": args[0], "v": args[1]})

    # ------------------------------------------------------------------ snapshot

    def snapshot(self, have: set[str]) -> dict:
        z = self.z2m
        rows, table = lean.devices(z.devices)
        missing = {h: x for h, x in table.items() if h not in have}
        logs = list(z.logs)[-LOG_SNAPSHOT:]
        events = list(z.events)[-EVENT_SNAPSHOT:]
        return {
            "t": "snap",
            "v": self.version,
            "control": self.control,
            "windfront": self.windfront,
            "snp": self.panel() if self.sniffer is not None else None,
            "now": round(time.time(), 1),
            "bridge": lean.bridge(z),
            "devices": rows,
            "x": missing,
            "groups": [lean.group(k, g) for k, g in z.groups.items()],
            "states": z.states,
            "avail": z.avail,
            "heard": {k: round(v) for k, v in z.heard.items()},
            "health": lean.health(z.health),
            "rooms": self.ha.rooms() if self.ha is not None else None,
            "sniffer": self.ha.sniffer if self.ha is not None else {},
            "logs": logs,
            "events": events,
            "adp": self.adapter_info(),
        }

    def adapter_info(self) -> dict | None:
        if self.adapter is None:
            return None
        return self.adapter.info(((self.z2m.info or {}).get("config")) or {})

    # ------------------------------------------------------------------ one page

    async def handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=25, compress=True, max_msg_size=1024 * 1024)
        await ws.prepare(request)
        client = Client(ws)
        try:
            first = await asyncio.wait_for(ws.receive(), HELLO_WAIT_S)
            if first.type == WSMsgType.TEXT:
                hello = json.loads(first.data)
                if hello.get("op") == "hello":
                    client.have = {h for h in hello.get("have") or [] if isinstance(h, str)}
        except (asyncio.TimeoutError, ValueError):
            pass
        snap = dumps(self.snapshot(client.have))
        client.have.update(lean.devices(self.z2m.devices)[1])
        self.clients.add(client)  # changes from here on queue up behind the snapshot
        self.stats["pages"] += 1
        try:
            await ws.send_str(snap)
            client.task = asyncio.create_task(client.writer())
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    req = json.loads(msg.data)
                except ValueError:
                    continue
                asyncio.create_task(self._answer(client, req))
        except (ConnectionError, RuntimeError):
            pass
        finally:
            self.clients.discard(client)
            if client.task:
                client.task.cancel()
        return ws

    async def _answer(self, client: Client, req: dict) -> None:
        rid = req.get("id")
        try:
            data = await self.op(req)
            reply = {"t": "r", "id": rid, "ok": True, "d": data}
        except PermissionError as e:
            reply = {"t": "r", "id": rid, "ok": False, "e": str(e), "ro": True}
        except (LookupError, ValueError, ConnectionError, asyncio.TimeoutError, SnifferError, AdapterError) as e:
            reply = {"t": "r", "id": rid, "ok": False, "e": str(e) or type(e).__name__}
        except Exception as e:
            log.exception("op %s failed", req.get("op"))
            reply = {"t": "r", "id": rid, "ok": False, "e": f"{type(e).__name__}: {e}"}
        if rid is not None:
            client.push(dumps(reply))

    async def op(self, req: dict) -> Any:
        op = req.get("op")
        z = self.z2m
        if op in WRITE_OPS and not self.control:
            raise PermissionError("Zigbee Studio is read-only: turn on Allow control in the add-on's configuration")
        if op == "device":
            d = z.devices.get(req.get("key", ""))
            if d is None:
                raise LookupError("No such device")
            return lean.device_detail(d, z.info)
        if op == "schema":
            return (z.info or {}).get("config_schema") or {}
        if op == "config":
            return (z.info or {}).get("config") or {}
        if op == "settings":  # Zigbee2MQTT's settings page: values, schema, what Studio won't change
            info = z.info or {}
            return {"config": info.get("config") or {}, "schema": info.get("config_schema") or {},
                    "locked": LOCKED, "restart_required": bool(info.get("restart_required"))}
        if op == "clusters":
            return lean.clusters(z.definitions, req.get("key"))
        if op == "logs":
            return list(z.logs)
        if op == "group_options":  # a group's own options in Zigbee2MQTT's configuration (reading)
            groups_cfg = ((z.info or {}).get("config") or {}).get("groups") or {}
            own = dict(groups_cfg.get(str(req.get("group"))) or {})  # not "id": that names the request
            for k in ("friendly_name", "devices", "ID"):
                own.pop(k, None)
            return own
        if op == "sniffer":  # reading only: allowed without control
            if self.sniffer is None:
                raise LookupError("No Zigbee Sniffer")
            return await self.sniffer.get(str(req.get("path") or ""), req.get("q") or {})
        if op == "map":  # a floor-map change in the Sniffer (floors, scale, positions); plans go over HTTP
            if self.sniffer is None:
                raise LookupError("No Zigbee Sniffer")
            method, path, body = sniffer_mod.map_change(str(req.get("action") or ""), req.get("args") or {})
            return await self.sniffer.write(method, path, body)
        if op and op.startswith("adapter"):
            return await self._adapter_op(op, req)
        if op in ("set", "get"):
            key = req.get("key", "")
            name = z.name_of(key)
            if name is None:
                raise LookupError("No such device or group")
            payload = req.get("payload")
            if not isinstance(payload, dict) or not payload:
                raise ValueError("Nothing to send")
            ep = req.get("endpoint")
            topic = f"{name}/{ep}/{op}" if ep else f"{name}/{op}"
            await z.send(topic, payload)
            return None
        if op == "req":
            topic = str(req.get("topic") or "")
            if not topic or topic.startswith("/") or ".." in topic:
                raise ValueError("Bad request topic")
            if topic.startswith(REFUSED):
                raise ValueError("Zigbee Studio doesn't send that request (use Zigbee2MQTT's own page)")
            if topic == "options":
                options = (req.get("payload") or {}).get("options")
                if not isinstance(options, dict) or not options:
                    raise ValueError("Nothing to change")
                hits = touches_locked(options)
                if hits:
                    raise ValueError(f"{hits[0]} can't be changed from Zigbee Studio: "
                                     f"{LOCKED.get(hits[0]) or 'it holds settings Studio leaves alone'}")
            timeout = min(max(float(req.get("timeout") or 30), 1.0), 4 * 3600.0)  # an OTA update answers when done
            res = await z.request(topic, req.get("payload") or {}, timeout=timeout)
            if res.get("status") == "error":
                raise ValueError(res.get("error") or "Zigbee2MQTT refused it")
            return res.get("data")
        raise ValueError(f"Unknown op {op!r}")
    async def _adapter_op(self, op: str, req: dict) -> Any:
        """The network adapter: reading is allowed without control; linking and changes need it."""
        a = self.adapter
        if a is None:
            raise LookupError("No network adapter support")
        if op == "adapter_info":
            return self.adapter_info()
        if op == "adapter":
            return await a.get(req.get("path"), req.get("q") or {})
        if op == "adapter_link":
            status = await a.link(req.get("host"), req.get("token"))
            self.broadcast({"t": "adp", "a": self.adapter_info()})
            return {"fw": status.get("fw"), "eth": status.get("eth")}
        if op == "adapter_unlink":
            a.unlink()
            self.broadcast({"t": "adp", "a": self.adapter_info()})
            return None
        if op == "adapter_set":
            return await a.change(req.get("action"), req.get("args") or {})
        raise ValueError(f"Unknown op {op!r}")
