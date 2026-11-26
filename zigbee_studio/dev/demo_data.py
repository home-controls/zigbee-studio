"""Makes an anonymised copy of the recordings for screenshots and demos: .dev/ -> .dev-demo/.

Recordings of a real network hold its names (people's rooms, nicknames) and addresses. This copies
them with every match of a replacement list rewritten everywhere: device and group names, rooms and
floors, MQTT topics, the Sniffer recording, the map. Always rewritten: private network addresses (to
documentation-style examples) and every device's IEEE address (its vendor prefix kept, the rest made
up from a secret salt in .dev/demo_salt, so the same device gets the same made-up address in every
file and run, and the made-up one can't be traced back). The names are yours to list, in
.dev/demo_names.json (inside the git-ignored .dev/, so the list itself is never committed):

    [["Alice's Room", "Bedroom 2"], ["alices_room", "bedroom_2"], ["Nickname", "Sunroom"]]

Each pair is a regular expression and its replacement, applied in order (put longer ones first).
Then:

    python dev/demo_data.py
    STUDIO_DEV_DIR=.dev-demo python dev/run_local.py --sim
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, DST = ROOT / ".dev", ROOT / ".dev-demo"
NAMES = SRC / "demo_names.json"
SALT = SRC / "demo_salt"
IEEE = re.compile(r"(?<![0-9a-fA-F])0x([0-9a-fA-F]{6})([0-9a-fA-F]{10})(?![0-9a-fA-F])")  # also inside zigbee2mqtt_0x...

# private network addresses -> 192.168.1.x examples (the last octet kept)
ADDRESSES: list[tuple[str, str]] = [
    (r"\b10\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b", r"192.168.1.\1"),
    (r"\b172\.(1[6-9]|2\d|3[01])\.(?!30\.32\.2\b|30\.33\.)\d{1,3}\.(\d{1,3})\b", r"192.168.1.\2"),  # not HA's own
]
TEXT = {".json", ".jsonl", ".log", ".txt", ".yaml", ".csv"}


def ieee_faker():
    """0x<vendor 6 hex><10 hex> -> the same vendor prefix and 10 hex from HMAC(salt, address)."""
    if not SALT.exists():
        SALT.write_text(secrets.token_hex(16))
    salt = SALT.read_text().strip().encode()

    def fake(m: re.Match) -> str:
        real = (m.group(1) + m.group(2)).lower()
        tail = hashlib.blake2s(real.encode(), key=salt, digest_size=5).hexdigest()
        return f"0x{m.group(1).lower()}{tail}"
    return fake


def main() -> None:
    if not SRC.is_dir():
        sys.exit(f"no recordings in {SRC} (dev/record.py makes them)")
    names = json.loads(NAMES.read_text(encoding="utf-8")) if NAMES.exists() else []
    if not names:
        print(f"note: no {NAMES.name}: only addresses are rewritten; names stay as recorded")
    if DST.exists():
        shutil.rmtree(DST)
    pats = [(re.compile(a), b) for a, b in [*names, *ADDRESSES]]
    fake_ieee = ieee_faker()
    n = 0
    for p in sorted(SRC.rglob("*")):
        rel = p.relative_to(SRC)
        if p.is_dir() or rel.parts[0] in ("data", "static") or p in (NAMES, SALT):  # local state, builds, the list
            continue
        out = DST / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if p.suffix in TEXT:
            s = p.read_text(encoding="utf-8", errors="replace")
            # a curly apostrophe as JSON writes it (escaped once, or twice inside a recorded message)
            s = s.replace("\\u2019", "'").replace("’", "'")
            for rx, rep in pats:
                s = rx.sub(rep, s)
            s = IEEE.sub(fake_ieee, s)
            out.write_text(s, encoding="utf-8", newline="\n")
            n += 1
        else:
            shutil.copy2(p, out)
    print(f"{DST}: {n} text files rewritten with {len(names)} name rules")


if __name__ == "__main__":
    main()
