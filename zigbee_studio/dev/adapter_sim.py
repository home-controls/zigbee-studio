"""A stand-in network adapter (the Zigbee Ethernet bridge's "zbbridge/1" JSON API) for development:
the same paths, Bearer-token check and refusals as the real firmware, with devices taken from the
Zigbee2MQTT recording (their network addresses), traffic that moves, and settings that change.

  uv run --python 3.12 --with aiohttp==3.10.10 python dev/adapter_sim.py [port]
"""

import ipaddress
import json
import os
import math
import random
import sys
import time
from pathlib import Path
# recordings and local state: .dev/ (STUDIO_DEV_DIR=.dev-demo for the anonymised demo set, see dev/demo_data.py)
DEV_DIR = Path(os.environ.get("STUDIO_DEV_DIR") or Path(__file__).resolve().parent.parent / ".dev")

from aiohttp import web


REC = DEV_DIR / "z2m_recording.jsonl"
TOKEN = "0123456789abcdef" * 4  # the simulator's API token (dev only)
BOOT = time.time()
TOKEN_REFUSED = ("The API token can only set radio 1's allowed host to one address or a range of /8 or narrower; "
                 "use the dashboard for the rest")


def token_may_allow(rule) -> bool:
    """What the bridge (2.1.0+) lets its API token set the allowed host to: a.b.c.d or a.b.c.d/nn, nn >= 8."""
    if not isinstance(rule, str) or not rule:
        return False
    try:
        return ipaddress.IPv4Network(rule if "/" in rule else rule + "/32", strict=False).prefixlen >= 8
    except ValueError:
        return False


def recorded_devices() -> list[dict]:
    try:
        for line in REC.read_text(encoding="utf-8").splitlines():
            m = json.loads(line)["m"]
            if m.get("topic") == "bridge/devices":
                return [d for d in m["payload"] if d.get("type") != "Coordinator" and d.get("network_address") is not None]
    except (OSError, ValueError, KeyError):
        pass
    return [{"network_address": n, "ieee_address": f"0x00124b00{n:08x}"} for n in range(0x1001, 0x1015)]


class AdapterSim:
    def __init__(self) -> None:
        self.cfg = {"hostname": "zigbee-eth-bridge", "mode": "static", "ip": "127.0.0.1", "mask": "255.255.255.0",
                    "gw": "192.168.1.1", "dns": "192.168.1.1", "allow": "", "tcp_port": 6638, "baud": 115200}
        rnd = random.Random(7)
        self.devs = []
        for d in recorded_devices():
            rssi = rnd.uniform(-88, -52)
            self.devs.append({"short": f"0x{d['network_address']:04x}", "ieee": d.get("ieee_address", ""),
                              "rssi_avg": round(rssi), "lqi_avg": max(20, min(255, int(255 + (rssi + 52) * 4))),
                              "rate": rnd.uniform(0.002, 0.06), "fail": 0.0 if rssi > -80 else rnd.uniform(0.02, 0.15)})
        self.events = [{"id": 1, "up": 1, "epoch": 0, "level": 0, "text": "Booted firmware 1.0.2 (simulator)"},
                       {"id": 2, "up": 3, "epoch": 0, "level": 0, "text": "Ethernet link up (100 Mbps full duplex)"},
                       {"id": 3, "up": 4, "epoch": 0, "level": 0, "text": "Dongle connected: SONOFF Dongle Plus MG24, serial 0123456789abcdef0123456789abcdef, 115200 baud"},
                       {"id": 4, "up": 9, "epoch": 0, "level": 0, "text": "Zigbee2MQTT connected from 172.30.33.5"},
                       {"id": 5, "up": 12, "epoch": 0, "level": 0, "text": "Coordinator: EZSP v19, stack 9.1.1.0"},
                       {"id": 6, "up": 13, "epoch": 0, "level": 0, "text": "Zigbee network is up"}]
        self.since = 0

    def up(self) -> int:
        return int(time.time() - BOOT) + 3600

    def event(self, level: int, text: str) -> None:
        self.events.append({"id": self.events[-1]["id"] + 1, "up": self.up(), "epoch": int(time.time()), "level": level, "text": text})

    def wave(self, t: float, base: float) -> float:
        return max(0.0, base * (1 + 0.6 * math.sin(t / 47) + 0.3 * math.sin(t / 13)))

    def history(self) -> dict:
        now = self.up()
        out = {k: [] for k in ("t", "in", "out", "rx", "ok", "fail", "cmds", "rtt", "rttmax", "err")}
        rnd = random.Random(now // 60)
        for t in range(now - 899, now + 1):
            rx = int(self.wave(t, 1.3) + rnd.random())
            ok = int(self.wave(t + 9, 0.6) + rnd.random() * 0.8)
            fail = 1 if rnd.random() < 0.01 else 0
            out["t"].append(t)
            out["rx"].append(rx)
            out["ok"].append(ok)
            out["fail"].append(fail)
            out["cmds"].append(ok + rnd.randint(0, 1))
            out["in"].append(rx * 60 + rnd.randint(0, 40))
            out["out"].append(ok * 45 + rnd.randint(0, 20))
            rtt = round(rnd.uniform(6, 14), 1) if ok else 0
            out["rtt"].append(rtt)
            out["rttmax"].append(round(rtt * rnd.uniform(1, 2.5), 1) if rtt else 0)
            out["err"].append(1 if rnd.random() < 0.003 else 0)
        return out

    def status(self) -> dict:
        up = self.up()
        n = up - self.since
        a = {"bytes": n * 70, "frames": n * 3, "data": n * 2, "ack": n, "nak": 0, "rst": 1, "rstack": 0, "error": 0,
             "retx": 2, "crc_err": 0, "cancel": 1, "substitute": 0, "oversize": 0}
        b = {**a, "bytes": n * 95, "rst": 0, "rstack": 1, "retx": 1}
        hist = [n // 40, n // 9, n // 3, n // 2, n // 6, n // 30, n // 200, 3, 1, 0, 0, 0]
        return {
            "fw": {"version": "1.0.2", "project": "zigbee_eth_bridge", "idf": "v5.5.6", "built": "simulator",
                   "partition": "ota_0", "pending_verify": False},
            "sys": {"chip": "ESP32-P4 rev 1.3, 2 cores", "reset_reason": "Power on", "watchdog": "", "temp_c": 41.5,
                    "heap_free": 390000, "heap_min": 371000, "heap_largest": 300000},
            "uptime": up, "epoch": int(time.time()), "stats_since": self.since,
            "health": {"score": 96, "reason": "Zigbee delivery failures"},
            "eth": {"link": True, "has_ip": True, "speed": 100, "full_duplex": True, "ip": self.cfg["ip"],
                    "mask": self.cfg["mask"], "gw": self.cfg["gw"], "mac": "02:00:00:00:97:52", "mode": self.cfg["mode"],
                    "hostname": self.cfg["hostname"]},
            "dongle": {"present": True, "open": True, "usb_id": "10c4:ea60", "manufacturer": "SONOFF",
                       "product": "SONOFF Dongle Plus MG24", "serial": "0123456789abcdef0123456789abcdef",
                       "since": 4, "baud": self.cfg["baud"]},
            "client": {"connected": True, "ip": "172.30.33.5", "port": 41234, "since": 9, "allowed": self.cfg["allow"],
                       "tcp_port": self.cfg["tcp_port"]},
            "ncp": {"ezsp": 19, "stack": "9.1.1.0", "reset_code": 11, "error_code": 0, "network": "up"},
            "counters": {"host": a, "ncp": b, "ezsp_cmds": n, "ezsp_responses": n, "ezsp_callbacks": n * 2,
                         "zb_rx": int(n * 1.3), "zb_unicast": int(n * 0.6), "zb_broadcast": n // 50, "zb_multicast": 0,
                         "zb_sent_ok": int(n * 0.6), "zb_sent_fail": n // 120, "route_errors": n // 900,
                         "net_status": n // 600, "joins": 0, "leaves": 0, "id_conflicts": 0,
                         "rtt_avg_ms": 9.4, "rtt_max_ms": 61.0, "rtt_n": sum(hist), "rtt_hist": hist,
                         "ack_avg_ms": 3.1, "ack_max_ms": 18.0, "clients_accepted": 1, "clients_refused": 0,
                         "client_drops": 0, "dropped_no_client": 0, "dropped_overflow": 0, "dongle_tx_errors": 0,
                         "dongle_attach": 1, "dongle_detach": 0},
        }

    def devices(self) -> dict:
        up = self.up()
        n = up - self.since
        out = []
        for d in self.devs:
            rx = int(n * d["rate"])
            tx = int(n * d["rate"] * 0.4)
            fail = int(tx * d["fail"])
            out.append({"short": d["short"], "ieee": d["ieee"], "rx": rx, "tx_ok": tx - fail, "tx_fail": fail,
                        "route_err": 1 if d["fail"] > 0.1 else 0, "lqi": d["lqi_avg"], "rssi": d["rssi_avg"],
                        "lqi_avg": d["lqi_avg"], "rssi_avg": d["rssi_avg"], "first": 20,
                        "last": up - int(1 / max(d["rate"], 0.001)) % 600, "last_fail": up - 300 if fail else 0,
                        "last_fail_status": 0x0C02 if fail else 0})
        return {"uptime": up, "devices": out}


def app() -> web.Application:
    sim = AdapterSim()

    @web.middleware
    async def auth(request: web.Request, handler):
        if request.path == "/api/state":
            return await handler(request)
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.json_response({"error": "login required"}, status=401)
        return await handler(request)

    async def state(_r):
        return web.json_response({"setup_required": False, "authed": False, "locked": False, "api_token_set": True,
                                  "api": "zbbridge/1", "version": "1.0.2", "hostname": sim.cfg["hostname"]})

    async def config_post(r: web.Request):
        try:
            body = await r.json()
        except ValueError:
            return web.json_response({"error": "bad JSON"}, status=400)
        # Zigbee Bridge 2.1.0+: the API token (all this simulator takes) may only set radio 1's allowed host, to one
        # address or a range of /8 or narrower; "anyone" (empty, 0.0.0.0/0), wider ranges and every other setting
        # are the dashboard's
        if not isinstance(body, dict) or set(body) != {"allow"} or not token_may_allow(body["allow"]):
            return web.json_response({"error": TOKEN_REFUSED}, status=403)
        if "allow" in body:
            sim.cfg["allow"] = body["allow"]
            sim.event(0, f"Z2M host set to '{body['allow'] or 'anyone'}'")
        return web.json_response({**sim.cfg, "reboot_required": False})

    async def reboot(_r):
        sim.event(0, "Reboot requested from the dashboard")
        return web.json_response({"ok": True})

    async def stats_reset(_r):
        sim.since = sim.up()
        sim.event(0, "Statistics reset")
        return web.json_response({"ok": True})

    async def events(r: web.Request):
        since = int(r.query.get("since", "0"))
        return web.json_response({"events": [e for e in sim.events if e["id"] > since], "uptime": sim.up()})

    def answer(fn):
        async def handler(_r):
            return web.json_response(fn())
        return handler

    a = web.Application(middlewares=[auth])
    a.router.add_get("/api/state", state)
    a.router.add_get("/api/status", answer(sim.status))
    a.router.add_get("/api/history", answer(sim.history))
    a.router.add_get("/api/events", events)
    a.router.add_get("/api/devices", answer(sim.devices))
    a.router.add_get("/api/config", answer(lambda: sim.cfg))
    a.router.add_post("/api/config", config_post)
    a.router.add_post("/api/reboot", reboot)
    a.router.add_post("/api/stats/reset", stats_reset)
    return a


async def start(port: int) -> web.AppRunner:
    runner = web.AppRunner(app(), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    return runner


if __name__ == "__main__":
    web.run_app(app(), host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 18101)
