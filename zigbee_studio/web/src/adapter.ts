// The network adapter's answers, read through the add-on (op "adapter"), and its changes.

import { useEffect, useRef, useState } from "preact/hooks";
import { call, write } from "./conn";
import { adapter, nowS } from "./store";
import type { AdapterHistory } from "./types";

/** An adapter answer, fetched again every `everyS` seconds while shown and linked. */
export function useAdapter<T = any>(path: string | null, q: Record<string, string> = {}, everyS = 5) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const linked = !!adapter.value?.linked;
  const key = linked && path ? path + "?" + new URLSearchParams(q).toString() + "@" + adapter.value?.host : "";
  const seq = useRef(0);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!key) {
      setData(null);
      return;
    }
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const n = ++seq.current;
      try {
        const d = await call("adapter", { path, q }, 15000);
        if (alive && n === seq.current) {
          setData(d);
          setErr(null);
        }
      } catch (e: any) {
        if (alive && n === seq.current) setErr(e?.message || String(e));
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
  return { data, err, reload: () => setAgain((n) => n + 1) };
}

/** A change on the adapter (allowed host, reboot, reset statistics), with the usual toasts. */
export function adapterSet(action: "allow" | "reboot" | "stats_reset", args: Record<string, any> = {}, okText?: string) {
  return write("adapter_set", { action, args }, okText);
}

/** Wall-clock seconds for an adapter uptime stamp, given its current uptime. */
export function atUptime(nowUp: number, up: number): number {
  return nowS() - (nowUp - up);
}

export function lastN(h: AdapterHistory | null, col: keyof AdapterHistory, n: number): number {
  if (!h) return 0;
  const a = h[col];
  let s = 0;
  for (let i = Math.max(0, a.length - n); i < a.length; i++) s += a[i];
  return s;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const SL_STATUS: Record<number, string> = {
  0x0004: "busy", 0x0040: "no MAC ack", 0x004c: "channel busy", 0x0c02: "delivery failed", 0x0c03: "message limit",
  0x0c13: "source route failed", 0x0c14: "many-to-one route failed", 0x0c20: "no APS ack", 0x0c21: "APS cancelled",
  0x0c24: "route discovery", 0x0c25: "unicast failed", 0x0c26: "no route", 0x0c27: "sleepy child timeout",
};
export function slStatus(code: number): string {
  return SL_STATUS[code] || `0x${code.toString(16).padStart(4, "0")}`;
}
