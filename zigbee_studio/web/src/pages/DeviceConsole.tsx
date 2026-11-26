// The dev console: read or write a device's attributes, or send it a cluster command, on any
// endpoint. Zigbee2MQTT does these through the device's /set ("read", "write", "command") and
// logs the outcome without the device's name ("Read result of 'genBasic': {...}", "Wrote ...",
// "Invoked ...", or "Publish 'set' 'read' to '<device>' failed: ..."), so each request here waits
// for the first matching log line after it was sent.
//
// Zigbee2MQTT never sends the same log line twice in a row (bridge.ts compares each bridge/logging
// payload with the one before), so an answer identical to the last line before the request never
// arrives: once a fresh answer or failure would have come (Zigbee2MQTT gives up after 10 s), that
// last line counts as the answer.

import { useEffect, useState } from "preact/hooks";
import { logs, nowS } from "../store";
import { write } from "../conn";
import { Card, Empty, Seg } from "../ui";
import { Icon } from "../icons";
import { clock } from "../format";
import { clusterNames } from "./DeviceBind";
import type { Dev } from "../types";
import { type Entry, type Mode, WAIT_S, resolve } from "../consolematch";

let seq = 0;

function parseValue(raw: string): any {
  const t = raw.trim();
  if (t === "") return "";
  try { return JSON.parse(t); } catch { return t; }
}

function attrKey(a: string): string | number {
  const t = a.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

export function ConsoleTab({ dev, detail }: { dev: Dev; detail: any }) {
  const eps: Record<string, any> = detail?.endpoints || {};
  const epIds = Object.keys(eps);
  const [ep, setEp] = useState(epIds[0] || "1");
  const [names, setNames] = useState<any>(null);
  const [mode, setMode] = useState<Mode>("read");
  const inC: string[] = eps[ep]?.clusters?.input || [];
  const outC: string[] = eps[ep]?.clusters?.output || [];
  const [cluster, setCluster] = useState(inC[0] || "genBasic");
  const [attrs, setAttrs] = useState("");
  const [wAttr, setWAttr] = useState("");
  const [wVal, setWVal] = useState("");
  const [cmd, setCmd] = useState("");
  const [payload, setPayload] = useState("{}");
  const [mfr, setMfr] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [bad, setBad] = useState<string | null>(null);

  useEffect(() => { clusterNames(dev.ieee).then(setNames).catch(() => undefined); }, [dev.ieee]);
  useEffect(() => { if (!epIds.includes(ep) && epIds.length) setEp(epIds[0]); }, [epIds.join()]);

  // match waiting requests to Zigbee2MQTT's log lines: as lines come, and each second for the
  // answers that never come as a line (repeated, or none)
  const logList = logs.value;
  useEffect(() => {
    if (!entries.some((e) => e.status === "waiting")) return;
    setEntries((list) => resolve(list, logList, dev.name, nowS()));
  }, [logList, entries.length]);
  useEffect(() => {
    if (!entries.some((e) => e.status === "waiting")) return;
    const t = setInterval(() => setEntries((list) => resolve(list, logs.value, dev.name, nowS())), 1000);
    return () => clearInterval(t);
  }, [entries]);

  const cl = names?.clusters?.[cluster] || names?.custom?.[cluster];
  const others = Object.keys(names?.clusters || {}).filter((c) => !inC.includes(c) && !outC.includes(c)).sort();
  const custom = Object.keys(names?.custom || {});
  const options = () => {
    const t = mfr.trim();
    if (!t) return undefined;
    const n = /^0x/i.test(t) ? parseInt(t, 16) : Number(t);
    return Number.isFinite(n) ? { manufacturerCode: n } : undefined;
  };

  const send = async () => {
    setBad(null);
    let body: any, what: string, names: string[] | undefined;
    if (mode === "read") {
      const list = attrs.split(",").map((a) => a.trim()).filter(Boolean);
      if (!list.length) { setBad("Name at least one attribute (or its number, like 0x0005)"); return; }
      names = list.every((a) => typeof attrKey(a) === "string") ? list : undefined;
      body = { read: { cluster, attributes: list.map(attrKey), ...(options() ? { options: options() } : {}) } };
      what = list.join(", ");
    } else if (mode === "write") {
      if (!wAttr.trim()) { setBad("Name the attribute to write"); return; }
      body = { write: { cluster, payload: { [String(attrKey(wAttr))]: parseValue(wVal) }, ...(options() ? { options: options() } : {}) } };
      what = `${wAttr.trim()} = ${wVal.trim()}`;
    } else {
      if (!cmd.trim()) { setBad("Name the command"); return; }
      let p: any;
      try { p = payload.trim() ? JSON.parse(payload) : {}; } catch { setBad("The payload isn't valid JSON"); return; }
      body = { command: { cluster, command: cmd.trim(), payload: p } };
      what = cmd.trim();
    }
    const last = logs.value[logs.value.length - 1];
    const entry: Entry = { id: ++seq, at: nowS(), mode, cluster, what, ep, status: "waiting",
      prev: last ? { level: last.level, msg: last.msg } : undefined, attrs: names };
    setEntries((l) => [entry, ...l].slice(0, 40));
    try {
      await write("set", { key: dev.ieee, endpoint: ep, payload: body });
    } catch (e: any) {
      setEntries((l) => l.map((x) => (x.id === entry.id ? { ...x, status: "error", result: e?.message || String(e) } : x)));
    }
  };

  return (
    <div class="dev-grid">
      <div class="dev-col">
        <Card title="Dev console">
          <p class="muted small">Talks to the device directly: read or write attributes, or send a command on a cluster. Battery devices only answer when awake (press a button on them first).</p>
          <div class="form-grid">
            <label>Endpoint
              <select value={ep} onChange={(e) => setEp((e.target as HTMLSelectElement).value)}>
                {(epIds.length ? epIds : ["1"]).map((id) => <option value={id}>{id}</option>)}
              </select>
            </label>
            <label>Cluster
              <select value={cluster} onChange={(e) => setCluster((e.target as HTMLSelectElement).value)}>
                {inC.length > 0 && <optgroup label="On this endpoint (in)">{inC.map((c) => <option value={c}>{c}</option>)}</optgroup>}
                {outC.length > 0 && <optgroup label="On this endpoint (out)">{outC.map((c) => <option value={c}>{c}</option>)}</optgroup>}
                {custom.length > 0 && <optgroup label="This device's own">{custom.map((c) => <option value={c}>{c}</option>)}</optgroup>}
                {others.length > 0 && <optgroup label="Other clusters">{others.map((c) => <option value={c}>{c}</option>)}</optgroup>}
                {![...inC, ...outC, ...custom, ...others].includes(cluster) && <option value={cluster}>{cluster}</option>}
              </select>
            </label>
            <label>Manufacturer code <span class="muted">(optional)</span>
              <input type="text" value={mfr} placeholder="e.g. 0x115f" onInput={(e) => setMfr((e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <Seg label="What to do" value={mode} onChange={setMode}
            options={[{ v: "read", label: "Read" }, { v: "write", label: "Write" }, { v: "command", label: "Command" }]} />
          <datalist id="zs-console-attrs">{(cl?.attributes || []).map((a: string) => <option value={a} />)}</datalist>
          <datalist id="zs-console-cmds">{(cl?.commands || []).map((a: string) => <option value={a} />)}</datalist>
          <div class="form-grid one console-form">
            {mode === "read" && (
              <label>Attributes <span class="muted">(comma-separated names or numbers)</span>
                <input type="text" list="zs-console-attrs" value={attrs} placeholder={cl?.attributes?.slice(0, 2).join(", ") || "e.g. modelId, swBuildId"}
                  onInput={(e) => setAttrs((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && send()} />
              </label>
            )}
            {mode === "write" && (
              <>
                <label>Attribute
                  <input type="text" list="zs-console-attrs" value={wAttr} onInput={(e) => setWAttr((e.target as HTMLInputElement).value)} />
                </label>
                <label>Value <span class="muted">(a number, true/false, "text", or {"{"}"value": 1, "type": 32{"}"} for a raw attribute)</span>
                  <input type="text" value={wVal} onInput={(e) => setWVal((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && send()} />
                </label>
              </>
            )}
            {mode === "command" && (
              <>
                <label>Command
                  <input type="text" list="zs-console-cmds" value={cmd} onInput={(e) => setCmd((e.target as HTMLInputElement).value)} />
                </label>
                <label>Payload <span class="muted">(JSON)</span>
                  <textarea rows={3} class="set-area mono" value={payload} onInput={(e) => setPayload((e.target as HTMLTextAreaElement).value)} />
                </label>
              </>
            )}
          </div>
          {bad && <p class="warn-text small">{bad}</p>}
          <div class="toolbar">
            <button type="button" class="btn primary" onClick={send}><Icon name="play" size={14} /> {mode === "read" ? "Read" : mode === "write" ? "Write" : "Send"}</button>
            <span class="muted small">{dev.name} · endpoint {ep} · {cluster}</span>
          </div>
        </Card>
      </div>
      <div class="dev-col">
        <Card title="Answers" actions={entries.length > 0 && <button type="button" class="link-btn" onClick={() => setEntries([])}>Clear</button>}>
          {!entries.length ? <Empty>What the device answers shows here.</Empty> : (
            <ul class="console-log">
              {entries.map((e) => (
                <li class={`console-entry ${e.status}`}>
                  <div class="console-head">
                    <span class={`chip ${e.status === "ok" ? "ok" : e.status === "error" ? "bad" : e.status === "silent" ? "warn" : "muted"}`}>
                      {e.status === "waiting" ? "waiting" : e.status === "ok" ? "answered" : e.status === "error" ? "failed" : "no answer"}
                    </span>
                    <b>{e.mode}</b> <span class="mono">{e.cluster}</span> {e.what && <span class="mono">{e.what}</span>}
                    <span class="muted small">ep {e.ep} · {clock(e.at)}</span>
                  </div>
                  {e.result && <Result mode={e.mode} text={e.result} />}
                  {e.same && <div class="muted small">The same as Zigbee2MQTT's last log line: it doesn't send an identical line twice in a row, so this answer is taken from that one.</div>}
                  {e.status === "silent" && <div class="muted small">Nothing in Zigbee2MQTT's log within {WAIT_S} s: the device may be asleep, or the log level hides it.</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Result({ mode, text }: { mode: Mode; text: string }) {
  if (mode === "read") {
    const i = text.indexOf("': ");
    try {
      const obj = JSON.parse(text.slice(i + 3));
      const rows = Object.entries(obj);
      if (rows.length) {
        return (
          <table class="data console-result">
            <tbody>{rows.map(([k, v]) => <tr><td class="mono">{k}</td><td class="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>)}</tbody>
          </table>
        );
      }
    } catch { /* show the line */ }
  }
  return <pre class="console-line">{text}</pre>;
}
