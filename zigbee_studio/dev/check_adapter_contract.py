"""Checks dev/adapter_sim.py still answers like the real network adapter firmware: same keys, same JSON
types, for every path Zigbee Studio reads. Run it after a firmware change, against a real bridge.

  python dev/check_adapter_contract.py <host> <token-file>

Exits non-zero and lists every difference (a key only one side has, or a different type).
"""

import asyncio
import sys
from pathlib import Path

import aiohttp

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adapter_sim

PATHS = ["status", "history", "events", "devices", "config"]


def kind(v) -> str:
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if v is None:
        return "null"
    return type(v).__name__


def diff(a, b, path: str, out: list[str]) -> None:
    if kind(a) != kind(b):
        out.append(f"{path}: real {kind(a)}, sim {kind(b)}")
        return
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in b:
                out.append(f"{path}.{k}: only the real adapter has it")
            elif k not in a:
                out.append(f"{path}.{k}: only the simulator has it")
            else:
                diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and a and b:
        diff(a[0], b[0], f"{path}[0]", out)


async def main() -> int:
    host, token = sys.argv[1], Path(sys.argv[2]).read_text().strip()
    runner = await adapter_sim.start(18199)
    out: list[str] = []
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
            for p in PATHS:
                async with s.get(f"http://{host}/api/{p}", headers={"Authorization": f"Bearer {token}"}) as r:
                    real = await r.json(content_type=None)
                async with s.get(f"http://127.0.0.1:18199/api/{p}", headers={"Authorization": f"Bearer {adapter_sim.TOKEN}"}) as r:
                    sim = await r.json(content_type=None)
                if p == "devices" and not real.get("devices"):
                    out.append("devices: the real adapter has heard none yet, rows not compared")
                    real["devices"] = sim["devices"][:1]
                diff(real, sim, p, out)
    finally:
        await runner.cleanup()
    print("\n".join(out) if out else "simulator matches the real adapter")
    return 1 if any("only" in x or ": real" in x for x in out) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
