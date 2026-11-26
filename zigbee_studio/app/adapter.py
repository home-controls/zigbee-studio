"""The network adapter: a Zigbee Ethernet bridge that serves the coordinator's serial port to
Zigbee2MQTT over TCP (`serial.port: tcp://<adapter>:6638`) and has a JSON API of its own
("zbbridge/1": status, 15-minute history, events, the devices the coordinator heard, settings).

Studio links to it with the adapter's address and an API token made on the adapter's own page
(Settings, API access). Both are kept in /data/adapter.json; the token never goes back to a page.
Answers are cached for a second or two and shared between pages.

Changes follow Studio's rule for Zigbee2MQTT's own settings: nothing that would cut Zigbee2MQTT off
from its adapter. From here: the allowed Zigbee2MQTT host (refused if it would shut out the host
connected now), reboot, reset statistics. Network, port, baud, firmware and the adapter's
password stay on the adapter's own page. Changes need Allow control like any other.
"""

import asyncio
import ipaddress
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import aiohttp

log = logging.getLogger("adapter")

FILE = Path(os.environ.get("STUDIO_DATA", "/data")) / "adapter.json"
API = "zbbridge/1"
HOST = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?")
TOKEN = re.compile(r"[0-9a-f]{64}")
SERIAL_TCP = re.compile(r"tcp://([A-Za-z0-9.-]+):(\d{1,5})")
READS = {"status": 2, "history": 5, "events": 2, "devices": 4, "config": 10}
QUERY = {"since": re.compile(r"\d{1,10}")}


class AdapterError(Exception):
    pass


def suggested_host(z2m_config: dict | None) -> str | None:
    """The adapter's address when Zigbee2MQTT already reaches its adapter over TCP."""
    port = str(((z2m_config or {}).get("serial") or {}).get("port") or "")
    m = SERIAL_TCP.fullmatch(port.strip())
    return m.group(1) if m else None


def check_host(v: Any) -> str:
    host = str(v or "").strip().removeprefix("http://").rstrip("/")
    if not HOST.fullmatch(host):
        raise ValueError("Give the adapter's address, like 192.168.1.50")
    return host


def check_token(v: Any) -> str:
    tok = str(v or "").strip().lower()
    if not TOKEN.fullmatch(tok):
        raise ValueError("That isn't an adapter API token (64 hex characters, from the adapter's Settings, API access)")
    return tok


def check_read(path: Any, query: Any) -> tuple[str, dict]:
    p = str(path or "")
    if p not in READS:
        raise ValueError("Not something Zigbee Studio reads from the adapter")
    q = {}
    for k, v in (query or {}).items():
        rx = QUERY.get(k)
        if rx is None or not rx.fullmatch(str(v)):
            raise ValueError(f"Bad adapter query {k}")
        q[k] = str(v)
    return p, q


def allows(rule: str, ip: str) -> bool:
    """Whether the adapter's Zigbee2MQTT host rule ("" = anyone, an address or a CIDR) lets ip in."""
    if not rule:
        return True
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(rule if "/" in rule else rule + "/32", strict=False)
    except ValueError:
        return False


def check_change(action: Any, args: Any, status: dict | None) -> tuple[str, dict]:
    """(path, body) of an adapter change the page may make; anything else raises ValueError."""
    action = str(action or "")
    if action == "reboot":
        return "/api/reboot", {}
    if action == "stats_reset":
        return "/api/stats/reset", {}
    if action == "allow":
        rule = str((args or {}).get("allow", "")).strip() if isinstance(args, dict) else None
        if rule is None or len(rule) > 18 or not re.fullmatch(r"[0-9./]*", rule):
            raise ValueError("Give an address, a range like 192.168.1.0/24, or leave it empty for anyone")
        if rule:
            try:
                ipaddress.ip_network(rule if "/" in rule else rule + "/32", strict=False)
            except ValueError as e:
                raise ValueError("Give an address, a range like 192.168.1.0/24, or leave it empty for anyone") from e
        client = ((status or {}).get("client") or {})
        if client.get("connected") and client.get("ip") and not allows(rule, client["ip"]):
            raise ValueError(f"That would shut out Zigbee2MQTT, connected now from {client['ip']}: "
                             "Zigbee Studio won't cut Zigbee2MQTT off from its adapter")
        return "/api/config", {"allow": rule}
    raise ValueError("Not an adapter change Zigbee Studio makes (network, port, baud and firmware are on the "
                     "adapter's own page)")


class Adapter:
    def __init__(self, path: Path = FILE) -> None:
        self.path = path
        self.host: str | None = None
        self.token: str | None = None
        self.session: aiohttp.ClientSession | None = None
        self.cache: dict[tuple, tuple[float, Any]] = {}
        self.inflight: dict[tuple, asyncio.Future] = {}
        self.error = ""
        self.ok_at = 0.0
        self.load()

    # ------------------------------------------------------------------ link

    def load(self) -> None:
        try:
            d = json.loads(self.path.read_text())
            self.host = check_host(d.get("host"))
            self.token = check_token(d.get("token"))
        except (OSError, ValueError, TypeError, AttributeError):
            self.host = self.token = None

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"host": self.host, "token": self.token}))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(self.path)

    @property
    def linked(self) -> bool:
        return bool(self.host and self.token)

    def info(self, z2m_config: dict | None = None) -> dict:
        """For the page: never the token."""
        return {"linked": self.linked, "host": self.host, "suggested": suggested_host(z2m_config),
                "error": self.error, "ok_at": round(self.ok_at) or None}

    async def link(self, host: Any, token: Any) -> dict:
        h, t = check_host(host), check_token(token)
        status = await self._request("GET", "/api/status", host=h, token=t)
        if not isinstance(status, dict) or "counters" not in status:
            raise AdapterError(f"{h} answered, but not like a Zigbee Ethernet bridge")
        self.host, self.token = h, t
        self.cache.clear()
        self.save()
        log.info("Linked to the network adapter at %s (firmware %s)", h, (status.get("fw") or {}).get("version"))
        return status

    def unlink(self) -> None:
        self.host = self.token = None
        self.cache.clear()
        self.error = ""
        try:
            self.path.unlink()
        except OSError:
            pass

    # ------------------------------------------------------------------ reads and changes

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()

    async def get(self, path: Any, query: Any = None) -> Any:
        p, q = check_read(path, query)
        key = (p, tuple(sorted(q.items())))
        hit = self.cache.get(key)
        if hit and time.monotonic() - hit[0] < READS[p]:
            return hit[1]
        fut = self.inflight.get(key)
        if fut is not None:
            return await asyncio.shield(fut)
        fut = asyncio.get_running_loop().create_future()
        self.inflight[key] = fut
        try:
            data = await self._request("GET", f"/api/{p}", params=q)
            self.cache[key] = (time.monotonic(), data)
            fut.set_result(data)
            return data
        except Exception as e:
            fut.set_exception(e)
            fut.exception()
            raise
        finally:
            self.inflight.pop(key, None)

    async def change(self, action: Any, args: Any) -> Any:
        status = await self.get("status") if action == "allow" else None
        path, body = check_change(action, args, status)
        try:
            return await self._request("POST", path, json=body)
        finally:
            self.cache.clear()

    async def _request(self, method: str, path: str, *, params: dict | None = None, json: Any = None,
                       host: str | None = None, token: str | None = None) -> Any:
        host, token = host or self.host, token or self.token
        if not host or not token:
            raise LookupError("No network adapter linked: link it under Settings, Network adapter")
        if self.session is None:
            # fail fast while it reboots or is unplugged: the page shows that instead of waiting
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8, connect=3))
        try:
            async with self.session.request(method, f"http://{host}{path}", params=params, json=json,
                                            headers={"Authorization": f"Bearer {token}"}) as r:
                try:
                    body = await r.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    body = None
                err = body.get("error") if isinstance(body, dict) else None
                if r.status == 401:
                    raise AdapterError("The adapter refused Zigbee Studio's token: make a new one on the adapter's page "
                                       "(Settings, API access) and link again")
                if r.status == 403 and err == "setup required":
                    raise AdapterError("The adapter isn't set up yet: open its page and create its admin password")
                if r.status == 400:
                    raise ValueError(err or "The adapter refused it")
                if r.status != 200:
                    raise AdapterError(err or f"The adapter answered HTTP {r.status}")
        except (aiohttp.ClientError, TimeoutError) as e:
            self.error = f"Can't reach the network adapter at {host}: {str(e) or type(e).__name__}"
            raise AdapterError(self.error) from e
        except AdapterError as e:
            self.error = str(e)
            raise
        self.error = ""
        self.ok_at = time.time()
        return body
