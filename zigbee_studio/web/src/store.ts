// All live state, as signals. Each device has its own state / availability / heard / sniffer
// signals, so a message about one device re-renders only what shows that device.

import { batch, computed, signal, type Signal } from "@preact/signals";
import type { AdapterInfo, Bridge, Dev, Ev, Expose, Group, Health, LogEntry, Rooms, Sniffer, State } from "./types";
import { nowS, setClockSkew } from "./kit/format";
import { panelHref } from "./links";

export const conn = signal<"connecting" | "open" | "closed">("connecting");
export const ready = signal(false); // first snapshot received
export const control = signal(false);
export const version = signal("");
export const windfront = signal<string | null>(null);
export const snifferPanel = signal<string | null>(null); // the Zigbee Sniffer's panel, when Studio can read it
export const adapter = signal<AdapterInfo | null>(null); // the network adapter link (null: no support in the backend)
export const bridge = signal<Bridge | null>(null);
export const devices = signal<Dev[]>([]);
export const groups = signal<Group[]>([]);
export const rooms = signal<Rooms | null>(null);
export const health = signal<Health | null>(null);
export const logs = signal<LogEntry[]>([]);
export const events = signal<Ev[]>([]);
export const skew = signal(0); // server clock - this clock (seconds)
export const exposesVersion = signal(0); // bumps when the exposes table changes

const LOG_KEEP = 1000;
const EVENT_KEEP = 300;

export const devByKey = computed(() => new Map(devices.value.map((d) => [d.ieee, d])));
export const groupByKey = computed(() => new Map(groups.value.map((g) => [g.key, g])));

// ------------------------------------------------------------------ per-key signals

function family<T>(init: () => T) {
  const map = new Map<string, Signal<T>>();
  const get = (key: string): Signal<T> => {
    let s = map.get(key);
    if (!s) {
      s = signal(init());
      map.set(key, s);
    }
    return s;
  };
  return { get, map };
}

const stateFam = family<State>(() => ({}));
const availFam = family<string | undefined>(() => undefined);
const heardFam = family<number | undefined>(() => undefined);
const snifferFam = family<Sniffer | undefined>(() => undefined);

export const stateOf = stateFam.get;
export const availOf = availFam.get;
export const heardOf = heardFam.get;
export const snifferOf = snifferFam.get;

// ------------------------------------------------------------------ exposes table (kept in the browser)

const X_KEY = "zs.exposes.v1";
const exposesTable = new Map<string, Expose[]>();
try {
  const saved = JSON.parse(localStorage.getItem(X_KEY) || "{}");
  for (const [h, x] of Object.entries(saved)) exposesTable.set(h, x as Expose[]);
} catch {
  /* private window or blocked storage: the snapshot sends them all */
}

export function knownExposes(): string[] {
  return [...exposesTable.keys()];
}

export function exposesOf(dev: Dev | undefined): Expose[] {
  exposesVersion.value; // re-run when the table changes
  return (dev?.x && exposesTable.get(dev.x)) || [];
}

function mergeExposes(x: Record<string, Expose[]> | undefined, devs: Dev[]) {
  let changed = false;
  for (const [h, e] of Object.entries(x || {})) {
    exposesTable.set(h, e);
    changed = true;
  }
  const used = new Set(devs.map((d) => d.x).filter(Boolean));
  for (const h of [...exposesTable.keys()]) {
    if (!used.has(h)) {
      exposesTable.delete(h);
      changed = true;
    }
  }
  if (changed) {
    exposesVersion.value++;
    try {
      localStorage.setItem(X_KEY, JSON.stringify(Object.fromEntries(exposesTable)));
    } catch {
      /* quota or blocked: fine, next visit gets them from the snapshot */
    }
  }
}

// ------------------------------------------------------------------ messages

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function apply(msg: any): void {
  switch (msg.t) {
    case "b":
      batch(() => msg.m.forEach(apply));
      break;
    case "snap":
      batch(() => {
        version.value = msg.v;
        control.value = msg.control;
        // panel paths as Home Assistant serves them now (/app/<slug>), not the raw /<slug>
        windfront.value = panelHref(msg.windfront);
        snifferPanel.value = panelHref(msg.snp);
        adapter.value = msg.adp ?? null;
        skew.value = msg.now - Date.now() / 1000;
        setClockSkew(skew.value);
        bridge.value = msg.bridge;
        mergeExposes(msg.x, msg.devices);
        devices.value = [...msg.devices].sort(byName);
        groups.value = [...msg.groups].sort(byName);
        rooms.value = msg.rooms;
        health.value = msg.health;
        logs.value = msg.logs;
        events.value = msg.events;
        for (const [k, st] of Object.entries(msg.states)) stateOf(k).value = st as State;
        for (const [k, v] of Object.entries(msg.avail)) availOf(k).value = v as string;
        for (const [k, v] of Object.entries(msg.heard)) heardOf(k).value = v as number;
        for (const [k, s] of snifferFam.map) if (!(k in msg.sniffer)) s.value = undefined;
        for (const [k, v] of Object.entries(msg.sniffer)) snifferOf(k).value = v as Sniffer;
        ready.value = true;
      });
      break;
    case "s": {
      const s = stateOf(msg.k);
      s.value = { ...s.value, ...msg.p };
      if (msg.h) heardOf(msg.k).value = msg.h;
      break;
    }
    case "a":
      availOf(msg.k).value = msg.v;
      break;
    case "l":
      logs.value = logs.value.length >= LOG_KEEP ? [...logs.value.slice(1 - LOG_KEEP), msg.e] : [...logs.value, msg.e];
      break;
    case "e":
      events.value = events.value.length >= EVENT_KEEP ? [...events.value.slice(1 - EVENT_KEEP), msg.e] : [...events.value, msg.e];
      break;
    case "bridge":
      bridge.value = msg.b;
      break;
    case "devices":
      mergeExposes(msg.x, msg.d);
      devices.value = [...msg.d].sort(byName);
      break;
    case "groups":
      groups.value = [...msg.g].sort(byName);
      break;
    case "health":
      health.value = msg.h;
      break;
    case "rooms":
      rooms.value = msg.r;
      break;
    case "sn":
      snifferOf(msg.k).value = msg.v ?? undefined;
      break;
    case "adp":
      adapter.value = msg.a ?? null;
      break;
  }
}

// ------------------------------------------------------------------ derived

/** The kit's 15 s tick and clock (nowS follows the backend's clock: see setClockSkew). */
export { tick } from "./kit/format";

export { nowS };

export function areaOf(key: string): { id: string; name: string; floor: string | null } | undefined {
  const r = rooms.value;
  const a = r?.dev[key]?.area;
  return a ? r!.areas.find((x) => x.id === a) : undefined;
}

export const counts = computed(() => {
  let online = 0,
    offline = 0,
    routers = 0,
    ends = 0;
  for (const d of devices.value) {
    if (d.type === "Coordinator") continue;
    if (d.type === "Router") routers++;
    else ends++;
    const a = availOf(d.ieee).value;
    if (a === "offline") offline++;
    else online++;
  }
  return { online, offline, routers, ends, total: routers + ends };
});

export const snifferCounts = computed(() => {
  const c: Record<string, number> = {};
  for (const d of devices.value) {
    const s = snifferOf(d.ieee).value;
    if (s) c[s.s] = (c[s.s] || 0) + 1;
  }
  return c;
});
