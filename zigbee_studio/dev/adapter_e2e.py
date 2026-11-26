"""End to end: a running Zigbee Studio (dev/run_local.py --sim, control on) linked to a REAL network adapter,
driven through Studio's own page WebSocket like the page does, through the failures that happen.

  python dev/adapter_e2e.py <adapter-host> <token-file> <password-file> [studio=http://127.0.0.1:8098]

The password is the adapter's (to revoke the token and reboot it behind Studio's back). Leaves Studio
unlinked at the end; the token file holds the new token it had to make.
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import aiohttp

HOST, TOKEN, PW = sys.argv[1], Path(sys.argv[2]).read_text().strip(), Path(sys.argv[3]).read_text().strip()
STUDIO = sys.argv[4] if len(sys.argv) > 4 else "http://127.0.0.1:8098"
X = {"X-Bridge": "1"}
results: list[bool] = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


class Page:
    """Studio's page protocol: hello, snapshot, then {op, id} requests."""

    def __init__(self, ws):
        self.ws, self.n, self.snap, self.pushed = ws, 0, None, []

    async def start(self):
        await self.ws.send_str(json.dumps({"op": "hello", "have": []}))
        while self.snap is None:
            m = json.loads((await self.ws.receive()).data)
            if m.get("t") == "snap":
                self.snap = m

    async def op(self, op, **args):
        self.n += 1
        rid = self.n
        await self.ws.send_str(json.dumps({**args, "op": op, "id": rid}))
        while True:
            m = json.loads((await asyncio.wait_for(self.ws.receive(), 40)).data)
            for x in m["m"] if m.get("t") == "b" else [m]:
                if x.get("t") == "adp":
                    self.pushed.append(x["a"])
                if x.get("t") == "r" and x.get("id") == rid:
                    return x


async def bridge(s, method, path, **kw):
    async with s.request(method, f"http://{HOST}{path}", **kw) as r:
        return r.status, await r.json(content_type=None)


async def main():
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s, s.ws_connect(f"{STUDIO}/ws") as ws:
        if True:  # keeps the steps below at one indent
            p = Page(ws)
            await p.start()
            check("snapshot carries the adapter link, never a token", "adp" in p.snap and "token" not in json.dumps(p.snap["adp"]),
                  p.snap.get("adp"))
            await p.op("adapter_unlink")

            r = await p.op("adapter_link", host="192.0.2.1", token=TOKEN)
            check("linking to an address that doesn't answer fails clearly", not r["ok"] and "Can't reach" in r["e"], r.get("e"))
            r = await p.op("adapter_link", host=HOST, token="0" * 64)
            check("linking with a wrong token fails clearly", not r["ok"] and "token" in r["e"], r.get("e"))
            r = await p.op("adapter_link", host=HOST, token=TOKEN)
            check("links to the real adapter", r["ok"] and r["d"]["fw"]["version"], r.get("d", {}).get("fw") or r.get("e"))
            check("pages are told the link changed", p.pushed and p.pushed[-1]["linked"] is True)

            for path in ("status", "history", "events", "devices", "config"):
                r = await p.op("adapter", path=path)
                check(f"reads {path} through Studio", r["ok"], "" if r["ok"] else r.get("e"))
            st = (await p.op("adapter", path="status"))["d"]
            allowed = st["client"]["allowed"]

            # the guarded change on the real adapter (nothing connected, so a range is fine), then back
            r = await p.op("adapter_set", action="allow", args={"allow": "192.168.1.0/24"})
            check("changes the allowed host on the real adapter", r["ok"] and r["d"]["allow"] == "192.168.1.0/24", r.get("e"))
            r = await p.op("adapter_set", action="allow", args={"allow": allowed})
            check("and puts it back", r["ok"] and r["d"]["allow"] == allowed)
            r = await p.op("adapter_set", action="config", args={"tcp_port": 1})
            check("refuses a port change (adapter's own page only)", not r["ok"])

            # the token revoked behind Studio's back
            async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as bs:  # the adapter is a bare IP
                await bridge(bs, "POST", "/api/login", json={"password": PW}, headers=X)
                await bridge(bs, "POST", "/api/token/revoke", json={}, headers=X)
                await asyncio.sleep(3)  # Studio's status cache
                r = await p.op("adapter", path="status")
                check("a revoked token says what to do", not r["ok"] and "make a new one" in r["e"], r.get("e"))
                info = (await p.op("adapter_info"))["d"]
                check("the link shows the trouble", "token" in info["error"], info["error"])
                _, tok = await bridge(bs, "POST", "/api/token", json={}, headers=X)
                new = tok["token"]
                Path(sys.argv[2]).write_text(new)
            r = await p.op("adapter_link", host=HOST, token=new)
            check("linking again with the new token works", r["ok"])

            # the adapter rebooting under Studio
            r = await p.op("adapter_set", action="reboot")
            check("reboots the real adapter", r["ok"])
            seen_down = False
            back = None
            slowest = 0.0
            t0 = time.time()
            while time.time() - t0 < 90:
                await asyncio.sleep(1)
                q0 = time.time()
                r = await p.op("adapter", path="status")
                slowest = max(slowest, time.time() - q0)
                if not r["ok"]:
                    seen_down = seen_down or "reach" in r["e"]
                elif (seen_down or time.time() - t0 > 20) and r["d"]["uptime"] < 60:
                    back = time.time() - t0
                    break
            check("answers every page request within 10 s while it reboots", slowest < 10, f"slowest {slowest:.1f} s, saw it down: {seen_down}")
            check("and picks it up again by itself", back is not None, f"after {back and round(back)} s")
            info = (await p.op("adapter_info"))["d"]
            check("the link's error clears once it answers", info["error"] == "", info)

            await p.op("adapter_unlink")
            check("unlinks", (await p.op("adapter_info"))["d"]["linked"] is False)
    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
