"""Zigbee Studio: a fast, live web UI for Zigbee2MQTT, as an add-on of its own beside it.

It is one more client of the WebSocket Zigbee2MQTT already serves to its own page (Windfront),
so Zigbee2MQTT's add-on and configuration stay exactly as they are and both pages work side by
side. It holds everything Zigbee2MQTT says, and gives each page a compact snapshot and then only
what changes. Home Assistant adds floors and rooms, and the Zigbee Sniffer's health sensors.

Read-only (nothing is sent to Zigbee2MQTT) until the add-on option allow_control is on.
"""

import asyncio
import gzip
import json
import logging
import mimetypes
import os
import re
import signal
import time
from pathlib import Path

import adapter as adapter_mod
import aiohttp
import sniffer as sniffer_mod
from carryover import carry_over
from aiohttp import web
from hass import HomeAssistant
from hub import Hub
from z2m import Z2M

VERSION = "0.8.2"

logging.basicConfig(level=os.environ.get("STUDIO_LOG", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("studio")

DATA_DIR = Path(os.environ.get("STUDIO_DATA", "/data"))
STATIC = Path(os.environ.get("STUDIO_STATIC", Path(__file__).parent / "static"))
PORT = int(os.environ.get("STUDIO_PORT", "8099"))
BIND = os.environ.get("STUDIO_BIND", "0.0.0.0")
# Who may use the web port: Home Assistant's ingress proxy (and this machine, for development)
ALLOW = {a.strip() for a in os.environ.get("STUDIO_ALLOW", "172.30.32.2,127.0.0.1,::1").split(",") if a.strip()}
HEARD_FILE = "heard.json"
LOGS_FILE = "logs.json"  # Zigbee2MQTT's recent log, kept across restarts and updates
Z2M_SLUG = re.compile(r"^(?:[0-9a-f]{8}_|local_)?zigbee2mqtt(?:_edge|_dev)?$")
SNIFFER_SLUG = re.compile(r"^(?:[0-9a-f]{8}_|local_)?zigbee_sniffer$")


def load_options() -> dict:
    try:
        return json.loads((DATA_DIR / "options.json").read_text())
    except (OSError, ValueError):
        return {}


def supervisor_token() -> str:
    """The add-on's Supervisor token (s6 starts the app with a clean environment, so it is read
    from s6's copy of the container environment when it isn't set)."""
    tok = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HASSIO_TOKEN") or ""
    for name in ("SUPERVISOR_TOKEN", "HASSIO_TOKEN"):
        if tok:
            break
        try:
            tok = Path(f"/run/s6/container_environment/{name}").read_text().strip()
        except OSError:
            pass
    return tok


def pick_z2m(addons: list[dict]) -> str | None:
    """The Zigbee2MQTT add-on's slug: a started one before a stopped one, stable before edge/dev."""
    found = [a for a in addons if Z2M_SLUG.match(a.get("slug", ""))]
    found.sort(key=lambda a: (a.get("state") != "started", "_edge" in a["slug"] or "_dev" in a["slug"]))
    return found[0]["slug"] if found else None


def pick_sniffer(addons: list[dict]) -> str | None:
    """The Zigbee Sniffer add-on's slug, a started one first."""
    found = [a for a in addons if SNIFFER_SLUG.match(a.get("slug", ""))]
    found.sort(key=lambda a: a.get("state") != "started")
    return found[0]["slug"] if found else None


async def addon_address(s: aiohttp.ClientSession, slug: str) -> tuple[str, int] | None:
    """An add-on's host name and ingress port on Home Assistant's internal network."""
    async with s.get(f"http://supervisor/addons/{slug}/info") as r:
        if r.status != 200:
            return None
        info = (await r.json()).get("data", {})
    return info.get("hostname") or slug.replace("_", "-"), info.get("ingress_port") or 8099


async def list_addons(s: aiohttp.ClientSession) -> list[dict]:
    """Installed add-ons from /supervisor/info (the default add-on role may read .../info
    endpoints, not /addons)."""
    async with s.get("http://supervisor/supervisor/info") as r:
        return (await r.json()).get("data", {}).get("addons", []) if r.status == 200 else []


def supervisor_session(token: str) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(headers={"Authorization": f"Bearer {token}"}, timeout=aiohttp.ClientTimeout(total=15))


async def find_z2m(token: str) -> tuple[str | None, str | None]:
    """Zigbee2MQTT's WebSocket URL and its sidebar panel."""
    async with supervisor_session(token) as s:
        slug = pick_z2m(await list_addons(s)) or "45df7312_zigbee2mqtt"  # the official repository's slug
        addr = await addon_address(s, slug)
    if addr is None:
        return None, None
    return f"ws://{addr[0]}:{addr[1]}/api", f"/{slug}"


async def find_sniffer(token: str) -> tuple[str | None, str | None]:
    """The Zigbee Sniffer's web address and its sidebar panel (None when it isn't installed)."""
    async with supervisor_session(token) as s:
        slug = pick_sniffer(await list_addons(s))
        addr = await addon_address(s, slug) if slug else None
    if addr is None:
        return None, None
    return f"http://{addr[0]}:{addr[1]}", f"/{slug}"


def sniffer_provider(token: str, found: tuple[str | None, str | None]):
    """(base URL, headers) for the Sniffer: its address (looked for again at most once a minute
    while it isn't installed) and the key it shares in /share, read each time so a new key is
    picked up."""
    state = {"base": found[0], "panel": found[1], "looked": time.monotonic()}

    async def provider() -> tuple[str, dict] | None:
        if not state["base"] and token and time.monotonic() - state["looked"] > 60:
            state["looked"] = time.monotonic()
            try:
                state["base"], state["panel"] = await find_sniffer(token)
            except Exception as e:  # noqa: BLE001 - looked for again in a minute
                log.debug("Looking for the Zigbee Sniffer: %s", e)
        if not state["base"]:
            return None
        key = sniffer_mod.read_key()
        if not key:
            raise sniffer_mod.SnifferError("The Zigbee Sniffer hasn't shared a key with Zigbee Studio: update it to "
                                           "0.5.12 or later and keep its option Share with Zigbee Studio on")
        return state["base"], {sniffer_mod.HEADER: key}

    return provider, state


def with_token(url: str, token: str) -> str:
    if not token:
        return url
    return url + ("&" if "?" in url else "?") + "token=" + token


# ---------------------------------------------------------------------- web

class Static:
    """The built page, gzipped once in memory. index.html is never cached (it names the current
    assets); assets have content hashes in their names, so browsers keep them for good."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.cache: dict[str, tuple[float, tuple[bytes, bytes, str]]] = {}  # rel -> (mtime, entry)

    def _load(self, rel: str) -> tuple[bytes, bytes, str] | None:
        path = (self.root / rel).resolve()
        if self.root not in path.parents or not path.is_file():
            self.cache.pop(rel, None)
            return None
        mtime = path.stat().st_mtime  # a rebuilt page is picked up without a restart
        hit = self.cache.get(rel)
        if hit and hit[0] == mtime:
            return hit[1]
        raw = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml", "application/json"):
            ctype += "; charset=utf-8"
        entry = (raw, gzip.compress(raw, 9), ctype)
        self.cache[rel] = (mtime, entry)
        return entry

    async def serve(self, request: web.Request) -> web.Response:
        rel = request.match_info.get("path") or "index.html"
        entry = self._load(rel)
        if entry is None:
            raise web.HTTPNotFound()
        raw, gz, ctype = entry
        headers = {"Content-Type": ctype, "Vary": "Accept-Encoding",
                   "Cache-Control": "public, max-age=31536000, immutable" if rel.startswith("assets/") else "no-cache"}
        if "gzip" in request.headers.get("Accept-Encoding", "") and len(gz) < len(raw):
            headers["Content-Encoding"] = "gzip"
            return web.Response(body=gz, headers=headers)
        return web.Response(body=raw, headers=headers)


@web.middleware
async def ingress_only(request: web.Request, handler):
    """Only Home Assistant's ingress proxy (which has checked the user's login) gets an answer."""
    if request.remote not in ALLOW:
        log.warning("Refused a request from %s (only Home Assistant's ingress may use this page)", request.remote)
        raise web.HTTPForbidden()
    return await handler(request)


# An uploaded plan (an SVG can hold script) is served on Home Assistant's origin: opened on its own it
# must not run anything (the Sniffer serves it the same way).
PLAN_HEADERS = {"X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"}


def build_app(hub: Hub, static_root: Path = STATIC) -> web.Application:
    app = web.Application(middlewares=[ingress_only], client_max_size=sniffer_mod.IMAGE_MAX + 65536)
    static = Static(static_root)

    def plan_error(e: Exception) -> web.Response:
        status = 400 if isinstance(e, ValueError) else 404 if isinstance(e, LookupError) else 502
        return web.json_response({"e": str(e) or type(e).__name__}, status=status)

    async def plan(request: web.Request) -> web.StreamResponse:
        """A floor's plan from the Sniffer (`v` = its file name, so the browser keeps it until replaced)."""
        if hub.sniffer is None:
            raise web.HTTPNotFound()
        try:
            body, ctype = await hub.sniffer.image(request.match_info["fid"], request.query.get("v", ""))
        except (ValueError, LookupError, sniffer_mod.SnifferError) as e:
            return plan_error(e)
        return web.Response(body=body, headers={**PLAN_HEADERS, "Content-Type": ctype,
                                                "Cache-Control": "private, max-age=86400"})

    async def plan_upload(request: web.Request) -> web.Response:
        """A floor's new plan, to the Sniffer. A change like any other: needs Allow control. The
        X-Studio header can't be sent by another site's form, only by this page."""
        if hub.sniffer is None:
            raise web.HTTPNotFound()
        if request.headers.get("X-Studio") != "1":
            raise web.HTTPForbidden()
        if not hub.control:
            return web.json_response({"e": "Zigbee Studio is read-only: turn on Allow control in the add-on's "
                                           "configuration", "ro": True}, status=403)
        try:
            fid = sniffer_mod.floor_id(request.match_info["fid"])
            ctype = request.content_type.lower()
            if ctype not in sniffer_mod.IMAGE_TYPES:
                raise ValueError("Use a PNG, JPG, SVG, WebP or GIF image")
            w, h = int(request.query.get("w", "")), int(request.query.get("h", ""))
            if not (1 <= w <= 20000 and 1 <= h <= 20000):
                raise ValueError("Bad image size")
            data = await request.read()
            if not data:
                raise ValueError("No image sent")
            floor = await hub.sniffer.write("POST", f"/api/map/floors/{fid}/image", data=data, content_type=ctype,
                                            params={"w": str(w), "h": str(h)})
        except (ValueError, LookupError, sniffer_mod.SnifferError) as e:
            return plan_error(e)
        return web.json_response(floor)

    async def family(_request: web.Request) -> web.Response:
        """For the other Zigbee apps' menus (read through Home Assistant's ingress, so only by someone
        signed in to HA): where the network adapter's page is. Its address only, never its token."""
        a = hub.adapter
        host = a.host if a is not None and a.linked else None
        return web.json_response({"app": "studio", "version": hub.version, "bridge": f"http://{host}/" if host else None})

    async def status(_request: web.Request) -> web.Response:
        z = hub.z2m
        return web.json_response({
            "version": hub.version, "control": hub.control, "z2m_connected": z.connected,
            "bridge": z.bridge_state, "devices": len(z.devices), "pages": len(hub.clients),
            "ha_connected": bool(hub.ha and hub.ha.connected),
        })

    app.router.add_get("/ws", hub.handle)
    app.router.add_get("/api/status", status)
    app.router.add_get("/api/family", family)
    app.router.add_get("/sniffer/floor/{fid}/plan", plan)
    app.router.add_post("/sniffer/floor/{fid}/plan", plan_upload)
    app.router.add_get("/", static.serve)
    app.router.add_get("/{path:.+}", static.serve)
    return app


# ---------------------------------------------------------------------- heard times

def load_heard(z2m: Z2M) -> None:
    try:
        saved = json.loads((DATA_DIR / HEARD_FILE).read_text())
        z2m.heard.update({k: float(v) for k, v in saved.items()})
    except (OSError, ValueError, TypeError):
        pass


def save_heard(z2m: Z2M) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = DATA_DIR / (HEARD_FILE + ".tmp")
        tmp.write_text(json.dumps({k: round(v) for k, v in z2m.heard.items()}))
        tmp.replace(DATA_DIR / HEARD_FILE)
    except OSError as e:
        log.warning("Could not save last-heard times: %s", e)


def load_logs(z2m: Z2M) -> None:
    """Zigbee2MQTT doesn't replay its log to a new client, so the lines kept before a restart
    (or an update) come back from /data."""
    try:
        saved = json.loads((DATA_DIR / LOGS_FILE).read_text())
        z2m.logs.extend(e for e in saved if isinstance(e, dict) and isinstance(e.get("msg"), str)
                        and isinstance(e.get("ts"), (int, float)))
    except (OSError, ValueError, TypeError):
        pass


def save_logs(z2m: Z2M) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = DATA_DIR / (LOGS_FILE + ".tmp")
        tmp.write_text(json.dumps(list(z2m.logs), separators=(",", ":")))
        tmp.replace(DATA_DIR / LOGS_FILE)
    except OSError as e:
        log.warning("Could not save the log: %s", e)


async def keep_heard(z2m: Z2M) -> None:
    last = None
    while True:
        await asyncio.sleep(60)
        save_heard(z2m)
        mark = (len(z2m.logs), z2m.logs[-1]["ts"] if z2m.logs else 0)
        if mark != last:
            save_logs(z2m)
            last = mark


# ---------------------------------------------------------------------- run

async def serve(z2m_provider, ha_provider, control: bool, windfront: str | None, port: int = PORT,
                bind: str = BIND, static_root: Path = STATIC, sniffer_provider=None,
                sniffer_panel=None, adapter_file: Path | None = None) -> None:
    z2m = Z2M(z2m_provider, read_only=not control)
    ha = HomeAssistant(ha_provider)
    sn = sniffer_mod.Sniffer(sniffer_provider) if sniffer_provider else None
    adp = adapter_mod.Adapter(adapter_file or adapter_mod.FILE)
    hub = Hub(z2m, ha, VERSION, control, windfront, sniffer=sn, sniffer_panel=sniffer_panel, adapter=adp)
    load_heard(z2m)
    load_logs(z2m)
    runner = web.AppRunner(build_app(hub, static_root), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, bind, port).start()
    log.info("Zigbee Studio %s on :%d, %s", VERSION, port,
             "control ALLOWED" if control else "read-only (nothing is sent to Zigbee2MQTT)")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows
            pass
    tasks = [asyncio.create_task(z2m.run()), asyncio.create_task(ha.run()), asyncio.create_task(keep_heard(z2m))]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        save_heard(z2m)
        save_logs(z2m)
        if sn is not None:
            await sn.close()
        await adp.close()
        await runner.cleanup()


async def main() -> None:
    # what the same add-on had when installed from the old store (see carryover.py)
    carry_over(Path(os.environ.get("STUDIO_CARRY", "/share/zigbee_studio/carry-over")), DATA_DIR)
    opts = load_options()
    token = supervisor_token()
    control = bool(opts.get("allow_control", False))
    url, windfront = (opts.get("z2m_url") or "").strip() or None, None
    snf: tuple[str | None, str | None] = (None, None)
    if token:
        try:
            found, windfront = await find_z2m(token)
            url = url or found
        except Exception as e:  # noqa: BLE001
            log.warning("Could not ask the Supervisor for Zigbee2MQTT: %s", e)
        try:
            snf = await find_sniffer(token)
        except Exception as e:  # noqa: BLE001
            log.warning("Could not ask the Supervisor for the Zigbee Sniffer: %s", e)
    log.info("Zigbee Sniffer: %s", snf[0] or "not installed")
    url = url or "ws://45df7312-zigbee2mqtt:8099/api"
    url = with_token(url, opts.get("z2m_auth_token") or "")
    log.info("Zigbee2MQTT at %s", url.split("?")[0])

    async def z2m_provider() -> tuple[str, dict]:
        return url, {}

    async def ha_provider() -> tuple[str, str]:
        return "ws://supervisor/core/websocket", token

    provider, state = sniffer_provider(token, snf)
    await serve(z2m_provider, ha_provider if token else None, control, windfront,
                sniffer_provider=provider, sniffer_panel=lambda: state["panel"])


if __name__ == "__main__":
    asyncio.run(main())
