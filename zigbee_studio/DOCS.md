# Zigbee Studio

A fast, live web page for Zigbee2MQTT that sits beside Zigbee2MQTT's own page (Windfront). Both
show in the sidebar; use either. Zigbee Studio changes nothing in the Zigbee2MQTT add-on or its
configuration: it is one more client of the WebSocket Zigbee2MQTT already serves to its own page.

With the **Zigbee Sniffer** add-on (0.5.13 or later, its option *Share with Zigbee Studio* on),
Studio also shows what the Sniffer heard: signal and traffic history per device, routes, mesh
neighbours, incidents, live frames, the mesh as a map and floor plans with the coverage the
Sniffer estimates. Studio reads from the Sniffer and sets up its floor maps, with a key the
Sniffer keeps in `/share/zigbee_sniffer` (Studio maps `/share` read-only); the Sniffer's own page
keeps the rest of what changes something (channel, firmware, the sniffers).

It starts **read-only**: it watches and sends nothing to Zigbee2MQTT. Turn on **Allow control**
when you want to switch devices and change settings from it.

## Configuration

| Option | Meaning |
| --- | --- |
| `allow_control` | Off (default): read-only, nothing is ever sent to Zigbee2MQTT. On: devices, settings, rename, permit join, Zigbee2MQTT's settings and tools, Touchlink and the dev console work |
| `z2m_url` | Leave empty: the Zigbee2MQTT add-on is found by itself. Otherwise its WebSocket, e.g. `ws://45df7312-zigbee2mqtt:8099/api` |
| `z2m_auth_token` | Only if Zigbee2MQTT's frontend has an `auth_token` |

## The pages

- **Home**: every device by Home Assistant's floors and rooms (top floor first), each with what
  it is doing now (on and how bright, open/closed, temperature, last button) and a switch for
  lights and plugs. Filter by name, or show only what is on, offline, or has issues.
- **Devices**: one table: room, model, link quality, the Zigbee Sniffer's signal and health,
  messages per hour, last heard. Sort by any column; filter to routers/end devices, offline,
  issues or weak links.
- **A device**, in tabs:
  - **Overview**: its controls (lights get brightness, white and colour), readings, the Zigbee
    Sniffer's findings (signal, resent, no-ACK, next hop, neighbours), the groups it is in, recent
    events.
  - **Signal & traffic** (with the Zigbee Sniffer), for the last hour, 6 hours, day or week: its
    signal at each sniffer against its normal there (average, weakest and strongest frame), the
    frames it sent and how many were resent, what the Sniffer found, its route to and from the
    coordinator, the neighbours it resends to (and how often), its mesh neighbours with link
    costs, whom it talks with and relays for, incidents it was part of, events (a run of the same
    event as one line) and its latest frames. Hover a chart for the values; each opens as a table.
  - **Settings**: every setting the device exposes (grouped: LED 1, Multiclick, …) and
    Zigbee2MQTT's options for it: the model's own (transition, color sync, …) and the general ones
    (retain, debounce, filtered attributes, QoS, …). "Default" means Zigbee2MQTT's own value or
    the one for all devices; Reset goes back to it. Rename is here (Home Assistant's entity IDs
    stay unless you tick the box).
  - **Bind**: what the device talks to directly, per endpoint; add a binding to a device or a group
    (only clusters both sides support are offered), unbind.
  - **Reporting**: how often each attribute is reported (min/max seconds, change); edit, turn off,
    set up a new one.
  - **Scenes** (devices with scenes): store the current state under a number, recall, rename, remove.
  - **Firmware** (devices with OTA): installed and latest version, check, update with progress
    (and stop it: the device keeps the firmware it has), or update a sleepy device when it next
    wakes.
  - **Dev console** (Allow control): read or write a device's attributes, or send it a cluster
    command, on any endpoint (manufacturer code optional), with attribute and command names
    suggested from Zigbee2MQTT's cluster list. Answers show as they come back: a read as a table
    of values, a failure with Zigbee2MQTT's error, or "no answer" after 25 s (a sleeping device).
  - **Advanced**: interview again, reconfigure, disable (Zigbee2MQTT ignores it while it stays
    paired) or enable, remove; endpoints and clusters; diagnostics; raw state.

  Settings that are lists (a Hue gradient's colours, a schedule) can be edited: simple items as
  a comma-separated line, anything else as JSON, checked before it is sent.

  Links open the same device in Home Assistant, and in Zigbee2MQTT's and the Zigbee Sniffer's own
  pages at that device (in a new tab; Home Assistant can't open an add-on's panel at a page inside
  it). The coordinator's page shows the adapter (type, firmware, transmit power) and the network
  (channel, PAN ID, extended PAN ID). With a linked network adapter, its **Network adapter** tab
  shows the adapter's health, the link to Zigbee2MQTT, delivery and response time, Zigbee traffic
  and response time over 15 minutes, the serial link (errors, retransmits), the adapter's events,
  and every device the coordinator heard with its last-hop signal, LQI and delivery, by name.
- **Groups**: each group with power and brightness for all its members, and for lights white and
  colour as far as every member can follow (white within the range they all reach, colour only
  if they all take colour); its members live, its scenes, and Zigbee2MQTT's options for the group
  (retain, optimistic, off state, QoS, filtered attributes, Home Assistant name). New group,
  rename, delete, add or take out members.
- **Add devices** (the + button at the top): open joining for 4 minutes, everywhere or through
  the router nearest the new device; joins and interviews show as they happen; name the new
  device there. Install codes for devices that need one.
- **Updates**: every device that supports firmware updates, what's installed and available, the
  progress of running updates. Check one or all (battery devices only answer when awake), update.
- **Traffic** (with the Zigbee Sniffer): live frames, decoded: who sent what to whom (and for
  whom, when relayed), signal, resent or not, which sniffer heard it. Filter by device or
  command, our network or all networks on the channel, pause.
- **Map** (with the Zigbee Sniffer):
  - **Mesh**: who hears whom, from the routers' Link Status, laid out by your floors (a band
    each, the highest on top) and rooms in Home Assistant, or freely. Each device's strongest
    three links, every link, or only the weak ones (cost 5 or more), coloured good / fair / poor
    / bad; end devices hang off their parent with a dashed line. Hover a device to see its
    neighbours, its signal and when it was last heard; hover a link for its cost each way. Drag
    devices to tidy the picture (they stay put while the page is open; Re-arrange starts over);
    click one to open its signal and traffic. Below: the routers with the fewest good links (few
    = fragile) and lopsided links (good one way, poor the other).
  - **Floor plans**: your floors with devices and sniffers on them, over the coverage the Sniffer
    estimates: from the best router, from the second best (backup), or as each sniffer measured
    it. Hover anywhere for the estimate there and which router gives it; hover a device for its
    signal at each sniffer. Optional mesh links on the plan.
  - **Edit layout** (needs Allow control; it changes the Sniffer's map, the same one its Map page
    shows): add floors (your Home Assistant floors are offered by name and level) from a plan
    image or as a blank grid in metres; set a plan's scale by marking two points a known
    distance apart; the height between floors; pick a device or sniffer (grouped by room, this
    floor's rooms first) and click the plan to place it, drag to move, remove; rename, re-level
    or delete a floor (asks first). Coverage needs the sniffers and some devices placed on floors
    with a scale.
- **Log**: Zigbee2MQTT's log as it happens, with the last 1000 lines kept by the add-on (also
  across its restarts and updates), so opening the page shows what happened before. Filter by level or text; pause.
- **Health**: bridge, devices online, the Sniffer's verdicts, MQTT; with the Zigbee Sniffer, the
  traffic on the channel over time (ours and other networks, resends), its findings about the
  network as a whole (resends, a busy channel, PAN ID conflicts, beacon requests, no key), the
  devices it warns about and the other networks it hears on our channel, and its incidents
  (network-wide trouble: when, what, which devices); then what is offline, the
  Sniffer's warnings and problems, weak links (LQI under 60 or signal under −85 dBm), the busiest
  devices, leaves and address changes, recent joins/leaves/availability changes, and the bridge's
  versions, and the network adapter's health when one is linked. Permit join is here.

**Settings** (the gear at the top right):

- **Zigbee2MQTT**: every setting Zigbee2MQTT has, in its own groups (Advanced, Availability, MQTT,
  OTA, Home Assistant integration...), found by name or description too. Changes collect until
  you save them together; each is marked, can be undone, or put back to its default. Settings
  that need a restart say so, and after saving one a banner offers the restart. Settings that
  would cut Zigbee2MQTT off from its adapter, your network (channel, PAN ID, network key), MQTT,
  Home Assistant or Zigbee Studio, or unload your external converters, are shown locked with the
  reason; change those in the Zigbee2MQTT add-on's configuration. Zigbee2MQTT never shares the
  network key, MQTT password or frontend token, so they aren't shown.
- **Tools**: restart Zigbee2MQTT; download a backup of its data folder (configuration with the
  network key and MQTT password, device database, coordinator backup, states: keep it private);
  health check; coordinator check (routers the coordinator has lost track of).
- **Touchlink**: scan for lights within a metre or two of the coordinator on every channel
  (about a minute, during which the coordinator is off your network's channel), make one blink,
  factory-reset one (or the nearest) that won't pair.
- **Network adapter**: when the coordinator sits on a network adapter (a Zigbee Ethernet bridge
  that serves it to Zigbee2MQTT over TCP), link Zigbee Studio to it with its address (offered
  from Zigbee2MQTT's `serial.port` when that is `tcp://...`) and an API token made on the
  adapter's own page (Settings, API access). The token stays in the add-on and is never shown
  again. With Allow control: the adapter's allowed Zigbee2MQTT host (refused if it would shut out
  the Zigbee2MQTT connected now), reboot, reset its statistics, unlink. Its network, port, baud,
  firmware and password are changed only on its own page.

**Ctrl K** (or **/**) searches devices, rooms, groups and pages from anywhere. Errors Zigbee2MQTT
logs show as a note in the corner.

Lights, plugs and switches change at once; a device whose name says garage door, gate, lock or
alarm, and any lock, cover or thermostat, asks before anything is sent. Removing a device, deleting
a group, unbinding and firmware updates ask first; removing a device or deleting a group needs its
name typed.

## Why it is faster

Zigbee2MQTT's own page downloads 1.5 MB of JavaScript and then receives about 1.2 MB over its
WebSocket every time it opens (for 73 devices): every device's full definition, the source code of
external extensions and converters, cluster definitions and the configuration schema. Device state
is 4% of that.

Zigbee Studio's page is about 110 KB of JavaScript (35 KB compressed). The add-on keeps
Zigbee2MQTT's data and gives the page about 175 KB: devices, states, rooms and Sniffer health.
Devices of the same model share one copy of their exposes, and the browser keeps those, so the
next visit gets about 100 KB. After that only changes arrive, and a state change carries only the
values that changed. Each device on the page follows only its own state, so one light changing
redraws one row.

## Last heard

Zigbee2MQTT's `last_seen` is off on this install. Zigbee Studio notes when each device last sent
something (not counting the cached states Zigbee2MQTT replays on connect) and keeps it across
restarts; the Zigbee Sniffer's own "last heard" is used where it is newer.
