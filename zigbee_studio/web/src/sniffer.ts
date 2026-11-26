// The Zigbee Sniffer's answers, read through the add-on (op "sniffer"): devices are addressed
// by their network address there, so this maps between it and Zigbee2MQTT's IEEE.

import { computed } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { call } from "./conn";
import { devices } from "./store";
import type { Dev } from "./types";

export type Range = "1h" | "6h" | "24h" | "7d";
export const RANGES: { v: Range; label: string }[] = [
  { v: "1h", label: "1 h" }, { v: "6h", label: "6 h" }, { v: "24h", label: "24 h" }, { v: "7d", label: "7 days" },
];

// Categorical slots for sniffers (validated: both modes, HA's card surfaces) and the stacks
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

export function nwkHex(dev: Dev | undefined): string | null {
  return dev?.nwk === undefined || dev?.nwk === null ? null : "0x" + dev.nwk.toString(16).padStart(4, "0");
}

export const devByNwk = computed(() => {
  const m = new Map<string, Dev>();
  for (const d of devices.value) {
    const n = nwkHex(d);
    if (n) m.set(n, d);
  }
  return m;
});

export const SEV_TONE: Record<string, "bad" | "warn" | "info" | "muted"> = { high: "bad", warn: "warn", info: "info" };

/** A Sniffer answer, fetched again every `everyS` seconds while shown (the previous answer
 * stays on screen while the next one loads). */
export function useSniffer<T = any>(path: string | null, q: Record<string, string> = {}, everyS = 60) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = path ? path + "?" + new URLSearchParams(q).toString() : "";
  const seq = useRef(0);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const n = ++seq.current;
      setLoading(true);
      try {
        const d = await call("sniffer", { path, q }, 60000);
        if (alive && n === seq.current) {
          setData(d);
          setErr(null);
        }
      } catch (e: any) {
        if (alive && n === seq.current) setErr(e?.message || String(e));
      } finally {
        if (alive && n === seq.current) setLoading(false);
      }
    };
    load();
    const t = everyS > 0 ? window.setInterval(load, everyS * 1000) : undefined;
    const vis = () => !document.hidden && load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [key, again]);
  return { data, err, loading, reload: () => setAgain((n) => n + 1) };
}
