"""What a web page needs from Zigbee2MQTT, without what it doesn't.

Zigbee2MQTT's WebSocket sends ~1.2 MB on every connect (for 73 devices): the full device list with
every device's exposes, the source code of external extensions and converters, cluster
definitions and the configuration schema. A page needs a few hundred bytes per device plus the
exposes, and most devices share their exposes with others of the same model. So devices carry a
hash of their exposes, and each distinct exposes list is sent once (and not at all if the page
already has it from an earlier visit). Endpoints, bindings, reporting and options are fetched
when a device's page opens.
"""

import hashlib
import json


def exposes_hash(exposes: list) -> str:
    return hashlib.sha1(json.dumps(exposes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def device(d: dict) -> dict:
    defn = d.get("definition") or {}
    out = {
        "ieee": d.get("ieee_address"),
        "name": d.get("friendly_name"),
        "type": d.get("type"),
        "nwk": d.get("network_address"),
        "model": defn.get("model"),
        "vendor": defn.get("vendor"),
        "desc": defn.get("description"),
        "model_id": d.get("model_id"),
        "mfr": d.get("manufacturer"),
        "power": d.get("power_source"),
        "sw": d.get("software_build_id"),
        "date": d.get("date_code"),
        "supported": d.get("supported", False),
        "disabled": d.get("disabled", False),
        "interview": d.get("interview_state") or ("SUCCESSFUL" if d.get("interview_completed") else "PENDING"),
        "ota": bool(defn.get("supports_ota")),
        "src": defn.get("source"),
        "x": exposes_hash(defn["exposes"]) if defn.get("exposes") else None,
    }
    return {k: v for k, v in out.items() if v is not None}


def devices(z2m_devices: dict[str, dict]) -> tuple[list[dict], dict[str, list]]:
    """Lean devices and the exposes table they point into."""
    table: dict[str, list] = {}
    rows = []
    for d in z2m_devices.values():
        row = device(d)
        if row.get("x"):
            table.setdefault(row["x"], d["definition"]["exposes"])
        rows.append(row)
    return rows, table


def device_detail(d: dict, info: dict | None = None) -> dict:
    """Everything a device page shows beyond the lean entry: endpoints (clusters, bindings,
    reporting, scenes), the definition's options (same format as exposes), the options set for
    this device in Zigbee2MQTT's configuration and the ones set for every device."""
    defn = d.get("definition") or {}
    cfg = (info or {}).get("config") or {}
    own = dict((cfg.get("devices") or {}).get(d.get("ieee_address"), {}))
    own.pop("friendly_name", None)
    return {
        "ieee": d.get("ieee_address"),
        "endpoints": d.get("endpoints") or {},
        "options": defn.get("options") or [],
        "config": own,
        "global": cfg.get("device_options") or {},
        "interview_completed": d.get("interview_completed"),
        "interviewing": d.get("interviewing"),
    }


def clusters(definitions: dict | None, ieee: str | None = None) -> dict:
    """Cluster, attribute and command names (bridge/definitions is ~260 KB; names are enough to
    suggest attributes for reporting and the dev console), plus a device's own custom clusters."""
    defs = definitions or {}

    def slim(cs: dict) -> dict:
        return {name: {"id": c.get("ID"), "attributes": sorted((c.get("attributes") or {}).keys()),
                       "commands": sorted((c.get("commands") or {}).keys())} for name, c in (cs or {}).items()}
    out = {"clusters": slim(defs.get("clusters") or {})}
    if ieee:
        out["custom"] = slim((defs.get("custom_clusters") or {}).get(ieee) or {})
    return out


def group(key: str, g: dict) -> dict:
    return {
        "key": key,
        "id": g.get("id"),
        "name": g.get("friendly_name"),
        "desc": g.get("description"),
        "members": [{"ieee": m.get("ieee_address"), "ep": m.get("endpoint")} for m in g.get("members") or []],
        "scenes": [{"id": s.get("id"), "name": s.get("name")} for s in g.get("scenes") or []],
    }


def bridge(z) -> dict:
    """Bridge status: state, versions, coordinator, network and the settings pages show."""
    info = z.info or {}
    cfg = info.get("config") or {}
    coord = info.get("coordinator") or {}
    meta = coord.get("meta") or {}
    adv = cfg.get("advanced") or {}
    return {
        "connected": z.connected,
        "state": z.bridge_state,
        "version": info.get("version"),
        "commit": info.get("commit"),
        "herdsman": (info.get("zigbee_herdsman") or {}).get("version"),
        "zhc": (info.get("zigbee_herdsman_converters") or {}).get("version"),
        "coordinator": {"type": coord.get("type"), "ieee": coord.get("ieee_address"),
                        "revision": meta.get("revision") or meta.get("version")},
        "network": info.get("network") or {},
        "permit_join": bool(info.get("permit_join")),
        "permit_join_end": info.get("permit_join_end"),
        "restart_required": bool(info.get("restart_required")),
        "log_level": info.get("log_level"),
        "os": info.get("os") or {},
        "adapter": (cfg.get("serial") or {}).get("adapter"),
        "transmit_power": adv.get("transmit_power"),
        "availability": bool((cfg.get("availability") or {}).get("enabled")),
        "last_seen": adv.get("last_seen"),
        "base_topic": (cfg.get("mqtt") or {}).get("base_topic"),
        "extensions": z.extensions,
        "converters": z.converters,
    }


def health(h: dict | None) -> dict | None:
    """Zigbee2MQTT's health report, with only the numbers pages show."""
    if not h:
        return None
    devs = {}
    for ieee, d in (h.get("devices") or {}).items():
        devs[ieee] = {"mps": d.get("messages_per_sec"), "msgs": d.get("messages"),
                      "leaves": d.get("leave_count"), "nwk_changes": d.get("network_address_changes")}
    return {
        "healthy": h.get("healthy"),
        "response_time": h.get("response_time"),
        "process": h.get("process") or {},
        "os": h.get("os") or {},
        "mqtt": h.get("mqtt") or {},
        "devices": devs,
    }
