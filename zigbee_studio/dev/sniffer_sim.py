"""A stand-in Zigbee Sniffer for development: answers Zigbee Studio's read-only requests from a
recording (dev/record_sniffer.py -> .dev/sniffer/), with the same key check as the real one.

Devices without a recorded page borrow one (their own name and address on it), and live frames
are the recorded ones replayed at their real pace with new ids, so the Traffic page moves.

The floor maps are the real thing: the Sniffer's own mapping.py (floors, plans, positions, the
coverage fit) on a folder of its own, .dev/sniffer-map/. STUDIO_SIM_MAP=demo starts it with two
blank floors and every device placed where its signal at the sniffers says it might be.
"""

import json
import math
import os
import random
import sys
import time
from pathlib import Path
# recordings and local state: .dev/ (STUDIO_DEV_DIR=.dev-demo for the anonymised demo set, see dev/demo_data.py)
DEV_DIR = Path(os.environ.get("STUDIO_DEV_DIR") or Path(__file__).resolve().parent.parent / ".dev")

from aiohttp import web

REC = DEV_DIR / "sniffer"
MAP_DIR = DEV_DIR / "sniffer-map"
# the Sniffer's own code, from its repo checked out next to this one (or ZIGBEE_SNIFFER_APP)
sys.path.insert(0, os.environ.get("ZIGBEE_SNIFFER_APP") or str(Path(__file__).resolve().parents[3] / "zigbee-sniffer" / "zigbee_sniffer" / "app"))
import mapping  # noqa: E402  (the Sniffer's own)


KEY = "dev-key-for-the-simulator-only-0123456789"
HEADER = "X-Zigbee-Studio-Key"


def load(name: str):
    p = REC / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


class SnifferSim:
    def __init__(self) -> None:
        self.devices = (load("api_devices.json") or {}).get("devices", [])
        self.by_addr = {d["addr"]: d for d in self.devices}
        self.pages = sorted(p.name for p in REC.glob("api_device_0x????.json"))
        live = (load("api_live__decode-1.json") or {}).get("frames", [])
        self.live = sorted(live, key=lambda f: f["ts"])
        self.t0 = time.time()
        self.base_id = 1_000_000
        self.sniffers = (load("api_devices.json") or {}).get("sniffers") or [{"id": "main", "name": "Main"}]
        self.mesh = load("api_mesh.json") or {"edges": []}
        MAP_DIR.mkdir(parents=True, exist_ok=True)
        if os.environ.get("STUDIO_SIM_MAP") == "demo" and not (MAP_DIR / "map.json").exists():
            self.demo_map()
        self.maps = mapping.FloorMaps(MAP_DIR)

    @staticmethod
    def key(d: dict) -> str:
        return d.get("ieee") or f"addr:{d['addr']}"

    def demo_map(self) -> None:
        """Two blank floors; sniffers placed; each device at the distance its signal at Main suggests."""
        maps = mapping.FloorMaps(MAP_DIR)
        main = maps.add_floor("Main floor", 0, 24, 14)
        up = maps.add_floor("Upper floor", 1, 24, 14)
        rnd = random.Random(7)
        put = {"sniffer:main": {"floor": main["id"], "x": 0.42, "y": 0.5}}
        if len(self.sniffers) > 1:
            put[f"sniffer:{self.sniffers[1]['id']}"] = {"floor": up["id"], "x": 0.7, "y": 0.4}
        for d in self.devices:
            sig = {s["sniffer"]: s for s in d.get("signal") or []}
            r = sig.get("main", {}).get("rssi_avg")
            if r is None:
                continue
            dist = min(13.0, max(1.0, 10 ** ((-45 - r) / 30)))
            ang = rnd.uniform(0, 2 * math.pi)
            fl = up if rnd.random() < 0.35 else main
            x = 0.42 + dist * math.cos(ang) / 24
            y = 0.5 + dist * math.sin(ang) / 14
            put[self.key(d)] = {"floor": fl["id"], "x": min(0.97, max(0.03, x)), "y": min(0.97, max(0.03, y))}
        maps.set_positions(put, [])

    def map_answer(self) -> dict:
        items = [{"key": self.key(d), "kind": "device", "addr": d["addr"], "name": d.get("name") or d["addr"],
                  "type": d.get("type"), "model": d.get("model")} for d in self.devices if d.get("known") or d.get("tx")]
        items += [{"key": f"sniffer:{s['id']}", "kind": "sniffer", "name": f"Sniffer: {s['name']}", "type": "Sniffer"}
                  for s in self.sniffers]
        return {"floors": [{**f, "size_m": self.maps.size_m(f)} for f in self.maps.floors],
                "positions": self.maps.data["positions"], "items": items, "floor_height_m": self.maps.data["floor_height_m"]}

    def coverage(self, rng: str) -> dict:
        """As the Sniffer's api_map_coverage, from the recorded devices' signal at each sniffer."""
        pos = self.maps.data["positions"]
        signal = {d["addr"]: {s["sniffer"]: s for s in d.get("signal") or [] if (s.get("n") or 0) >= 3} for d in self.devices}
        samples = []
        for s in self.sniffers:
            sp = pos.get(f"sniffer:{s['id']}")
            spm = self.maps.point_m(sp) if sp else None
            if not spm:
                continue
            for d in self.devices:
                r = signal.get(d["addr"], {}).get(s["id"])
                dp = pos.get(self.key(d)) if r else None
                dpm = self.maps.point_m(dp) if dp else None
                if dpm:
                    dist, floors = self.maps.distance(dpm, spm)
                    samples.append({"device": self.key(d), "sniffer": s["id"], "d": dist, "floors": floors,
                                    "rssi": r["rssi_avg"], "n": r["n"]})
        model = mapping.fit(samples, ref=self.sniffers[0]["id"])
        names = {s["id"]: s["name"] for s in self.sniffers}
        for g in model.get("gains") or []:
            g["name"] = names.get(g["sniffer"], g["sniffer"])
        offsets = model.pop("offsets", {}) if model.get("ok") else {}
        by_model: dict = {}
        for d in self.devices:
            if self.key(d) in offsets and d.get("model"):
                by_model.setdefault(d["model"], []).append(offsets[self.key(d)])
        items = []
        for d in self.devices:
            p = pos.get(self.key(d))
            if not p:
                continue
            per = signal.get(d["addr"], {})
            strength, src = None, None
            if model.get("ok"):
                if self.key(d) in offsets:
                    strength, src = model["a0"] + offsets[self.key(d)], "measured"
                elif by_model.get(d.get("model")):
                    strength, src = model["a0"] + sum(by_model[d["model"]]) / len(by_model[d["model"]]), "model"
                else:
                    strength, src = model["a0"], "house"
            items.append({"key": self.key(d), "kind": "device", "addr": d["addr"], "name": d.get("name") or d["addr"],
                          "type": d.get("type"), "model": d.get("model"), "sev": d.get("sev", 0), **p,
                          "flags": [f["text"] for f in (d.get("flags") or [])[:3]], "mesh": d.get("mesh"),
                          "signal": {sid: {"rssi": r["rssi_avg"], "n": r["n"]} for sid, r in per.items()},
                          "best_rssi": max((r["rssi_avg"] for r in per.values()), default=None),
                          "strength": round(strength, 1) if strength is not None else None, "strength_from": src})
        for s in self.sniffers:
            p = pos.get(f"sniffer:{s['id']}")
            if p:
                items.append({"key": f"sniffer:{s['id']}", "kind": "sniffer", "id": s["id"], "name": s["name"],
                              "connected": True, **p})
        placed = {i["addr"] for i in items if i["kind"] == "device"}

        def cost(a, b):
            known = [c for c in (a, b) if c]
            return max(known) if known else None
        links = [{"a": e["a"], "b": e["b"], "cost": cost(e["ab"], e["ba"])} for e in self.mesh.get("edges", [])
                 if e["a"] in placed and e["b"] in placed]
        return {"range": rng, "model": model, "items": items, "links": links,
                "floors": [{**f, "size_m": self.maps.size_m(f)} for f in self.maps.floors],
                "sniffers": [{"id": s["id"], "name": s["name"]} for s in self.sniffers],
                "floor_height_m": self.maps.data["floor_height_m"]}

    async def map_write(self, request: web.Request) -> web.Response:
        path, m = request.path, request.method
        parts = path.split("/")  # '', api, map, floors, fid, image
        if m == "POST" and path == "/api/map/floors":
            b = await request.json()
            return web.json_response(self.maps.add_floor(str(b.get("name") or "Floor")[:60], int(b.get("level") or 0),
                                                         b.get("width_m"), b.get("height_m")))
        if m == "POST" and path == "/api/map/positions":
            b = await request.json()
            self.maps.set_positions(b.get("set") or {}, b.get("clear") or [])
            return web.json_response({"ok": True, "positions": self.maps.data["positions"]})
        if m == "POST" and len(parts) == 6 and parts[5] == "image":
            data = await request.read()
            return web.json_response(self.maps.set_image(parts[4], data, request.content_type,
                                                         int(request.query["w"]), int(request.query["h"])))
        if m == "POST" and len(parts) == 5:
            b = await request.json()
            if "floor_height_m" in b:
                self.maps.data["floor_height_m"] = max(1.5, min(10.0, float(b.pop("floor_height_m"))))
                self.maps.save()
            return web.json_response(self.maps.update_floor(parts[4], b))
        if m == "DELETE" and len(parts) == 5:
            self.maps.delete_floor(parts[4])
            return web.json_response({"ok": True})
        raise web.HTTPForbidden()

    def live_since(self, after: int, addr: str) -> dict:
        """The recording replayed in a loop: frame i of the loop appears at its own offset."""
        if not self.live:
            return {"last_id": after, "frames": [], "skipped": 0}
        span = max(1.0, self.live[-1]["ts"] - self.live[0]["ts"])
        el = time.time() - self.t0
        loops, into = divmod(el, span)
        out = []
        n = len(self.live)
        last = self.base_id + int(loops) * n + sum(1 for f in self.live if f["ts"] - self.live[0]["ts"] <= into)
        start = max(after + 1, last - 300)
        for fid in range(start, last + 1):
            i = (fid - self.base_id) % n
            f = dict(self.live[i])
            f["id"] = fid
            f["ts"] = time.time() - (last - fid) * span / n  # spread back from now at the recording's pace
            if addr and addr not in (f.get("src"), f.get("dst"), f.get("nwk_src"), f.get("nwk_dst")):
                continue
            out.append(f)
        return {"last_id": last, "frames": out[-300:], "skipped": max(0, last - 300 - after) if after else 0}

    def device(self, addr: str, rng: str):
        suffix = "__range-7d" if rng == "7d" else ""
        own = load(f"api_device_{addr}{suffix}.json")
        if own:
            return own
        row = self.by_addr.get(addr)
        if row is None or not self.pages:
            return None
        donor = [p for p in self.pages if p.endswith(f"{suffix}.json") and ("__" in p) == bool(suffix)]
        d = load(donor[hash(addr) % len(donor)]) if donor else None
        if d is None:
            return None
        d["device"] = {**d["device"], **row}
        for f in d.get("frames", []):
            f["src"], f["src_name"] = addr, row.get("name")
        return d

    async def handle(self, request: web.Request) -> web.Response:
        if request.headers.get(HEADER) != KEY:
            raise web.HTTPForbidden(text="Open the Zigbee Sniffer from Home Assistant's sidebar.")
        path, q = request.path, request.query
        rng = q.get("range", "24h")
        if request.method != "GET":
            try:
                return await self.map_write(request)
            except KeyError as e:
                raise web.HTTPBadRequest(text=str(e)) from e
        if path == "/api/map":
            return web.json_response(self.map_answer())
        if path == "/api/map/coverage":
            return web.json_response(self.coverage(rng))
        if path.startswith("/api/map/floors/") and path.endswith("/image"):
            img = self.maps.image_path(path.split("/")[4])
            if not img or not img.is_file():
                raise web.HTTPNotFound()
            return web.FileResponse(img)
        if path.startswith("/api/device/"):
            d = self.device(path.rsplit("/", 1)[1].lower(), rng)
        elif path == "/api/live":
            d = self.live_since(int(q.get("after", 0)), q.get("addr", ""))
        else:
            name = path.strip("/").replace("/", "_") + ("__range-7d" if rng == "7d" and path == "/api/overview" else "")
            d = load(name + ".json")
        if d is None:
            raise web.HTTPNotFound()
        if isinstance(d, dict) and "now" in d:
            d["now"] = time.time()
        return web.json_response(d)


async def start(port: int) -> SnifferSim:
    sim = SnifferSim()
    app = web.Application(client_max_size=24 * 1024 * 1024)
    app.router.add_route("*", "/{tail:.*}", sim.handle)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    print(f"Sniffer simulator on :{port} ({len(sim.devices)} devices, {len(sim.pages)} recorded pages)")
    return sim
