// The one WebSocket to the backend: hello (with the exposes this browser already has), then a
// snapshot and changes. Requests are {op, id}; replies come back as {t: "r", id}.

import { apply, conn, knownExposes, control } from "./store";
import { toast as kitToast, type ToastKind } from "./kit/toast";

let ws: WebSocket | null = null;
let nextId = 1;
let backoff = 500;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();

export type { Toast } from "./kit/toast";

/** A toast (the kit's), with Studio's argument order: kind first. */
export function toast(kind: ToastKind, text: string, ms = 5000): void {
  kitToast(text, kind, ms);
}

export class ReadOnlyError extends Error {}

function reply(m: any): void {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  clearTimeout(p.timer);
  if (m.ok) p.resolve(m.d);
  else p.reject(m.ro ? new ReadOnlyError(m.e) : new Error(m.e));
}

export function connect(): void {
  const url = new URL("ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  conn.value = "connecting";
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    backoff = 500;
    sock.send(JSON.stringify({ op: "hello", have: knownExposes() }));
  };
  sock.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === "snap") conn.value = "open";
    // a batch can hold replies too: take them out, apply the rest in one go
    const all: any[] = msg.t === "b" ? msg.m : [msg];
    const rest: any[] = [];
    for (const m of all) {
      if (m.t === "r") reply(m);
      else {
        if (m.t === "l" && m.e.level === "error") toast("error", m.e.msg, 8000);
        rest.push(m);
      }
    }
    if (rest.length === 1) apply(rest[0]);
    else if (rest.length > 1) apply({ t: "b", m: rest });
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    conn.value = "closed";
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection lost"));
      pending.delete(id);
    }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}

export function call(op: string, args: Record<string, any> = {}, timeoutMs = 35000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
    const id = nextId++;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("No answer in time"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...args, op, id })); // op and id last: an argument never replaces them
  });
}

/** A write (set / get / bridge request) with the usual error toasts. */
export async function write(op: "set" | "get" | "req" | "map" | "adapter_set", args: Record<string, any>, okText?: string): Promise<any> {
  if (!control.value) {
    toast("warn", "Read-only: turn on Allow control in the add-on's configuration.");
    throw new ReadOnlyError("read-only");
  }
  try {
    const d = await call(op, args);
    if (okText) toast("ok", okText, 3000);
    return d;
  } catch (e: any) {
    toast(e instanceof ReadOnlyError ? "warn" : "error", e.message || String(e));
    throw e;
  }
}

/** A Zigbee2MQTT bridge request (e.g. "device/bind"); resolves with its data, throws (after a
 * toast) on refusal. `timeoutS` for the slow ones: an OTA update answers when it is done. */
export async function req(topic: string, payload: Record<string, any>, okText?: string, timeoutS = 30): Promise<any> {
  if (!control.value) {
    toast("warn", "Read-only: turn on Allow control in the add-on's configuration.");
    throw new ReadOnlyError("read-only");
  }
  try {
    const d = await call("req", { topic, payload, timeout: timeoutS }, (timeoutS + 5) * 1000);
    if (okText) toast("ok", okText, 3500);
    return d;
  } catch (e: any) {
    toast(e instanceof ReadOnlyError ? "warn" : "error", e.message || String(e), 8000);
    throw e;
  }
}

export function setState(key: string, payload: Record<string, any>, endpoint?: string): Promise<any> {
  return write("set", endpoint ? { key, payload, endpoint } : { key, payload }).catch(() => undefined);
}
