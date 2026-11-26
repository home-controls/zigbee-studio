# Zigbee Studio (how it works)

Using it: [DOCS.md](DOCS.md).

```
browser ──ingress WS──► app/hub.py ──► app/z2m.py ──WS──► Zigbee2MQTT frontend API (:8099/api)
   ▲                       │
   │                       ├──► app/hass.py ──WS──► Core (floors, areas, devices, Sniffer health sensors)
   │                       └──► app/sniffer.py ──HTTP + key──► Zigbee Sniffer JSON API (:8099/api)
   └── app/static (built from web/)
```

- `app/z2m.py`: one connection to Zigbee2MQTT's frontend WebSocket, the API Windfront uses. Keeps
  bridge info, devices, groups, states, availability, health, the last 1000 log lines and 300
  events. States are keyed by IEEE (groups by `g<id>`), so renames don't orphan them. Emits each
  change as a small event; a state event carries only the changed keys. The cached states
  Zigbee2MQTT replays right after a connect don't count as "heard". `send()` refuses everything
  when `read_only` is set.
- `app/lean.py`: the page's view of Zigbee2MQTT's data. Devices carry an `x` hash of their
  exposes; the snapshot sends each distinct exposes list once (`x` table), and none the page
  says it already has (`hello.have`). Endpoints/options are fetched per device (`op: device`).
- `app/hub.py`: one WebSocket per page. hello → snapshot → changes. Messages are queued per page
  and one writer task drains the queue, so bursts go out as one `{"t":"b"}` batch and a stuck page
  (5000 behind) is dropped. Ops: `device` (endpoints, the model's options, the device's own and
  the global options from Zigbee2MQTT's config), `schema` (Zigbee2MQTT's config schema), `config`,
  `clusters` (cluster/attribute/command names, slimmed from bridge/definitions), `logs`, `set`,
  `get`, `req` (any bridge request, response matched by transaction; `timeout` up to 4 h for OTA
  updates), `sniffer` (`path`, `q`: a Sniffer answer, reading only, so allowed read-only),
  `map` (`action`, `args`: a floor-map change in the Sniffer), `settings` (Zigbee2MQTT's config,
  its schema, what Studio won't change and why, restart_required). `set`/`get`/`req`/`map` are
  refused without `allow_control`. `req` also never sends `extension/*`, `converter/*` or
  `action` (they run code in Zigbee2MQTT or reach into the adapter), and an `options` change
  touching a setting in `hub.LOCKED` is refused (network identity, adapter, MQTT, frontend, Home
  Assistant discovery, external JS, per-device/group sections), at any depth: removing a section
  with null counts. Zigbee2MQTT merges an options change into its settings (objects deep, lists
  replaced, null back to default), so the page sends only what changed, with null for keys
  removed from an object (`withRemovals`). Replies can travel inside a
  `b` batch: the page takes them out before applying the rest.
- `app/sniffer.py`: the Zigbee Sniffer's JSON API. The Sniffer answers only ingress,
  plus GETs of `status`, `overview`, `devices`, `device/{nwk}`, `mesh`, `live`, `map` and
  `map/coverage` carrying `X-Zigbee-Studio-Key` (the key it keeps in
  `/share/zigbee_sniffer/studio.key`; this add-on maps `/share` read-only and reads the file on
  every request, so a new key is picked up). Paths and query values are checked against that
  list here too. Answers are cached a few seconds per path and query (live 1 s, a device 15 s,
  the overview 30 s), shared between pages while in flight, and slimmed to what the page draws
  (a device's 24 h answer 95 → 48 KB, its 7 days 319 → 71 KB; link history, command counts and
  capture file names stay behind; the mesh 137 → 47 KB, its links as arrays, who talks with
  whom left out). The Sniffer is found through the Supervisor like Zigbee2MQTT
  (`*_zigbee_sniffer`), and looked for again once a minute while it isn't installed.
  Floor-map changes (Sniffer 0.5.13): `map_change()` turns an op into the Sniffer's request
  (add / update / delete a floor, positions) after checking every value (floor ids, item keys
  as IEEE, `addr:0x....` or `sniffer:<id>`, positions 0–1, sizes, scale, levels); the map answers
  are dropped from the cache after a change.
- `app/main.py` also serves a floor's plan, `GET sniffer/floor/{id}/plan?v=<file>` (kept in
  memory, 4 plans, and by the browser for a day: `v` changes when the plan is replaced; sent with
  `Content-Security-Policy: sandbox` and `nosniff`, since an SVG plan can hold script), and takes
  a new one, `POST` the same path with `?w=&h=` (its pixel size) and the image as the body:
  PNG, JPG, SVG, WebP or GIF, up to 24 MB, only with Allow control and an `X-Studio: 1` header
  (another site's form can't send one).
- `app/hass.py`: Core's WebSocket via the Supervisor proxy: floor/area/device/entity registries
  (re-read when they change) and `subscribe_entities` for the Zigbee Sniffer's
  `zigbee_sniffer_<ieee>_health` sensors.
- `app/main.py`: options, finding Zigbee2MQTT through the Supervisor (`hostname` and
  `ingress_port` of the `*_zigbee2mqtt` add-on), the web server (ingress only, gzip in memory,
  hashed assets cached forever), last-heard times saved to `/data/heard.json`.

## Messages to the page

| `t` | Meaning |
| --- | --- |
| `snap` | everything: `bridge`, `devices`, `x`, `groups`, `states`, `avail`, `heard`, `health`, `rooms`, `sniffer`, `logs`, `events`, `control`, `windfront`, `snp` (the Sniffer's panel when Studio can read it, else null) |
| `s` | state change `{k, p (changed keys), h (heard)}` |
| `a` | availability `{k, v}` |
| `l` / `e` | a log line / an event |
| `bridge`, `devices`, `groups`, `health`, `rooms` | replaced wholesale |
| `sn` | one device's Sniffer health (`null` = gone) |
| `b` | a batch of the above |
| `r` | reply to an op `{id, ok, d | e, ro}` |

## Web page

`web/`: Preact + @preact/signals, built with Vite into `app/static` (committed, so the add-on
builds without Node). Each device has its own state/availability/heard/Sniffer signals
(`store.ts`), so a message re-renders only what shows that device. The exposes table is kept in
`localStorage`. `controls.tsx` renders any Zigbee2MQTT expose (light, switch, cover, lock,
climate, fan, binary, numeric, enum, text, composite). Hash routing, since the page lives under
the ingress path. `chart.tsx` draws the Sniffer's charts by hand in SVG (a line chart with a
min–max band and reference lines, stacked columns): crosshair and one tooltip for every series,
a legend from two series, a table view; series colours are categorical slots 1–3 checked for
colour-blind separation and contrast on Home Assistant's light and dark cards. `sniffer.ts`
maps devices between Zigbee2MQTT's IEEE and the Sniffer's network address and fetches answers
again while a page shows them (not while the tab is hidden).

The maps (`pages/Map*.tsx`, `mapcommon.tsx`): the mesh is a force layout (Fruchterman–Reingold)
kept as fractions of the panel, so a resize doesn't move anything. By floor, each Home Assistant
floor is a band (busier floors taller), each room an anchor across it; devices repel only near
neighbours on their own floor, and only links within a floor pull (links between floors would
drag everything to the band edges). Names that would cover another name or dot are left out
until hovered. The floor maps compute coverage in the page from the Sniffer's fitted model
(`rssi = A − 10 n log10(d) − L·floors`, each placed router's own strength), on a 160-cell-wide
grid the browser smooths; one hue from light (weak) to dark (strong), with its own steps in dark
mode (more = lighter), and link costs as good / fair / poor / bad in words beside the colours.

Settings (`pages/Settings.tsx`) draws Zigbee2MQTT's settings schema: enums as lists, booleans as
switches, numbers and text as fields, lists of choices as chips, other lists one per line, and
anything else (objects with free keys, oneOf) as checked JSON. The dev console
(`pages/DeviceConsole.tsx`) sends `read` / `write` / `command` through the device's `/set`;
zigbee-herdsman-converters logs the outcome without the device's name ("Read result of
'<cluster>': {...}", "Wrote ...", "Invoked '<cluster>.<command>'", or Zigbee2MQTT's "Publish 'set'
'<key>' to '<device>' failed: ..."), so each request takes the first matching log line after it
was sent, and says "no answer" after 25 s. Zigbee2MQTT never sends an identical log line twice in
a row (its bridge compares each `bridge/logging` payload with the one before), so the same request
again with the same answer brings no line at all: after 15 s without a fresh answer or failure
(Zigbee2MQTT gives up on a device after 10 s), the last line before the request is taken as the
answer when it fits, and marked as such.

```
cd web && npm ci && npm run build      # → app/static
```

The look (tokens, shell, tabs, cards, charts, dialog, toasts, theme, logo) is the shared
**Zigbee UI** kit, the same as Zigbee Sniffer's and Zigbee Bridge's pages, copied into
`web/src/kit/` from the `zigbee-ui` repo. Don't edit it here: the build runs
`node src/kit/check.mjs`, which fails on a hand-edited copy. Change the kit, then copy it again:

```
node <zigbee-ui>/tools/sync.mjs web/src/kit
```

## Development

Recorded real data and a simulator, so the page (control included) can be worked on without
touching the network. The simulator answers the bridge requests the page sends (rename, options,
bind/unbind, reporting, OTA check/update with progress, interview, configure, remove, groups and
members, scenes, permit join with a fake device joining after 4 s). `dev/sniffer_sim.py` stands in
for the Zigbee Sniffer from a recording (`dev/record_sniffer.py`, read-only GETs through
ingress): devices without a recorded page borrow one, live frames replay at their real pace.
Its floor maps are the real thing: the Sniffer's own `mapping.py` (floors, plans, positions, the
coverage fit) on `.dev/sniffer-map/`; `STUDIO_SIM_MAP=demo` starts it with two blank floors and
every device placed where its signal suggests. `--live` reads the real Sniffer through its
ingress the same way (and, read-only, never changes its map). The Zigbee2MQTT simulator also
answers settings changes (merging like Zigbee2MQTT, restart_required from the schema), restart
(offline, then online), backup (a small real zip), health and coordinator checks, Touchlink
(scan takes 6 s, finds an unknown light and one of yours) and the dev console (read / write /
command logged as zigbee-herdsman-converters does; an end device times out). A sleeping end
device misses the last cluster of a multi-cluster bind or unbind, as real remotes do.

```
HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/record.py 90
HA_URL=... HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/record_sniffer.py 12
HA_URL=... HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/run_local.py --sim     # control on
HA_URL=... HA_TOKEN_FILE=... uv run --python 3.12 --with aiohttp==3.10.10 python dev/run_local.py --live    # real network, always read-only
```

The page is at http://127.0.0.1:8098/ (`npm run dev` in `web/` proxies `/ws` there for hot
reload). `--live` reaches Zigbee2MQTT through Home Assistant's ingress with a fresh ingress
session, as the Zigbee2MQTT panel does. Recordings land in `.dev/` (ignored by git).

Tests: `uv run --python 3.12 --with pytest --with aiohttp==3.10.10 --with pyyaml python -m pytest -q tests`
(pin aiohttp to the add-on's version: 3.10 lacks APIs newer versions have), and the page's
logic with `cd web && npm test`: Node's own test runner and type stripping, no extra packages
(`tests/run.mjs` lets Node find `./format` as `./format.ts`). What's tested there lives in plain
`.ts` modules without JSX: `consolematch.ts` (the dev console's answers from the log),
`settingsdiff.ts` (a settings draft as an options change), `exposes.ts` (sections, a group's
light).

Page calls are `{...args, op, id}`: `id` is the request's, so an op never takes an argument
named `id` (the group options op takes `group`).

Device links (`links.ts`) ask Home Assistant, through its connection in the parent page (same
origin, the signed-in admin), for the other add-on's ingress address, and open its page at the
device in a new tab (Windfront `#/device/0/<ieee>/info`, the Sniffer `#/device/<nwk>`); Home
Assistant answers a path after an add-on's panel with a 404. Without that connection the link is
the panel, as before.

The simulator handles messages concurrently like Zigbee2MQTT (a firmware update doesn't hold up
its abort), answers group options, disabling a device and stopping an update.
