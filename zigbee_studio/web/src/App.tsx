// The shell: navigation, status bar, command palette, toasts, connection banners.

import { useEffect, useRef, useState } from "preact/hooks";
import { computed, effect, signal } from "@preact/signals";
import { adapter, bridge, conn, control, devices, groups, ready, version, windfront, counts, rooms, areaOf, exposesOf, stateOf, snifferPanel } from "./store";
import { matches } from "./format";
import { kindOf } from "./exposes";
import { Icon, KIND_ICON } from "./icons";
import { go, href, route } from "./route";
import { Home } from "./pages/Home";
import { Devices } from "./pages/Devices";
import { Device } from "./pages/Device";
import { Groups } from "./pages/Groups";
import { Logs } from "./pages/Logs";
import { Health } from "./pages/Health";
import { Traffic } from "./pages/Traffic";
import { MapPage } from "./pages/Map";
import { SettingsPage, restartZ2M } from "./pages/Settings";
import { Pairing } from "./pages/Pairing";
import { Updates } from "./pages/Updates";
import { updateState } from "./pages/DeviceMisc";
import { Shell, Splash } from "./kit/shell";
import { initTheme } from "./kit/theme";
import { useFamily } from "./kit/family";
import { readOnly } from "./kit/ui";

const { embedded } = initTheme("zs.theme");
// toggles and sliders show values, not controls, until "Allow control" is on
effect(() => { readOnly.value = !control.value; });

const ALL_NAV = [
  { id: "home", label: "Home", icon: "home" },
  { id: "devices", label: "Devices", icon: "list" },
  { id: "groups", label: "Groups", icon: "groups" },
  { id: "updates", label: "Updates", icon: "refresh" },
  { id: "traffic", label: "Traffic", icon: "signal" },
  { id: "map", label: "Map", icon: "mesh" },
  { id: "logs", label: "Log", icon: "logs" },
  { id: "health", label: "Health", icon: "health" },
];
const SNIFFER_PAGES = new Set(["traffic", "map"]);
const navItems = computed(() => ALL_NAV.filter((n) => !SNIFFER_PAGES.has(n.id) || snifferPanel.value));

const paletteOpen = signal(false);

const updatesAvailable = computed(() => devices.value.filter((d) => d.ota && updateState(stateOf(d.ieee).value).state === "available").length);

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        paletteOpen.value = true;
      }
      if (e.key === "Escape") paletteOpen.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // before any early return: hooks run in the same order every render
  const family = useFamily({ sniffer: snifferPanel.value ?? undefined, bridge: adapter.value?.host ? `http://${adapter.value.host}/` : undefined });

  if (!ready.value) {
    return <Splash>{conn.value === "closed" ? "Can't reach Zigbee Studio's backend, retrying…" : "Connecting…"}</Splash>;
  }
  const r = route.value;
  const page = r[0];
  const nav = navItems.value.map((n) => (n.id === "updates" ? { ...n, badge: updatesAvailable.value } : n));
  const current = page === "device" ? "devices" : page;
  return (
    <Shell app="studio" version={version.value} nav={nav} page={current} embedded={embedded} right={<TopRight />} banner={<Banners />}
      links={family}>
      {page === "home" && <Home />}
      {page === "devices" && <Devices />}
      {page === "device" && <Device ieee={r[1]} tab={r[2]} />}
      {page === "pairing" && <Pairing />}
      {page === "updates" && <Updates />}
      {page === "groups" && <Groups />}
      {page === "logs" && <Logs initial={r[1]} key={r[1] || ""} />}
      {page === "health" && <Health />}
      {page === "traffic" && <Traffic />}
      {page === "map" && <MapPage view={r[1]} floor={r[2]} />}
      {page === "settings" && <SettingsPage tab={r[1]} section={r[2]} />}
      {!navItems.value.some((n) => n.id === page) && page !== "device" && page !== "pairing" && page !== "settings" && <Home />}
      {paletteOpen.value && <Palette />}
    </Shell>
  );
}

function TopRight() {
  const b = bridge.value;
  const c = counts.value;
  const up = b?.connected && b.state === "online";
  return (
    <>
      <button type="button" class="search-btn" onClick={() => (paletteOpen.value = true)} aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">
        <Icon name="search" size={16} />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <span class={`pill ${up ? "ok" : "bad"}`} title={b?.connected ? `Zigbee2MQTT ${b.state}` : "Not connected to Zigbee2MQTT"}>
        <span class="dot" /><span class="pill-text">{up ? "Online" : b?.connected ? "Zigbee2MQTT offline" : "No Zigbee2MQTT"}</span>
      </span>
      {c.offline > 0 && <a class="pill bad" href={href("health")}>{c.offline}<span class="pill-text"> offline</span></a>}
      {b?.permit_join && <span class="pill warn">Joining<span class="pill-text"> open</span></span>}
      {control.value && (
        <a class={`btn small ${b?.permit_join ? "primary" : ""}`} href={href("pairing")} title="Add devices (permit join)">
          <Icon name="plus" size={14} /><span class="pill-text">Add devices</span>
        </a>
      )}
      {!control.value && <span class="pill" title="Read-only: turn on Allow control in the add-on's configuration to switch devices"><Icon name="lock" size={13} /><span class="pill-text">Read-only</span></span>}
      <a class={`icon-btn ${route.value[0] === "settings" ? "active" : ""}`} href={href("settings")} title="Settings, tools and Touchlink" aria-label="Settings, tools and Touchlink">
        <Icon name="gear" size={18} />
      </a>
      {windfront.value && (
        <a class="icon-btn" href={windfront.value} target="_top" title="Open Zigbee2MQTT's own page" aria-label="Open Zigbee2MQTT's own page">
          <Icon name="external" size={18} />
        </a>
      )}
    </>
  );
}

function Banners() {
  const b = bridge.value;
  if (conn.value !== "open") return <div class="banner warn"><Icon name="refresh" size={16} /> Reconnecting… showing the last known state.</div>;
  if (b && !b.connected) return <div class="banner bad"><Icon name="alert" size={16} /> Zigbee Studio can't reach Zigbee2MQTT; retrying. States below may be stale.</div>;
  if (b && b.state !== "online") return <div class="banner bad"><Icon name="alert" size={16} /> Zigbee2MQTT reports it is {b.state || "offline"}.</div>;
  if (b?.restart_required) {
    return (
      <div class="banner warn"><Icon name="refresh" size={16} /> Zigbee2MQTT needs a restart for saved settings to take effect.
        {control.value && <button type="button" class="link-btn" onClick={restartZ2M}>Restart now</button>}</div>
    );
  }
  return null;
}

interface Hit { label: string; sub: string; icon: string; go: () => void; }

function Palette() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const hits: Hit[] = [];
  const close = () => (paletteOpen.value = false);
  for (const n of navItems.value) if (!q || matches(q, n.label)) hits.push({ label: n.label, sub: "Page", icon: n.icon, go: () => go(n.id) });
  for (const [label, path] of [["Settings", ["settings"]], ["Tools: restart, backup, checks", ["settings", "tools"]], ["Touchlink", ["settings", "touchlink"]], ["Network adapter", ["settings", "adapter"]]] as [string, string[]][]) {
    if (!q || matches(q, label)) hits.push({ label, sub: "Settings", icon: "gear", go: () => go(...path) });
  }
  for (const d of devices.value) {
    if (d.type === "Coordinator") continue;
    const area = areaOf(d.ieee)?.name;
    if (!q || matches(q, d.name, area, d.model, d.vendor)) {
      hits.push({ label: d.name, sub: [area, d.vendor, d.model].filter(Boolean).join(" · "), icon: KIND_ICON[kindOf(d, exposesOf(d))], go: () => go("device", d.ieee) });
    }
  }
  for (const g of groups.value) if (!q || matches(q, g.name, "group")) hits.push({ label: g.name, sub: "Group", icon: "groups", go: () => go("groups") });
  for (const a of rooms.value?.areas || []) if (q && matches(q, a.name)) hits.push({ label: a.name, sub: "Room", icon: "home", go: () => go("home") });
  const list = hits.slice(0, 50);
  const pick = (h: Hit | undefined) => {
    if (!h) return;
    h.go();
    close();
  };
  return (
    <div class="palette-back" onClick={close}>
      <div class="palette" role="dialog" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <label class="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={q} placeholder="Jump to a device, group, room or page" aria-label="Search"
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(sel + 1, list.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
              if (e.key === "Enter") pick(list[sel]);
            }} />
        </label>
        <ul class="palette-list" role="listbox">
          {list.map((h, i) => (
            <li role="option" aria-selected={i === sel} class={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => pick(h)}>
              <Icon name={h.icon} size={18} />
              <span class="pl-label">{h.label}</span>
              <span class="pl-sub">{h.sub}</span>
            </li>
          ))}
          {list.length === 0 && <li class="muted">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
