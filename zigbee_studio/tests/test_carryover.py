"""Carry-over of /data from the same add-on installed from another store."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from carryover import MARKER, carry_over  # noqa: E402


def test_copies_once_without_overwriting(tmp_path):
    src, data = tmp_path / "carry", tmp_path / "data"
    (src / "maps").mkdir(parents=True)
    (src / "adapter.json").write_text('{"host": "old"}')
    (src / "maps" / "f1.png").write_bytes(b"png")
    (src / "options.json").write_text('{"allow_control": true}')
    (src / "history.db-journal").write_text("x")
    data.mkdir()
    (data / "adapter.json").write_text('{"host": "new"}')
    assert carry_over(src, data) == ["maps/f1.png"]
    assert json.loads((data / "adapter.json").read_text()) == {"host": "new"}  # never overwritten
    assert not (data / "options.json").exists() and not (data / "history.db-journal").exists()
    assert json.loads((data / MARKER).read_text())["files"] == ["maps/f1.png"]
    (src / "logs.json").write_text("[]")
    assert carry_over(src, data) == []  # once only
    assert not (data / "logs.json").exists()


def test_nothing_to_carry(tmp_path):
    assert carry_over(tmp_path / "missing", tmp_path / "data") == []
    assert not (tmp_path / "data" / MARKER).exists()
