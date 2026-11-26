"""The Zigbee Sniffer's findings for the page: its JSON API.

The Sniffer answers only Home Assistant's ingress, plus a short list of read-only GETs from
Zigbee Studio and its floor-map changes (0.5.13), carrying the key it keeps in
/share/zigbee_sniffer/studio.key (this add-on maps /share read-only). Answers are cached for a
few seconds and shared: ten open pages asking for the same device make one request. Each answer
is slimmed to what the page draws (a device's 24 h answer is about 95 KB from the Sniffer, half of
that to the page; its 7 days 319 KB, a fifth; the mesh 140 KB, a third). Map changes are checked
here as well as in the Sniffer, and need Allow control like any other change.
"""

import asyncio
import logging
import math
import os
import re
import time
from pathlib import Path
from typing import Any

import aiohttp

log = logging.getLogger("sniffer")

HEADER = "X-Zigbee-Studio-Key"
KEY_FILE = Path(os.environ.get("STUDIO_SNIFFER_KEY", "/share/zigbee_sniffer/studio.key"))
PATHS = re.compile(r"/api/(status|overview|devices|mesh|live|map|map/coverage|device)(?:/(0x[0-9a-f]{4}))?")
QUERY = {"range": re.compile(r"1h|6h|24h|7d"), "after": re.compile(r"\d{1,12}"), "decode": re.compile(r"[01]"),
         "addr": re.compile(r"0x[0-9a-f]{4}"), "others": re.compile(r"[01]"), "floor": re.compile(r"[A-Za-z0-9_-]{1,64}"),
         "sniffer": re.compile(r"[a-z0-9_]{1,40}")}
TTL = {"status": 10, "overview": 30, "devices": 30, "device": 15, "mesh": 60, "live": 1, "map": 60, "map/coverage": 60}
CACHE_MAX = 200
FLOOR_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
IMAGE_V = re.compile(r"[A-Za-z0-9_.-]{1,100}")
ITEM_KEY = re.compile(r"0x[0-9a-f]{16}|addr:0x[0-9a-f]{4}|sniffer:[A-Za-z0-9_-]{1,40}")
IMAGE_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif"}
IMAGE_MAX = 24 * 1024 * 1024  # the Sniffer's own limit
IMAGES_KEPT = 4


class SnifferError(Exception):
    pass


def read_key(path: Path | None = None) -> str:
    try:
        return (path or KEY_FILE).read_text().strip()
    except OSError:
        return ""


def check(path: str, query: dict | None) -> tuple[str, str, dict]:
    """(kind, path, query) for a request the page may make; anything else raises ValueError."""
    m = PATHS.fullmatch(path or "")
    if not m or (m.group(1) == "device") != bool(m.group(2)):
        raise ValueError("Not something Zigbee Studio reads from the Sniffer")
    q = {}
    for k, v in (query or {}).items():
        rx = QUERY.get(k)
        if rx is None or not rx.fullmatch(str(v)):
            raise ValueError(f"Bad Sniffer query {k}")
        q[k] = str(v)
    return m.group(1), path, q


# ---------------------------------------------------------------------- map changes

def _number(v: Any, lo: float, hi: float, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"Bad {what}")
    return float(v)


def _name(v: Any) -> str:
    name = str(v or "").strip()[:60]
    if not name:
        raise ValueError("Give the floor a name")
    return name


def _level(v: Any) -> int:
    return int(_number(v, -5, 30, "level"))


def floor_id(v: Any) -> str:
    if not isinstance(v, str) or not FLOOR_ID.fullmatch(v):
        raise ValueError("Bad floor")
    return v


def map_change(action: str, args: dict) -> tuple[str, str, dict | None]:
    """(method, path, body) of a floor-map change the page may make; anything else raises ValueError."""
    if not isinstance(args, dict):
        raise ValueError("Bad map change")  # noqa: TRY004  (the hub answers a ValueError to the page)
    if action == "add_floor":
        body: dict = {"name": _name(args.get("name")), "level": _level(args.get("level", 0))}
        if args.get("width_m") is not None or args.get("height_m") is not None:
            body["width_m"] = _number(args.get("width_m"), 0.5, 1000, "width")
            body["height_m"] = _number(args.get("height_m"), 0.5, 1000, "depth")
        return "POST", "/api/map/floors", body
    if action == "positions":
        put, clear = args.get("set") or {}, args.get("clear") or []
        if not isinstance(put, dict) or not isinstance(clear, list) or len(put) + len(clear) > 400:
            raise ValueError("Bad positions")
        if not put and not clear:
            raise ValueError("Nothing to change")
        body = {"set": {}, "clear": []}
        for key, pos in put.items():
            if not ITEM_KEY.fullmatch(str(key)) or not isinstance(pos, dict):
                raise ValueError("Bad position")
            body["set"][key] = {"floor": floor_id(pos.get("floor")), "x": _number(pos.get("x"), 0, 1, "position"),
                                "y": _number(pos.get("y"), 0, 1, "position")}
        for key in clear:
            if not isinstance(key, str) or not ITEM_KEY.fullmatch(key):
                raise ValueError("Bad position")
            body["clear"].append(key)
        return "POST", "/api/map/positions", body
    fid = floor_id(args.get("floor"))
    if action == "update_floor":
        body = {}
        if "name" in args:
            body["name"] = _name(args["name"])
        if "level" in args:
            body["level"] = _level(args["level"])
        if "scale" in args:  # image pixels per metre
            body["scale"] = None if args["scale"] is None else _number(args["scale"], 0.001, 100000, "scale")
        if "width_m" in args or "height_m" in args:
            body["width_m"] = _number(args.get("width_m"), 0.5, 1000, "width")
            body["height_m"] = _number(args.get("height_m"), 0.5, 1000, "depth")
        if "floor_height_m" in args:
            body["floor_height_m"] = _number(args["floor_height_m"], 1.5, 10, "height between floors")
        if not body:
            raise ValueError("Nothing to change")
        return "POST", f"/api/map/floors/{fid}", body
    if action == "delete_floor":
        return "DELETE", f"/api/map/floors/{fid}", None
    raise ValueError("Not a map change Zigbee Studio makes")


# ---------------------------------------------------------------------- slimming

FRAME_KEYS = ("id", "ts", "rssi", "lqi", "kind", "retry", "len", "src", "dst", "nwk_src", "nwk_dst", "src_name",
              "dst_name", "nwk_src_name", "nwk_dst_name", "proto", "info", "ours", "seq")
EVENT_KEYS = ("ts", "kind", "what", "addr", "name", "other", "other_name", "detail")
INCIDENT_KEYS = ("id", "start", "end", "sev", "title", "detail", "cause", "devices")
NEIGHBOUR_KEYS = ("addr", "name", "in", "out", "in_avg", "out_avg", "ts", "own", "reported", "cost")
ROW_DROP = {"spark", "cmds", "air", "first_minute", "known"}


def pick(d: dict, keys: tuple) -> dict:
    return {k: d[k] for k in keys if k in d and d[k] is not None}


def frame(f: dict) -> dict:
    out = pick(f, FRAME_KEYS)
    if f.get("heard_by"):
        out["by"] = [[h.get("name"), h.get("rssi")] for h in f["heard_by"]]
    return out


def slim(kind: str, d: Any) -> Any:
    if not isinstance(d, dict):
        return d
    if kind == "device":
        out = {k: d[k] for k in ("range", "span", "bucket", "now", "series", "signal_series", "sends_to",
                                 "hears_from", "relays_for", "relayed_by", "routes_out", "routes_in", "next_hops",
                                 "baseline", "ota", "firmware", "marks") if k in d}
        out["device"] = {k: v for k, v in (d.get("device") or {}).items() if k not in ROW_DROP}
        out["neighbours"] = [pick(n, NEIGHBOUR_KEYS) for n in d.get("neighbours") or []]
        out["events"] = [pick(e, EVENT_KEYS) for e in (d.get("events") or [])[:80]]
        out["incidents"] = [pick(i, INCIDENT_KEYS) for i in d.get("incidents") or []]
        out["frames"] = [frame(f) for f in (d.get("frames") or [])[:60]]
        return out
    if kind == "overview":
        out = {k: d[k] for k in ("range", "span", "bucket", "now", "net", "totals", "counts", "attention", "ota",
                                 "marks") if k in d}
        out["events"] = [pick(e, EVENT_KEYS) for e in d.get("events") or []]
        out["incidents"] = [pick(i, INCIDENT_KEYS) for i in d.get("incidents") or []]
        out["networks"] = (d.get("networks") or [])[:8]
        return out
    if kind == "devices":
        return {**{k: d[k] for k in ("range", "span", "now", "sniffers") if k in d},
                "devices": [{k: v for k, v in r.items() if k not in ROW_DROP and k not in ("events", "baseline")}
                            for r in d.get("devices") or []]}
    if kind == "live":
        return {"last_id": d.get("last_id"), "skipped": d.get("skipped", 0),
                "frames": [frame(f) for f in d.get("frames") or []]}
    if kind == "mesh":  # links as [a, b, cost a->b, cost b->a, when]; who talks to whom stays behind
        nodes = [pick(n, ("addr", "name", "type", "rssi_avg", "sev", "last_seen", "tx", "mesh")) for n in d.get("nodes") or []]
        links = [[e.get("a"), e.get("b"), e.get("ab"), e.get("ba"), round(e.get("ts") or 0)] for e in d.get("edges") or []]
        kids = [[c.get("child"), c.get("parent")] for c in d.get("children") or []]
        return {"range": d.get("range"), "nodes": nodes, "links": links, "children": kids}
    if kind == "status":
        return {k: d[k] for k in ("version", "channel", "connected", "sniffers", "pan_id", "fps", "frames_total",
                                  "frames_ours", "retention_days", "history_since", "key_loaded", "decode", "now")
                if k in d}
    return d


# ---------------------------------------------------------------------- client

class Sniffer:
    """`provider()` gives (base URL, headers) or None when no Sniffer is installed."""

    def __init__(self, provider) -> None:
        self.provider = provider
        self.session: aiohttp.ClientSession | None = None
        self.cache: dict[tuple, tuple[float, Any]] = {}
        self.inflight: dict[tuple, asyncio.Future] = {}
        self.error = ""
        self.ok_at = 0.0
        self.images: dict[tuple[str, str], tuple[bytes, str]] = {}

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()

    async def get(self, path: str, query: dict | None = None) -> Any:
        kind, path, q = check(path, query)
        key = (path, tuple(sorted(q.items())))
        hit = self.cache.get(key)
        if hit and time.monotonic() - hit[0] < TTL.get(kind, 10):
            return hit[1]
        fut = self.inflight.get(key)
        if fut is not None:
            return await asyncio.shield(fut)
        fut = asyncio.get_running_loop().create_future()
        self.inflight[key] = fut
        try:
            data = slim(kind, await self._fetch(path, q))
            self.cache[key] = (time.monotonic(), data)
            if len(self.cache) > CACHE_MAX:
                for k in sorted(self.cache, key=lambda k: self.cache[k][0])[: len(self.cache) - CACHE_MAX]:
                    del self.cache[k]
            fut.set_result(data)
            return data
        except Exception as e:
            fut.set_exception(e)
            fut.exception()  # retrieved: no "never retrieved" warning when nobody else waited
            raise
        finally:
            self.inflight.pop(key, None)

    async def _fetch(self, path: str, q: dict) -> Any:
        return await self._request("GET", path, params=q)

    async def write(self, method: str, path: str, body: dict | None = None, *, data: bytes | None = None,
                    content_type: str | None = None, params: dict | None = None) -> Any:
        """A floor-map change (checked by map_change, or an image by the caller); the map answers
        are fetched afresh after it."""
        try:
            return await self._request(method, path, json=body, data=data, content_type=content_type,
                                       params=params, change=True)
        finally:
            for k in [k for k in self.cache if k[0].startswith("/api/map")]:
                del self.cache[k]

    async def image(self, fid: str, v: str) -> tuple[bytes, str]:
        """A floor's plan and its type. `v` names the uploaded file, so a replaced plan is fetched anew."""
        floor_id(fid)
        if not IMAGE_V.fullmatch(v or ""):
            raise ValueError("Bad image")
        hit = self.images.get((fid, v))
        if hit:
            return hit
        got = await self._request("GET", f"/api/map/floors/{fid}/image", raw=True)
        self.images[(fid, v)] = got
        while len(self.images) > IMAGES_KEPT:
            del self.images[next(iter(self.images))]
        return got

    async def _request(self, method: str, path: str, *, params: dict | None = None, json: Any = None,
                       data: bytes | None = None, content_type: str | None = None, raw: bool = False,
                       change: bool = False) -> Any:
        target = await self.provider()
        if target is None:
            raise SnifferError("No Zigbee Sniffer add-on found")
        base, headers = target
        if content_type:
            headers = {**headers, "Content-Type": content_type}
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45))
        try:
            async with self.session.request(method, base.rstrip("/") + path, params=params, json=json, data=data,
                                            headers=headers) as r:
                if r.status == 403:
                    if change:
                        raise SnifferError("The Zigbee Sniffer refused Zigbee Studio's map change: update it to "
                                           "0.5.13 or later and keep its option Share with Zigbee Studio on")
                    self.error = ("The Zigbee Sniffer refused Zigbee Studio: update it to 0.5.12 or later and keep "
                                  "its option Share with Zigbee Studio on")
                    raise SnifferError(self.error)
                if r.status == 404 and raw:
                    raise LookupError("No plan for that floor")
                if r.status == 400:
                    raise ValueError((await r.text())[:200] or "The Zigbee Sniffer refused it")
                if r.status != 200:
                    raise SnifferError(f"The Zigbee Sniffer answered HTTP {r.status}")
                if raw:
                    ctype = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
                    out = (await r.read(), ctype if ctype in IMAGE_TYPES else "application/octet-stream")
                else:
                    out = await r.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError) as e:
            self.error = f"Can't reach the Zigbee Sniffer: {e or type(e).__name__}"
            raise SnifferError(self.error) from e
        if not change:
            self.error = ""
            self.ok_at = time.time()
        return out
