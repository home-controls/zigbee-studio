// Reading Zigbee2MQTT exposes: what a device is, a one-line summary of its state, and how its
// settings group on the device page.

import { num, title } from "./format";
import type { Dev, Expose, State } from "./types";

export const ACCESS_STATE = 1;
export const ACCESS_SET = 2;
export const ACCESS_GET = 4;

export const SPECIFIC = new Set(["light", "switch", "cover", "lock", "climate", "fan"]);

export type Kind =
  | "coordinator"
  | "light"
  | "switch"
  | "outlet"
  | "cover"
  | "lock"
  | "climate"
  | "fan"
  | "keypad"
  | "contact"
  | "motion"
  | "climate_sensor"
  | "air"
  | "router"
  | "sensor";

export function canSet(e: Expose): boolean {
  return ((e.access ?? 0) & ACCESS_SET) !== 0;
}
export function canGet(e: Expose): boolean {
  return ((e.access ?? 0) & ACCESS_GET) !== 0;
}
export function published(e: Expose): boolean {
  return ((e.access ?? 0) & ACCESS_STATE) !== 0;
}

export function label(e: Expose): string {
  return e.label || title(e.name || e.property || e.type);
}

export function primaries(exposes: Expose[]): Expose[] {
  return exposes.filter((e) => SPECIFIC.has(e.type));
}

export function feature(e: Expose, name: string): Expose | undefined {
  return e.features?.find((f) => f.name === name);
}

function has(exposes: Expose[], name: string): boolean {
  return exposes.some((e) => e.name === name || e.property === name);
}

export function kindOf(dev: Dev, exposes: Expose[]): Kind {
  if (dev.type === "Coordinator") return "coordinator";
  const p = primaries(exposes);
  if (p.length) {
    const t = p[0].type;
    if (t === "switch") {
      const text = `${dev.desc} ${dev.model}`.toLowerCase();
      return /plug|outlet|socket|strip/.test(text) ? "outlet" : "switch";
    }
    return t as Kind;
  }
  if (has(exposes, "contact")) return "contact";
  if (has(exposes, "occupancy") || has(exposes, "presence")) return "motion";
  if (has(exposes, "pm25") || has(exposes, "voc") || has(exposes, "co2")) return "air";
  if (has(exposes, "temperature") || has(exposes, "humidity")) return "climate_sensor";
  if (has(exposes, "action")) return "keypad";
  if (dev.type === "Router") return "router";
  return "sensor";
}

/** Property of a feature inside a specific expose (e.g. "state_l1" for endpoint l1). */
export function prop(e: Expose | undefined): string | undefined {
  return e?.property || e?.name;
}

export function isOn(st: State, f: Expose | undefined): boolean | undefined {
  if (!f) return undefined;
  const v = st[prop(f)!];
  if (v === undefined || v === null) return undefined;
  return v === (f.value_on ?? "ON") || v === true;
}

export function pct(v: number | undefined, max = 254): string {
  return v === undefined || v === null ? "" : `${Math.round((v / max) * 100)}%`;
}

/** One short line saying what the device is doing. */
export function summary(kind: Kind, exposes: Expose[], st: State): string {
  const p = primaries(exposes);
  if (p.length) {
    const parts = p.map((e) => {
      const stf = feature(e, "state");
      const on = isOn(st, stf);
      let s = on === undefined ? "—" : on ? "On" : "Off";
      if (e.type === "light" && on) {
        const b = feature(e, "brightness");
        if (b && st[prop(b)!] !== undefined) s += ` · ${pct(st[prop(b)!], b.value_max ?? 254)}`;
      }
      if (e.type === "cover") {
        const pos = feature(e, "position");
        s = pos && st[prop(pos)!] !== undefined ? `${st[prop(pos)!]}% open` : String(st.state ?? "—");
      }
      if (e.type === "climate") {
        const t = feature(e, "local_temperature");
        s = t ? num(st[prop(t)!], "°C") : "—";
      }
      return p.length > 1 && e.endpoint ? `${e.endpoint} ${s}` : s;
    });
    return parts.join(" · ");
  }
  switch (kind) {
    case "contact":
      return st.contact === undefined ? "—" : st.contact ? "Closed" : "Open";
    case "motion":
      return st.occupancy === undefined && st.presence === undefined ? "—" : st.occupancy || st.presence ? "Motion" : "Clear";
    case "climate_sensor":
    case "air": {
      const bits = [];
      if (st.temperature !== undefined) bits.push(num(st.temperature, "°C"));
      if (st.humidity !== undefined) bits.push(`${Math.round(st.humidity)}%`);
      if (st.pm25 !== undefined) bits.push(`PM2.5 ${st.pm25}`);
      return bits.join(" · ") || "—";
    }
    case "keypad":
      return st.action ? `Last: ${String(st.action).replace(/_/g, " ")}` : "Keypad";
    case "router":
      return "Router";
    default:
      return "";
  }
}

export function battery(st: State): number | undefined {
  return typeof st.battery === "number" ? st.battery : undefined;
}

// ------------------------------------------------------------------ device page sections

export interface Sections {
  controls: Expose[]; // specific exposes + settable uncategorised generics
  readings: Expose[]; // published-only, uncategorised
  config: { title: string; items: Expose[] }[];
  diagnostic: Expose[];
}

const HIDDEN = new Set(["linkquality"]);

function groupKey(name: string): string {
  const parts = name.split("_");
  if (parts.length > 2 && /^\d+$/.test(parts[1])) return `${parts[0]}_${parts[1]}`;
  return parts[0];
}

function groupTitle(key: string): string {
  const m = key.match(/^([a-z]+)_(\d+)$/);
  if (m) return `${m[1].length <= 3 ? m[1].toUpperCase() : title(m[1])} ${m[2]}`;
  return key.length <= 3 ? key.toUpperCase() : title(key);
}

/** readOnly: leave out write-only actions (no state to show, nothing to do). */
export function sections(exposes: Expose[], readOnly = false): Sections {
  const controls: Expose[] = [];
  const readings: Expose[] = [];
  const diagnostic: Expose[] = [];
  const config: Expose[] = [];
  for (const e of exposes) {
    if (HIDDEN.has(e.name || "")) continue;
    if (readOnly && !SPECIFIC.has(e.type) && e.type !== "composite" && !published(e)) continue;
    if (SPECIFIC.has(e.type)) controls.push(e);
    else if (e.category === "diagnostic") diagnostic.push(e);
    else if (e.category === "config") config.push(e);
    else if (canSet(e)) controls.push(e);
    else readings.push(e);
  }
  // Settings: three or more sharing a prefix (led_1_*, multiclick_*) get their own heading
  const buckets = new Map<string, Expose[]>();
  for (const e of config) {
    const k = groupKey(e.name || e.property || "");
    buckets.set(k, [...(buckets.get(k) || []), e]);
  }
  const general: Expose[] = [];
  const grouped: { title: string; items: Expose[] }[] = [];
  for (const [k, items] of buckets) {
    if (items.length >= 3) grouped.push({ title: groupTitle(k), items });
    else general.push(...items);
  }
  const configGroups = general.length ? [{ title: "General", items: general }, ...grouped] : grouped;
  return { controls, readings, config: configGroups, diagnostic };
}

/** The light controls a group can offer, from what every member's light has: white only within
 *  the range they all reach, colour only if they all take colour. The group's own state uses the
 *  plain names (state, brightness, color_temp, color), whatever endpoint a member is on. */
export function groupLight(members: Expose[][]): Expose | null {
  const lights = members.map((xs) => primaries(xs).find((e) => e.type === "light"));
  if (!lights.length || lights.some((l) => !l)) return null;
  const all = lights as Expose[];
  const feats = (n: string) => all.map((l) => feature(l, n));
  const features: Expose[] = [{ type: "binary", name: "state", property: "state", access: 7, value_on: "ON", value_off: "OFF" } as Expose];
  if (feats("brightness").every(Boolean)) features.push({ type: "numeric", name: "brightness", property: "brightness", access: 7, value_min: 0, value_max: 254 } as Expose);
  const ct = feats("color_temp") as (Expose | undefined)[];
  if (ct.every(Boolean)) {
    const lo = Math.max(...ct.map((f) => f!.value_min ?? 153));
    const hi = Math.min(...ct.map((f) => f!.value_max ?? 500));
    if (lo < hi) {
      const presets = (ct[0]!.presets || []).filter((p) => typeof p.value === "number" && p.value >= lo && p.value <= hi);
      features.push({ type: "numeric", name: "color_temp", property: "color_temp", access: 7, value_min: lo, value_max: hi, unit: "mired", presets } as Expose);
    }
  }
  if (all.every((l) => feature(l, "color_hs") || feature(l, "color_xy"))) {
    const name = all.every((l) => feature(l, "color_hs")) ? "color_hs" : "color_xy";
    features.push({ type: "composite", name, property: "color", access: 7, features: [] } as Expose);
  }
  return { type: "light", label: "All lights", features } as Expose;
}
