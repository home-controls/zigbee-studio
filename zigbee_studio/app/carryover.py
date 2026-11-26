"""Carry-over: an add-on's private /data moved in from the same add-on installed from another store.

An add-on's ID (and with it its /data) depends on the store it was installed from, so moving to a new
store starts it empty. To keep what it had, the old add-on's /data is unpacked (from a Supervisor
backup of it) into /share/<name>/carry-over/, then this new one copies it in once at its first start:
every file it doesn't have yet (never overwriting, never options.json: the Supervisor owns those), and
writes /data/.carried-over so it never happens again. Same file in Zigbee Studio and Zigbee Sniffer.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

MARKER = ".carried-over"
SKIP = {"options.json", MARKER}


def carry_over(source: Path, data: Path) -> list[str]:
    """Copy `source` into `data` once. Returns the files copied (empty when there was nothing to do)."""
    marker = data / MARKER
    if marker.exists() or not source.is_dir():
        return []
    copied: list[str] = []
    try:
        for p in sorted(source.rglob("*")):
            rel = p.relative_to(source)
            if p.is_dir() or rel.parts[0] in SKIP or rel.name.endswith((".tmp", "-journal", "-wal", "-shm")):
                continue
            dest = data / rel
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + ".carry")
            shutil.copy2(p, tmp)
            tmp.replace(dest)
            copied.append(rel.as_posix())
    except OSError as e:
        # leave no marker: the next start tries again with what is still missing
        log.warning("Carry-over from %s stopped: %s (copied %d files so far)", source, e, len(copied))
        return copied
    data.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"at": time.time(), "from": str(source), "files": copied}, indent=1))
    log.info("Carried over %d files from %s", len(copied), source)
    return copied
