# Changelog

## 0.8.4

- **Network adapter, allowed Zigbee2MQTT host**: follows Zigbee Bridge 2.1.0, whose API token may set it
  only to one address or a range of /8 or narrower (like `192.168.1.0/24`). Studio no longer offers
  "leave it empty for anyone": an empty rule, `0.0.0.0/0` or a range wider than /8 is refused with a
  pointer to the adapter's own page, where letting anyone connect is still set. The guard that refuses
  a rule shutting out the connected Zigbee2MQTT stays.
- When the adapter turns a change down anyway, its own reason shows instead of a generic error, and the
  link isn't marked as in trouble.
- Development: the adapter simulator refuses what the bridge refuses with the API token (403 for anyone,
  wider than /8, or any other setting).
- Packaging: `build.yaml` names the base image by tag only, the form Home Assistant accepts; the
  digest pins releases build from moved to `base-images.yaml`, and CI checks the two agree. The test
  requirements include PyYAML, which the packaging test needs.

## 0.8.3

- **Ready-made images**: releases are built on GitHub, so installing or updating downloads a finished
  image instead of building it on your Home Assistant machine. Faster, and the same for everyone.

## 0.8.2

- The other Zigbee apps' menus can find the Zigbee Bridge: Studio answers `api/family` (through Home
  Assistant's ingress only) with the bridge page's address, never its token.
- The app menu also lists apps it finds through Home Assistant, not only the ones Studio knows itself.

## 0.8.1

- Links to the Zigbee Sniffer and to Zigbee2MQTT's own page open their page again instead of Home
  Assistant's dashboard: current Home Assistant serves an add-on at `/app/<slug>`, and Studio now asks
  Home Assistant where it is (older versions keep their own paths).
- The app menu opens the Zigbee Bridge's page in a new tab instead of in place of Home Assistant.

## 0.8.0

- **Its own repository**: Zigbee Studio is now an add-on repository of its own. Moving an install
  from another store: put the old install's `/data` in `/share/zigbee_studio/carry-over/` and the new
  one takes it over on its first start (the network adapter link, the recent Zigbee2MQTT log).
- **One look for the Zigbee apps**: the page is built on the shared Zigbee UI kit, the same as Zigbee
  Sniffer and Zigbee Bridge, with the same Zigbee logo. The name in the top bar opens a menu to the
  Zigbee Sniffer and the Zigbee Bridge when Studio knows where they are.
- The Zigbee Sniffer is found by its add-on ID pattern only (no fixed ID to fall back on), so a
  Sniffer installed from any store is picked up.

## 0.7.1

- **Network adapter**: tested against the real adapter (wrong address, wrong or revoked token, a reboot
  while in use). "Can't reach the adapter" now names the cause instead of leaving it blank, and gives up
  after 3 s to connect / 8 s in all, so an adapter that is rebooting or unplugged shows at once. A restart
  by the adapter's watchdog shows on its card with the reason.
- Development: `dev/check_adapter_contract.py` (the simulator against the real firmware's JSON) and
  `dev/adapter_e2e.py` (a running Studio against a real adapter, through those failures).

## 0.7.0

- **Network adapter**: link Zigbee Studio to a Zigbee Ethernet bridge (the coordinator on the
  network, Zigbee2MQTT on `tcp://...`) with its address and an API token from its own page. The
  coordinator's new **Network adapter** tab shows its health, Zigbee2MQTT's link to it, delivery
  and response time, traffic and response time over 15 minutes, the serial link, its events and
  every device the coordinator heard (last-hop signal, LQI, delivery) by name. Settings, Network
  adapter: the link, the allowed Zigbee2MQTT host (never one that would shut Zigbee2MQTT out),
  reboot, reset statistics. Health shows its score. The token stays in the add-on.

## 0.6.0

- **Groups of lights**: white and colour for the whole group, as far as every member can follow
  (white within the range they all reach, with the presets in it; colour only if they all take
  colour), next to power and brightness. Until Zigbee2MQTT publishes the group's own state, the
  controls show what the members say.
- **Group options**: retain, optimistic, off state, QoS, filtered attributes and the Home
  Assistant name, from Zigbee2MQTT's schema (group/options).
- **Health: the Sniffer's findings**: what it finds about the network as a whole (resends, busy
  channel, PAN ID conflicts, beacon requests, no key), the devices it warns about (linked to
  their Signal & traffic), and the other networks it hears on our channel.
- **Stop a firmware update** while it runs (device/ota_update/update/abort).
- **Disable / enable a device** (Advanced): Zigbee2MQTT ignores it while it stays paired.
- **The coordinator's page** shows the adapter (type, firmware, transmit power) and the network
  (channel, PAN ID, extended PAN ID) instead of device settings that don't apply to it.
- **Device links** open Zigbee2MQTT's and the Zigbee Sniffer's own pages at that device, in a new
  tab.
- **List settings** (a Hue gradient, a schedule) can be edited instead of only shown.
- The page's logic has tests (`npm test`, Node's own runner): the dev console's log matching,
  exposes sections and a group's light, settings changes.
- A page call's arguments can no longer overwrite its request id (found while adding the group
  options: an `id` argument made the answer go missing).

## 0.5.3

Fixes from an end-to-end check:

- **Composite settings** (level_config, inching control, schedules...): parts are changed first
  and sent together with **Apply** (Undo drops them), with the parts left alone as they are.
  Before, each change went out on its own, so a composite Zigbee2MQTT had never reported went
  out with one part only. A part's refresh button now asks under the composite
  (`{"level_config": {"on_off_transition_time": ""}}`), the only way Zigbee2MQTT can answer.
- **Bind / unbind** says which clusters failed. Zigbee2MQTT reports a bind that worked for some
  clusters as a success with the rest in `failed` (typically a sleeping device); Studio used to
  say "Bound" regardless.
- **The Log** keeps its last 1000 lines across restarts and updates of the add-on (saved in
  /data every minute and on stop), and the Log page loads all of them, not only the 300 the page
  opens with. The dev console's repeated-answer check also works right after a restart.
- **Colour on lights with several endpoints** goes to that endpoint's colour (`color_l2`) and
  reads its colour mode; it used to go to the main one.
- **Diagnostic values Zigbee2MQTT lets you set** can be set; they used to look settable and do
  nothing.
- The simulator's sleeping end devices miss the last cluster of a multi-cluster bind.

## 0.5.2

- The dev console answers a repeated request too. Zigbee2MQTT never sends the same log line twice
  in a row, so reading the same attributes again (same answer) used to end in "no answer"; now,
  when no fresh answer or failure has come after 15 s, Zigbee2MQTT's last line before the request
  counts as the answer if it fits (same cluster, the same attributes), marked as such.
- The simulator also leaves out a repeated log line, like Zigbee2MQTT.

## 0.5.1

- The dev console now shows the device's answer. Zigbee2MQTT 2.x writes the namespace into each
  log message (`zhc:tz: Read result of ...`) instead of sending it apart, so the console never
  recognised the answer and said "no answer" after 25 s. Studio now splits the namespace off,
  which also gives the Log page its namespace tags back.
- The simulator logs the way Zigbee2MQTT 2.x does.

## 0.5.0

Zigbee2MQTT itself, from Studio (the gear at the top right):

- **Settings → Zigbee2MQTT**: every Zigbee2MQTT setting from its schema, searchable; changes
  collect, show as changed, can be undone or set back to default, and are saved together (only
  what changed). Restart-needing settings are marked and a banner offers the restart. Settings
  that would cut Zigbee2MQTT off from the adapter, the network, MQTT, Home Assistant or Studio,
  or unload the external converters, are shown locked with the reason, and the add-on refuses
  them too.
- **Settings → Tools**: restart, download a backup (zip of Zigbee2MQTT's data folder), health
  check, coordinator check.
- **Settings → Touchlink**: scan, identify, factory reset (one found, or the nearest), with
  confirmations.
- A device's **Dev console** tab: read / write attributes and send cluster commands on any
  endpoint, names suggested, answers matched from Zigbee2MQTT's log (values as a table,
  failures with the error, "no answer" for a sleeping device).
- The add-on never sends Zigbee2MQTT requests that run code in it (`extension/*`,
  `converter/*`, `action`).
- On a narrow phone the top bar shows the logo without the name, so the buttons fit.

## 0.4.0

Maps (needs Zigbee Sniffer 0.5.13 or later, its option Share with Zigbee Studio on):

- **Map → Mesh**: who hears whom, laid out by your Home Assistant floors and rooms (or freely):
  each device's strongest three links, all, or only the weak ones, coloured by cost with the
  words beside them; end devices on their parent. Hover for neighbours and link costs, drag to
  tidy, click to open a device's signal and traffic. The routers with the fewest good links and
  the lopsided links (good one way, poor the other) below it.
- **Map → Floor plans**: devices and sniffers on your floors over the coverage the Sniffer
  estimates (best router, backup, or as each sniffer measured it); hover for the estimate and
  which router gives it.
- **Edit layout** (Allow control): add floors from a plan or as a blank grid (your Home
  Assistant floors offered), set the scale from two points, place, move and remove devices and
  sniffers (grouped by room, this floor's first), rename or delete floors. It is the Sniffer's
  own map, the same one its Map page shows.
- The top bar: with eight tabs, the search and Add devices turn into round buttons below 1500 px
  wide, the tabs into icons below 1180 px.

## 0.3.0

The Zigbee Sniffer inside Studio (needs Zigbee Sniffer 0.5.12 or later, its option Share with
Zigbee Studio on; Studio only reads):

- A device's new **Signal & traffic** tab, for 1 h, 6 h, 24 h or 7 days: signal at each sniffer
  against its normal (average with the weakest-to-strongest band), frames sent and resent, the
  Sniffer's findings, routes to and from the coordinator, who it resends to, mesh neighbours and
  link costs, whom it talks with and relays for, incidents, events (repeats grouped) and its
  latest frames. Charts follow the pointer and open as tables.
- **Traffic**: live decoded frames (every 2 s while open), filter by device or command, our
  network or every network on the channel, pause.
- **Health**: the traffic on the channel over time (ours, other networks, resends) and the
  Sniffer's incidents, newest first.
- The add-on reads the Sniffer with the key it shares in `/share/zigbee_sniffer` (this add-on
  now maps `/share` read-only), caches and shares answers between pages, and sends the page about
  half of a device's day (a fifth of its week).
- Seven tabs don't fit beside the search below 1180 px: the tabs show icons (names on hover).

## 0.2.1

Fixes from looking at 0.2.0 with the real network:

- A device option left at its default says **Default** (slider dimmed, "default" in empty boxes)
  instead of showing the slider at its minimum, which read as "set to 0".
- Number boxes in Zigbee2MQTT's options (debounce, throttle, ...) look like the other boxes, and
  show the default value they fall back to (a default of 0 was left out).
- "Add member" keeps its + on the same line.
- The top bar never runs off the side: below 1180 px wide, Add devices shrinks to a round + button
  like the search button.

## 0.2.0

Everything Zigbee2MQTT's own page does for devices, groups, pairing and updates:

- A device's page has tabs: **Overview** (controls, readings, the Sniffer's findings, its
  groups), **Settings** (its own settings, and Zigbee2MQTT's options for it: the model's own such
  as transition or color sync, and the general ones such as retain, debounce and filtered
  attributes, each with "default" and reset), **Bind** (bindings per endpoint, add one to a device
  or group with the clusters both sides support, unbind), **Reporting** (edit, turn off, set up
  reporting with attribute suggestions), **Scenes** (store the current state, recall, rename,
  remove), **Firmware** (check, update with live progress, update when a sleepy device wakes) and
  **Advanced** (interview again, reconfigure, remove, endpoints and clusters, raw state).
- **Groups**: new group, rename, delete, add and remove members (endpoint too), scenes.
- **Add devices** (header button): open joining everywhere or through one router, a countdown,
  joins and interviews as they happen, name what joined, install codes.
- **Updates**: every device that supports OTA with installed/latest/progress; check one, check
  all (mains devices), update.
- Destructive actions ask first in an in-page dialog; removing a device or deleting a group needs
  its name typed.
- Fixed: a reply that arrived in the same batch as state changes was lost, so a request could
  hang (in 0.1.x only the device page's endpoints, which could stay "Loading").
- The add-on serves a rebuilt page without a restart (development).

## 0.1.1

Looks like part of Home Assistant now:

- Follows Home Assistant's theme (colours, light/dark, its Roboto font) and changes with it.
- Pages are tabs across the top instead of a second sidebar beside HA's (a bar at the bottom on phones).
- Rooms, groups and health cards pack into columns without gaps.
- Read-only shows values and quiet bars instead of controls that don't work; switches appear
  once Allow control is on. Write-only actions (effects) are left out in read-only.
- Lights that are on use HA's amber (or their own colour); the health dot on a row only shows
  for Sniffer warnings and problems.
- Health: "Response time" was Zigbee2MQTT's report timestamp; it is now "Last health report".

## 0.1.0

First version: a fast, live page for Zigbee2MQTT beside its own, read-only until Allow control is on.

- Home (devices by Home Assistant floor and room, live, with quick switches), Devices (sortable
  table with link quality, the Zigbee Sniffer's signal and health, messages per hour, last
  heard), a page per device (controls, readings, every setting, diagnostics, Sniffer findings,
  endpoints/bindings/reporting, rename), Groups, Log and Health. Ctrl K searches everything.
- One more client of Zigbee2MQTT's own WebSocket: Zigbee2MQTT's add-on and configuration are
  untouched. Found through the Supervisor.
- The page is ~75 KB of JavaScript (Zigbee2MQTT's own: 1.5 MB) and gets ~175 KB on open (its
  own: ~1.2 MB), ~100 KB on later visits, then only changed values.
- Last heard per device, kept across restarts; the last 1000 log lines kept, so the Log page
  opens with history.
- Asks before sending to locks, covers, thermostats and anything named garage door, gate, lock
  or alarm.
