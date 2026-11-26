"""A stand-in for Zigbee2MQTT's frontend WebSocket, built from a recording (dev/record.py), so the
page can be developed - control included - without touching the real network.

On connect it replays the recorded snapshot, then the recorded live messages on a loop, with a
little jitter on link quality. /set changes the simulated state (and a group's members) and
publishes it back like Zigbee2MQTT would; bridge requests are answered "ok" (rename really renames).

  uv run --python 3.12 --with aiohttp==3.10.10 python dev/z2m_sim.py [port]
"""

import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path
# recordings and local state: .dev/ (STUDIO_DEV_DIR=.dev-demo for the anonymised demo set, see dev/demo_data.py)
DEV_DIR = Path(os.environ.get("STUDIO_DEV_DIR") or Path(__file__).resolve().parent.parent / ".dev")

from aiohttp import WSMsgType, web


REC = DEV_DIR / "z2m_recording.jsonl"
SNAP_S = 5.0


class Sim:
    def __init__(self, recording: Path = REC) -> None:
        recs = [json.loads(line) for line in recording.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.snapshot = [r["m"] for r in recs if r["t"] < SNAP_S]
        self.live = [(r["t"], r["m"]) for r in recs if r["t"] >= SNAP_S]
        self.bridge = {m["topic"]: m["payload"] for m in self.snapshot if m["topic"].startswith("bridge/")}
        self.states = {m["topic"]: m["payload"] for m in self.snapshot
                       if not m["topic"].startswith("bridge/") and not m["topic"].endswith("/availability")}
        self.avail = {m["topic"][:-13]: m["payload"] for m in self.snapshot if m["topic"].endswith("/availability")}
        self.clients: set[web.WebSocketResponse] = set()
        self.received: list[dict] = []

    def devices(self) -> list[dict]:
        return self.bridge.get("bridge/devices") or []

    def groups(self) -> list[dict]:
        return self.bridge.get("bridge/groups") or []

    async def publish(self, topic: str, payload) -> None:
        text = json.dumps({"topic": topic, "payload": payload})
        for ws in list(self.clients):
            try:
                await ws.send_str(text)
            except ConnectionError:
                self.clients.discard(ws)

    async def log(self, level: str, message: str, ns: str = "z2m") -> None:
        payload = {"level": level, "message": f"{ns}: {message}"}
        if payload == getattr(self, "_last_log", None):
            return  # like Zigbee2MQTT: never the same line twice in a row
        self._last_log = payload
        await self.publish("bridge/logging", payload)

    async def _console(self, name: str, payload: dict) -> None:
        """The dev console: read / write / command logged the way zigbee-herdsman-converters does
        (no device name in the line); an end device "is asleep" and times out."""
        dev = self._dev(name)
        if dev is None:
            await self.log("error", f"Entity '{name}' is unknown")
            return
        key = next(k for k in ("read", "write", "command") if k in payload)
        v = payload[key] or {}
        if dev.get("type") == "EndDevice":
            await asyncio.sleep(3)
            await self.log("error", f"Publish 'set' '{key}' to '{name}' failed: 'Error: ZCL command {name}/1 "
                                    f"{v.get('cluster')}.{key} failed (Timeout - 0x0, 'No response')'")
            return
        await asyncio.sleep(0.4)
        if key == "read":
            sample = {"modelId": dev.get("model_id") or dev.get("model") or "X", "manufacturerName": dev.get("manufacturer") or "Y",
                      "swBuildId": dev.get("software_build_id") or "1.0", "onOff": 1, "currentLevel": 128, "zclVersion": 8}
            result = {str(a): sample.get(str(a), 0) for a in v.get("attributes") or []}
            await self.log("info", f"Read result of '{v.get('cluster')}': {json.dumps(result, separators=(',', ':'))}", "zhc:tz")
        elif key == "write":
            await self.log("info", f"Wrote '{json.dumps(v.get('payload'), separators=(',', ':'))}' to '{v.get('cluster')}'", "zhc:tz")
        else:
            await self.log("info", f"Invoked '{v.get('cluster')}.{v.get('command')}' with payload "
                                   f"'{json.dumps(v.get('payload'), separators=(',', ':'))}'", "zhc:tz")

    def _apply_options(self, info: dict, options: dict) -> bool:
        """Zigbee2MQTT's settings.apply: objects merge, lists replace, null removes; True if a
        changed setting needs a restart (requiresRestart in the schema)."""
        schema = info.get("config_schema") or {}
        restart = False

        def merge(cfg: dict, new: dict, sch: dict) -> None:
            nonlocal restart
            for k, v in new.items():
                sub = ((sch or {}).get("properties") or {}).get(k) or {}
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    merge(cfg[k], v, sub)
                    continue
                if sub.get("requiresRestart"):
                    restart = True
                if v is None:
                    cfg.pop(k, None)
                else:
                    cfg[k] = v
        merge(info.setdefault("config", {}), options, schema)
        return restart

    def _apply(self, name: str, payload: dict) -> dict:
        st = dict(self.states.get(name) or {})
        for k, v in payload.items():
            if k.startswith("state") and isinstance(v, str) and v.upper() == "TOGGLE":
                v = "OFF" if st.get(k) == "ON" else "ON"
            if k == "color" and isinstance(v, dict):
                v = {**(st.get("color") or {}), **v}
            if k in ("transition",):
                continue
            st[k] = v
        if "brightness" in payload and st.get("state") == "OFF" and payload.get("brightness"):
            st["state"] = "ON"
        st["linkquality"] = max(0, min(255, int(st.get("linkquality") or 120) + random.randint(-6, 6)))
        self.states[name] = st
        return st

    async def on_message(self, msg: dict) -> None:
        topic, payload = msg.get("topic", ""), msg.get("payload")
        self.received.append(msg)
        if topic.startswith("bridge/request/"):
            await self.on_request(topic[15:], payload or {})
            return
        if topic.endswith("/set") and isinstance(payload, dict) and any(k in payload for k in ("read", "write", "command")):
            name = topic[:-4]
            if not self._dev(name) and "/" in name:
                name = name.rsplit("/", 1)[0]  # device/endpoint
            asyncio.create_task(self._console(name, payload))
            return
        if topic.endswith("/set") and isinstance(payload, dict):
            name = topic[:-4]
            await self.log("info", f"Simulated: set {name} {json.dumps(payload)}")
            await asyncio.sleep(0.08)
            if any(k.startswith("scene_") and k != "scene_recall" for k in payload):
                await self._scenes(name, payload)
                return
            group = next((g for g in self.groups() if g.get("friendly_name") == name), None)
            if group:
                by_ieee = {d["ieee_address"]: d["friendly_name"] for d in self.devices()}
                for m in group.get("members") or []:
                    member = by_ieee.get(m["ieee_address"])
                    if member:
                        await self.publish(member, self._apply(member, payload))
            if name in self.states or group:
                await self.publish(name, self._apply(name, payload))
            else:
                await self.log("error", f"Publish 'set' to '{name}' failed: 'Unknown device'")
        elif topic.endswith("/get"):
            name = topic[:-4]
            await asyncio.sleep(0.05)
            if name in self.states:
                await self.publish(name, self.states[name])

    # ------------------------------------------------------------------ bridge requests

    def _dev(self, ref) -> dict | None:
        return next((d for d in self.devices() if ref in (d["friendly_name"], d["ieee_address"])), None)

    def _grp(self, ref) -> dict | None:
        return next((g for g in self.groups() if ref in (g.get("friendly_name"), g.get("id"), str(g.get("id")))), None)

    async def _event(self, kind: str, dev: dict, **extra) -> None:
        await self.publish("bridge/event", {"type": kind, "data": {"friendly_name": dev["friendly_name"],
                                                                     "ieee_address": dev["ieee_address"], **extra}})

    async def _ota(self, dev: dict) -> None:
        name = dev["friendly_name"]
        st = self.states.setdefault(name, {})
        upd = dict(st.get("update") or {"installed_version": 1})
        aborts = self.__dict__.setdefault("_ota_aborts", set())
        aborts.discard(name)
        for pct in range(0, 101, 5):
            if name in aborts:  # device/ota_update/update/abort
                aborts.discard(name)
                st["update"] = {**upd, "state": "available", "progress": None, "remaining": None}
                await self.publish(name, st)
                raise RuntimeError(f"Update of '{name}' failed (aborted)")
            upd.update(state="updating", progress=pct, remaining=max(0, (100 - pct) // 2))
            st["update"] = dict(upd)
            await self.publish(name, st)
            await asyncio.sleep(1)
        newest = upd.get("latest_version") or upd.get("installed_version", 1) + 1
        st["update"] = {"installed_version": newest, "latest_version": newest, "state": "idle"}
        await self.publish(name, st)

    async def _join(self) -> None:
        await asyncio.sleep(4)
        info = self.bridge.get("bridge/info") or {}
        if not info.get("permit_join"):
            return
        template = next((d for d in self.devices() if d.get("type") == "EndDevice"), None)
        if not template:
            return
        new = json.loads(json.dumps(template))
        new["ieee_address"] = "0x00124b00%08x" % random.randint(0, 0xFFFFFFFF)
        new["friendly_name"] = new["ieee_address"]
        new["interview_state"] = "IN_PROGRESS"
        new["interviewing"] = True
        await self._event("device_joined", new)
        await self._event("device_interview", new, status="started")
        self.devices().append(new)
        await self.publish("bridge/devices", self.devices())
        await asyncio.sleep(3)
        new["interview_state"] = "SUCCESSFUL"
        new["interviewing"] = False
        new["interview_completed"] = True
        self.states[new["friendly_name"]] = {"linkquality": 140, "battery": 100}
        await self._event("device_interview", new, status="successful", supported=True)
        await self.publish("bridge/devices", self.devices())
        await self.publish(new["friendly_name"], self.states[new["friendly_name"]])

    async def on_request(self, sub: str, payload: dict) -> None:
        tid = payload.get("transaction")
        data = {k: v for k, v in payload.items() if k != "transaction"}
        status, error = "ok", None
        devices_changed = groups_changed = info_changed = False
        info = self.bridge.setdefault("bridge/info", {})
        try:
            if sub == "device/rename":
                dev = self._dev(data.get("from"))
                if not dev or not data.get("to"):
                    raise LookupError("Device not found")
                old = dev["friendly_name"]
                dev["friendly_name"] = data["to"]
                self.states[data["to"]] = self.states.pop(old, {})
                if old in self.avail:
                    self.avail[data["to"]] = self.avail.pop(old)
                devices_changed = True
            elif sub == "permit_join":
                t = int(data.get("time") or 0)
                info["permit_join"] = t > 0
                info["permit_join_end"] = int(time.time() * 1000) + t * 1000 if t else None
                info_changed = True
                if t:
                    asyncio.create_task(self._join())
            elif sub == "device/options":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                cfg = info.setdefault("config", {}).setdefault("devices", {}).setdefault(dev["ieee_address"], {})
                before = dict(cfg)
                for k, v in (data.get("options") or {}).items():
                    if v is None:
                        cfg.pop(k, None)
                    else:
                        cfg[k] = v
                data = {"id": data.get("id"), "from": before, "to": dict(cfg), "restart_required": False}
                info_changed = True
                if "disabled" in (data["to"] | before):
                    dev["disabled"] = bool(cfg.get("disabled"))
                    devices_changed = True
            elif sub == "group/options":
                grp = self._grp(data.get("id"))
                if not grp:
                    raise LookupError("Group not found")
                cfg = info.setdefault("config", {}).setdefault("groups", {}).setdefault(str(grp["id"]), {"friendly_name": grp["friendly_name"]})
                before = dict(cfg)
                for k, v in (data.get("options") or {}).items():
                    if v is None:
                        cfg.pop(k, None)
                    else:
                        cfg[k] = v
                data = {"id": data.get("id"), "from": before, "to": dict(cfg), "restart_required": False}
                info_changed = True
            elif sub in ("device/bind", "device/unbind"):
                src = self._dev(data.get("from"))
                if not src:
                    raise LookupError("Source device not found")
                ep_id = str(data.get("from_endpoint") or next(iter(src["endpoints"]), "1"))
                ep = src["endpoints"].setdefault(ep_id, {"bindings": []})
                tgt_grp = self._grp(data.get("to"))
                tgt_dev = None if tgt_grp else self._dev(data.get("to"))
                if not tgt_grp and not tgt_dev:
                    raise LookupError("Target not found")
                if tgt_grp:
                    target = {"type": "group", "id": tgt_grp["id"]}
                else:
                    target = {"type": "endpoint", "ieee_address": tgt_dev["ieee_address"],
                              "endpoint": int(data.get("to_endpoint") or next(iter(tgt_dev["endpoints"]), 1))}
                asked = data.get("clusters") or ["genOnOff"]
                # a sleeping end device misses the last cluster of a multi-cluster request
                failed = asked[-1:] if src.get("type") == "EndDevice" and len(asked) > 1 else []
                clusters = [c for c in asked if c not in failed]
                binds = ep.setdefault("bindings", [])
                if sub == "device/bind":
                    for c in clusters:
                        binds.append({"cluster": c, "target": target})
                else:
                    ep["bindings"] = [b for b in binds if not (b["cluster"] in clusters and b["target"] == target)]
                data = {"from": src["friendly_name"], "to": data.get("to"), "clusters": clusters, "failed": failed}
                devices_changed = True
            elif sub == "device/configure_reporting":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                ep = dev["endpoints"].setdefault(str(data.get("endpoint") or 1), {})
                reps = [r for r in ep.get("configured_reportings") or []
                        if not (r["cluster"] == data.get("cluster") and r["attribute"] == data.get("attribute"))]
                if int(data.get("maximum_report_interval") or 0) != 0xFFFF:
                    reps.append({k: data.get(k) for k in ("cluster", "attribute", "minimum_report_interval",
                                                          "maximum_report_interval", "reportable_change")})
                ep["configured_reportings"] = reps
                devices_changed = True
            elif sub == "device/ota_update/check":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                await asyncio.sleep(1.5)
                st = self.states.setdefault(dev["friendly_name"], {})
                upd = dict(st.get("update") or {"installed_version": 1})
                available = random.random() < 0.5
                upd["latest_version"] = upd.get("installed_version", 1) + (1 if available else 0)
                upd["state"] = "available" if available else "idle"
                st["update"] = upd
                await self.publish(dev["friendly_name"], st)
                data = {"id": data.get("id"), "update_available": available}
            elif sub == "device/ota_update/update":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                await self._ota(dev)
                data = {"id": data.get("id"), "from": {}, "to": {}}
            elif sub == "device/ota_update/update/abort":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                if ((self.states.get(dev["friendly_name"]) or {}).get("update") or {}).get("state") != "updating":
                    raise ValueError(f"No OTA in progress to abort for device '{dev['friendly_name']}'")
                self.__dict__.setdefault("_ota_aborts", set()).add(dev["friendly_name"])
                data = {"id": data.get("id")}
            elif sub in ("device/ota_update/schedule", "device/ota_update/unschedule"):
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                st = self.states.setdefault(dev["friendly_name"], {})
                upd = dict(st.get("update") or {})
                upd["state"] = "scheduled" if sub.endswith("/schedule") else "available"
                st["update"] = upd
                await self.publish(dev["friendly_name"], st)
            elif sub == "device/interview":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                await self._event("device_interview", dev, status="started")
                await asyncio.sleep(2)
                await self._event("device_interview", dev, status="successful", supported=True)
            elif sub == "device/configure":
                if not self._dev(data.get("id")):
                    raise LookupError("Device not found")
                await asyncio.sleep(1)
            elif sub == "device/remove":
                dev = self._dev(data.get("id"))
                if not dev:
                    raise LookupError("Device not found")
                self.devices().remove(dev)
                self.states.pop(dev["friendly_name"], None)
                await self._event("device_leave", dev)
                devices_changed = True
            elif sub == "group/add":
                ids = [g["id"] for g in self.groups()]
                gid = int(data.get("id") or (max(ids, default=0) + 1))
                if gid in ids or not data.get("friendly_name"):
                    raise ValueError("Group exists or has no name")
                self.groups().append({"id": gid, "friendly_name": data["friendly_name"], "members": [], "scenes": []})
                data = {"friendly_name": data["friendly_name"], "id": gid}
                groups_changed = True
            elif sub == "group/remove":
                grp = self._grp(data.get("id"))
                if not grp:
                    raise LookupError("Group not found")
                self.groups().remove(grp)
                groups_changed = True
            elif sub == "group/rename":
                grp = self._grp(data.get("from"))
                if not grp:
                    raise LookupError("Group not found")
                grp["friendly_name"] = data.get("to")
                groups_changed = True
            elif sub in ("group/members/add", "group/members/remove"):
                grp, dev = self._grp(data.get("group")), self._dev(data.get("device"))
                if not grp or not dev:
                    raise LookupError("Group or device not found")
                ep = int(data.get("endpoint") or next(iter(dev["endpoints"]), 1))
                member = {"ieee_address": dev["ieee_address"], "endpoint": ep}
                members = [m for m in grp.get("members") or [] if m != member]
                if sub.endswith("/add"):
                    members.append(member)
                grp["members"] = members
                groups_changed = True
            elif sub == "touchlink/scan":
                await self.log("info", "Start Touchlink scan")
                await asyncio.sleep(6)
                known = next((d["ieee_address"] for d in self.devices() if d.get("type") == "Router"), "0x0017880100aabbcd")
                data = {"found": [{"ieee_address": "0x0017880100aabbcc", "channel": 11}, {"ieee_address": known, "channel": 25}]}
                await self.log("info", "Finished Touchlink scan")
            elif sub == "touchlink/identify":
                if not data.get("ieee_address") or data.get("channel") is None:
                    raise ValueError("Invalid payload")
                await asyncio.sleep(1)
            elif sub == "touchlink/factory_reset":
                await asyncio.sleep(2)
                await self.log("info", "Successfully factory reset device through Touchlink")
            elif sub == "options":
                if not isinstance(data.get("options"), dict):
                    raise ValueError("Invalid payload")
                needs = self._apply_options(info, data["options"])
                info["restart_required"] = bool(info.get("restart_required")) or needs
                await self.log("info", "Changes require restart to take effect" if needs else "Successfully changed options")
                data = {"restart_required": info["restart_required"]}
                info_changed = True
            elif sub == "restart":
                await self.log("info", "Restarting Zigbee2MQTT")
                asyncio.create_task(self._restart())
                data = {}
            elif sub == "backup":
                import base64
                import io
                import zipfile
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    z.writestr("configuration.yaml", "# simulated\nhomeassistant:\n  enabled: true\n")
                    z.writestr("database.db", "\n".join(json.dumps(d) for d in self.devices()))
                    z.writestr("state.json", json.dumps(self.states))
                    z.writestr("coordinator_backup.json", json.dumps({"metadata": {"format": "zigpy/open-coordinator-backup"}}))
                data = {"zip": base64.b64encode(buf.getvalue()).decode()}
            elif sub == "health_check":
                data = {"healthy": True}
            elif sub == "coordinator_check":
                await asyncio.sleep(1)
                lost = next((d for d in self.devices() if d.get("type") == "Router"), None)
                data = {"missing_routers": [{"ieee_address": lost["ieee_address"], "friendly_name": lost["friendly_name"]}] if lost else []}
        except (LookupError, ValueError) as e:
            status, error = "error", str(e)
        await asyncio.sleep(0.1)
        if devices_changed:
            await self.publish("bridge/devices", self.devices())
        if groups_changed:
            await self.publish("bridge/groups", self.groups())
        if info_changed:
            await self.publish("bridge/info", info)
        resp = {"data": data, "status": status, "transaction": tid}
        if error:
            resp["error"] = error
        note = f"Simulated: bridge/request/{sub} -> {status}" + (f": {error}" if error else "")
        await self.log("info" if status == "ok" else "error", note)
        await self.publish(f"bridge/response/{sub}", resp)

    async def _restart(self) -> None:
        await asyncio.sleep(0.5)
        await self.publish("bridge/state", {"state": "offline"})
        await asyncio.sleep(3)
        info = self.bridge.setdefault("bridge/info", {})
        info["restart_required"] = False
        await self.publish("bridge/state", {"state": "online"})
        await self.publish("bridge/info", info)
        await self.log("info", "Zigbee2MQTT started!")

    async def _scenes(self, name: str, payload: dict) -> None:
        """scene_store / scene_remove / scene_remove_all / scene_rename on a group or a device."""
        grp = self._grp(name)
        dev = None if grp else self._dev(name)
        if grp:
            scenes = grp.setdefault("scenes", [])
        elif dev:
            ep = next((e for e in dev["endpoints"].values() if "genScenes" in (e.get("clusters") or {}).get("input", [])), None)
            if ep is None:
                return
            scenes = ep.setdefault("scenes", [])
        else:
            return
        if "scene_store" in payload:
            v = payload["scene_store"]
            sid, sname = (v.get("ID"), v.get("name")) if isinstance(v, dict) else (v, None)
            scenes[:] = [x for x in scenes if x["id"] != sid] + [{"id": sid, "name": sname or f"Scene {sid}"}]
        elif "scene_remove" in payload:
            scenes[:] = [x for x in scenes if x["id"] != payload["scene_remove"]]
        elif "scene_remove_all" in payload:
            scenes.clear()
        elif "scene_rename" in payload:
            v = payload["scene_rename"]
            for x in scenes:
                if x["id"] == v.get("ID"):
                    x["name"] = v.get("name")
        else:
            return
        await self.publish("bridge/groups" if grp else "bridge/devices", self.groups() if grp else self.devices())

    async def handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        for topic in ("bridge/state", "bridge/info", "bridge/devices", "bridge/groups", "bridge/definitions",
                      "bridge/extensions", "bridge/converters", "bridge/health"):
            if topic in self.bridge:
                await ws.send_str(json.dumps({"topic": topic, "payload": self.bridge[topic]}))
        for name, st in self.states.items():
            await ws.send_str(json.dumps({"topic": name, "payload": st}))
        for name, av in self.avail.items():
            await ws.send_str(json.dumps({"topic": f"{name}/availability", "payload": av}))
        self.clients.add(ws)
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    asyncio.create_task(self.on_message(json.loads(msg.data)))  # concurrently, like Zigbee2MQTT (an OTA update must not hold up its abort)
        finally:
            self.clients.discard(ws)
        return ws

    async def replay(self) -> None:
        if not self.live:
            return
        t0 = self.live[0][0]
        span = self.live[-1][0] - t0 + 5
        while True:
            start = time.monotonic()
            for t, m in self.live:
                await asyncio.sleep(max(0.0, (t - t0) - (time.monotonic() - start)))
                if isinstance(m.get("payload"), dict) and not m["topic"].startswith("bridge/"):
                    st = {**(self.states.get(m["topic"]) or {}), **m["payload"]}
                    if "linkquality" in st:
                        st["linkquality"] = max(0, min(255, int(st["linkquality"]) + random.randint(-8, 8)))
                    self.states[m["topic"]] = st
                    await self.publish(m["topic"], st)
                elif m["topic"] in ("bridge/logging", "bridge/health", "bridge/event"):
                    await self.publish(m["topic"], m["payload"])
            await asyncio.sleep(max(0.0, span - (time.monotonic() - start)))


async def start(port: int, recording: Path = REC) -> tuple[Sim, web.AppRunner]:
    sim = Sim(recording)
    app = web.Application()
    app.router.add_get("/api", sim.handler)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    asyncio.create_task(sim.replay())
    return sim, runner


async def _main(port: int) -> None:
    await start(port)
    print(f"Simulated Zigbee2MQTT on ws://127.0.0.1:{port}/api")
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(_main(int(sys.argv[1]) if len(sys.argv) > 1 else 18099))
