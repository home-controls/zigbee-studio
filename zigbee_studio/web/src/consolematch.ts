// Matching the dev console's requests to Zigbee2MQTT's log lines (see pages/DeviceConsole.tsx).
// zigbee-herdsman-converters logs a read / write / command's outcome without the device's name, and
// Zigbee2MQTT never sends the same log line twice in a row: an answer identical to the last line
// before the request never arrives, so once a fresh answer or failure would have come (Zigbee2MQTT
// gives up after 10 s), that last line counts as the answer if it fits.

import type { LogEntry } from "./types";

export type Mode = "read" | "write" | "command";
export interface Line { level: string; msg: string }
export interface Entry {
  id: number; at: number; mode: Mode; cluster: string; what: string; ep: string;
  status: "waiting" | "ok" | "error" | "silent"; result?: string;
  prev?: Line; // Zigbee2MQTT's last log line before the request
  attrs?: string[]; // a read's attribute names (unset when some were numbers)
  same?: boolean; // the answer is that last line (Zigbee2MQTT didn't repeat it)
}

export const WAIT_S = 25;
export const SAME_S = 15;

export function answers(e: Entry, l: Line, devName: string): boolean {
  if (l.level === "error") return l.msg.includes(`to '${devName}' failed`);
  if (e.mode === "read") return l.msg.startsWith(`Read result of '${e.cluster}'`);
  if (e.mode === "write") return l.msg.startsWith("Wrote '") && l.msg.endsWith(`to '${e.cluster}'`);
  return l.msg.startsWith(`Invoked '${e.cluster}.${e.what}'`);
}

// an earlier read's line only stands in when it holds exactly the attributes asked for
export function sameAttrs(e: Entry, l: Line): boolean {
  if (e.mode !== "read" || l.level === "error" || !e.attrs) return true;
  try {
    const keys = Object.keys(JSON.parse(l.msg.slice(l.msg.indexOf("': ") + 3)));
    return keys.length === e.attrs.length && e.attrs.every((a) => keys.includes(a));
  } catch { return false; }
}

export function resolve(list: Entry[], logList: LogEntry[], devName: string, now: number): Entry[] {
  let changed = false;
  const out = list.map((e): Entry => {
    if (e.status !== "waiting") return e;
    const line = logList.find((l) => l.ts >= e.at - 1 && answers(e, l, devName));
    let next: Entry | null = null;
    if (line) next = { ...e, status: line.level === "error" ? "error" : "ok", result: line.msg };
    else if (e.prev && now - e.at > SAME_S && answers(e, e.prev, devName) && sameAttrs(e, e.prev)) {
      next = { ...e, status: e.prev.level === "error" ? "error" : "ok", result: e.prev.msg, same: true };
    } else if (now - e.at > WAIT_S) next = { ...e, status: "silent" };
    if (!next) return e;
    changed = true;
    return next;
  });
  return changed ? out : list;
}
