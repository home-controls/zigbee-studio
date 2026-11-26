// Zigbee2MQTT's own settings, its tools (restart, backup, checks) and Touchlink.
// Settings: drawn from Zigbee2MQTT's settings schema; changes collect in a draft and go out
// together through bridge/request/options (only what changed; Zigbee2MQTT merges objects,
// replaces lists, and null puts a setting back to its default). Settings that would cut
// Zigbee2MQTT off from its adapter, the network, MQTT, Home Assistant or Studio are shown locked;
// the add-on refuses them too.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { bridge, control, devByKey } from "../store";
import { call, req, toast } from "../conn";
import { confirmIt } from "../dialog";
import { Card, Empty, Search, Toggle } from "../ui";
import { Icon } from "../icons";
import { href } from "../route";
import { title } from "../format";
import { getPath as get, setPath, withRemovals } from "../settingsdiff";
import { AdapterSettings } from "./Adapter";

type Settings = { config: any; schema: any; locked: Record<string, string>; restart_required: boolean };
const SKIP = new Set(["devices", "groups", "version"]);
const RO_NOTE = "Read-only: turn on Allow control in the add-on's configuration";

export async function restartZ2M(): Promise<void> {
  if (!await confirmIt({
    title: "Restart Zigbee2MQTT?", confirm: "Restart",
    body: <p>Devices keep working on their own, but nothing reaches Home Assistant or Zigbee Studio until Zigbee2MQTT is back, usually in 20–40 seconds.</p>,
  })) return;
  try {
    await req("restart", {}, "Zigbee2MQTT is restarting");
  } catch { /* toasted */ }
}

export function SettingsPage({ tab, section }: { tab?: string; section?: string }) {
  const t = tab === "tools" || tab === "touchlink" || tab === "adapter" ? tab : "zigbee2mqtt";
  const tabs = [{ id: "zigbee2mqtt", label: "Zigbee2MQTT" }, { id: "tools", label: "Tools" }, { id: "touchlink", label: "Touchlink" }, { id: "adapter", label: "Network adapter" }];
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p class="lede">Zigbee2MQTT's settings, its tools, Touchlink and the network adapter</p>
        </div>
      </div>
      <nav class="subtabs" aria-label="Settings sections">
        {tabs.map((x) => (
          <a href={href("settings", x.id)} class={t === x.id ? "active" : ""} aria-current={t === x.id ? "page" : undefined}>{x.label}</a>
        ))}
      </nav>
      {!control.value && <p class="note"><Icon name="lock" size={16} /> {RO_NOTE}: you can look, not change.</p>}
      {t === "zigbee2mqtt" && <Z2MSettings section={section} />}
      {t === "tools" && <Tools />}
      {t === "touchlink" && <Touchlink />}
      {t === "adapter" && <AdapterSettings />}
    </div>
  );
}

// ---------------------------------------------------------------------- settings


const typesOf = (p: any): string[] => (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []);
const isGroup = (p: any) => typesOf(p).includes("object") && p.properties && !p.additionalProperties && !p.oneOf;

type Kind = "enum" | "bool" | "number" | "string" | "multi" | "list" | "json";
function kindOf(p: any): Kind {
  const t = typesOf(p);
  if (p.enum) return "enum";
  if (p.oneOf || p.anyOf || p.additionalProperties || (t.includes("object"))) return "json";
  if (t.includes("array")) return p.items?.enum ? "multi" : (p.items && typeof p.items.type === "string" && ["string", "number", "integer"].includes(p.items.type)) ? "list" : "json";
  if (t.includes("boolean")) return "bool";
  if (t.includes("number") || t.includes("integer")) return "number";
  if (t.includes("string")) return "string";
  return "json";
}

interface Ctx {
  config: any;
  draft: Record<string, any>;
  set: (path: string, v: any) => void;
  undo: (path: string) => void;
  lockOf: (path: string) => string | undefined;
}

/** Every leaf setting under a schema node, with its path. */
function leaves(prop: any, path: string): [string, any][] {
  if (!isGroup(prop)) return [[path, prop]];
  return Object.entries(prop.properties).flatMap(([k, sub]) => leaves(sub, path ? `${path}.${k}` : k));
}

function Z2MSettings({ section }: { section?: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => call("settings").then((d: Settings) => { setS(d); setErr(null); }).catch((e) => setErr(e?.message || String(e)));
  const rr = bridge.value?.restart_required;
  useEffect(() => { load(); }, [rr]);
  if (!s) return err ? <p class="note warn"><Icon name="alert" size={16} /> {err}</p> : <Card><Empty>Loading Zigbee2MQTT's settings…</Empty></Card>;

  const sections = Object.entries(s.schema.properties || {}).filter(([k]) => !SKIP.has(k)) as [string, any][];
  if (!sections.length) return <Card><Empty>Zigbee2MQTT hasn't sent its settings yet.</Empty></Card>;
  const cur = sections.find(([k]) => k === section) || sections[0];
  const lockOf = (path: string) => {
    for (const [k, why] of Object.entries(s.locked)) if (path === k || path.startsWith(k + ".")) return why;
    return undefined;
  };
  const ctx: Ctx = {
    config: s.config, draft, lockOf,
    set: (path, v) => setDraft((d) => ({ ...d, [path]: v })),
    undo: (path) => setDraft((d) => { const n = { ...d }; delete n[path]; return n; }),
  };
  const changed = Object.keys(draft);
  const allLeaves = sections.flatMap(([k, p]) => leaves(p, k));
  const restartNeeded = changed.some((p) => allLeaves.find(([lp]) => lp === p)?.[1]?.requiresRestart);
  const ql = q.trim().toLowerCase();
  const hits = ql ? allLeaves.filter(([path, p]) => path.toLowerCase().includes(ql) || (p.title || "").toLowerCase().includes(ql) || (p.description || "").toLowerCase().includes(ql)) : [];
  const save = async () => {
    const options: any = {};
    for (const [path, v] of Object.entries(draft)) setPath(options, path.split("."), withRemovals(get(s.config, path.split(".")), v));
    setBusy(true);
    try {
      const d = await req("options", { options });
      setDraft({});
      toast("ok", d?.restart_required ? "Saved. Restart Zigbee2MQTT for some of it to take effect." : "Saved", 5000);
      await load();
    } catch { /* toasted */ } finally {
      setBusy(false);
    }
  };
  const countIn = (k: string) => changed.filter((p) => p === k || p.startsWith(k + ".")).length;

  return (
    <div class="settings-layout">
      <aside class="settings-nav">
        <Search value={q} onInput={setQ} placeholder="Find a setting" />
        <nav aria-label="Settings groups">
          {sections.map(([k, p]) => (
            <a href={href("settings", "zigbee2mqtt", k)} class={!ql && k === cur[0] ? "active" : ""} onClick={() => setQ("")}>
              {p.title || title(k)}{countIn(k) > 0 && <span class="badge">{countIn(k)}</span>}
            </a>
          ))}
        </nav>
      </aside>
      <div class="settings-main">
        {ql ? (
          <Card title={`${hits.length} setting${hits.length === 1 ? "" : "s"} match`}>
            {!hits.length ? <Empty>Nothing matches “{q}”.</Empty> : hits.map(([path, p]) => (
              <SettingRow path={path} prop={p} ctx={ctx} where={path.split(".").slice(0, -1).map((x) => title(x)).join(" › ")} />
            ))}
          </Card>
        ) : (
          <Card title={cur[1].title || title(cur[0])}>
            {cur[1].description && <p class="muted small">{cur[1].description}</p>}
            {isGroup(cur[1]) ? <Fields path={cur[0]} prop={cur[1]} ctx={ctx} /> : <SettingRow path={cur[0]} prop={cur[1]} ctx={ctx} />}
          </Card>
        )}
        {changed.length > 0 && (
          <div class="save-bar" role="region" aria-label="Unsaved changes">
            <span><b>{changed.length}</b> change{changed.length === 1 ? "" : "s"}{restartNeeded ? " · needs a restart to take effect" : ""}</span>
            <span class="spacer" />
            <button type="button" class="btn small" disabled={busy} onClick={() => setDraft({})}>Discard</button>
            <button type="button" class="btn small primary" disabled={busy || !control.value} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Fields({ path, prop, ctx }: { path: string; prop: any; ctx: Ctx }) {
  return (
    <>
      {Object.entries(prop.properties).map(([k, sub]: [string, any]) => isGroup(sub) ? (
        <fieldset class="set-group">
          <legend>{sub.title || title(k)}</legend>
          {sub.description && <p class="muted small">{sub.description}</p>}
          <Fields path={`${path}.${k}`} prop={sub} ctx={ctx} />
        </fieldset>
      ) : <SettingRow path={`${path}.${k}`} prop={sub} ctx={ctx} />)}
    </>
  );
}

function show(v: any): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function SettingRow({ path, prop, ctx, where }: { path: string; prop: any; ctx: Ctx; where?: string }) {
  const parts = path.split(".");
  const current = get(ctx.config, parts);
  const has = path in ctx.draft;
  const value = has ? ctx.draft[path] : current;
  const lock = ctx.lockOf(path);
  const ro = !control.value || !!lock || prop.readOnly;
  const kind = kindOf(prop);
  const dflt = prop.default;
  const set = (v: any) => {
    const same = JSON.stringify(v ?? null) === JSON.stringify(current ?? null);
    if (same) ctx.undo(path);
    else ctx.set(path, v);
  };
  let input: ComponentChildren;
  if (ro) input = <span class={lock ? "locked-val" : ""}>{show(value ?? dflt)}{value === undefined && dflt !== undefined ? <span class="muted"> (default)</span> : null}</span>;
  else if (kind === "enum") {
    input = (
      <select class="select" value={value == null ? "" : String(value)} onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        set(raw === "" ? null : prop.enum.find((x: any) => String(x) === raw));
      }}>
        {(value == null || dflt !== undefined) && <option value="">{dflt !== undefined ? `Default (${show(dflt)})` : "Not set"}</option>}
        {prop.enum.map((x: any) => <option value={String(x)}>{String(x)}</option>)}
      </select>
    );
  } else if (kind === "bool") {
    input = <span class="set-bool"><Toggle on={(value ?? dflt) === true} label={prop.title || title(parts[parts.length - 1])} onChange={(v) => set(v)} />
      {value == null && <span class="muted small">{dflt === undefined ? "not set" : "default"}</span>}</span>;
  } else if (kind === "number" || kind === "string") {
    input = <TextCommit value={value == null ? "" : String(value)} type={kind === "number" ? "number" : "text"}
      placeholder={dflt !== undefined && dflt !== null ? `default ${show(dflt)}` : "not set"}
      onCommit={(raw) => set(raw === "" ? null : kind === "number" ? Number(raw) : raw)} />;
  } else if (kind === "multi") {
    const arr: any[] = Array.isArray(value) ? value : Array.isArray(dflt) ? dflt : [];
    input = (
      <span class="checks">
        {prop.items.enum.map((x: any) => (
          <label class="check-chip"><input type="checkbox" checked={arr.includes(x)}
            onChange={(e) => set((e.target as HTMLInputElement).checked ? [...arr, x] : arr.filter((y) => y !== x))} /> {String(x)}</label>
        ))}
      </span>
    );
  } else if (kind === "list") {
    const num = ["number", "integer"].includes(prop.items?.type);
    input = <TextCommit area value={Array.isArray(value) ? value.join("\n") : ""} placeholder="one per line"
      onCommit={(raw) => {
        const items = raw.split("\n").map((x) => x.trim()).filter(Boolean);
        set(items.length ? (num ? items.map(Number) : items) : null);
      }} />;
  } else {
    input = <JsonCommit value={value} onCommit={set} />;
  }
  return (
    <div class={`set-row ${has ? "changed" : ""}`}>
      <div class="set-label">
        {where && <span class="muted small">{where} › </span>}
        <span class="set-name">{prop.title || title(parts[parts.length - 1])}</span>
        {prop.requiresRestart && <span class="ep" title="Takes effect when Zigbee2MQTT restarts">restart</span>}
        {lock && <span class="ep lock" title={lock}><Icon name="lock" size={11} /> locked</span>}
        {has && <span class="ep changed">changed</span>}
      </div>
      {(prop.description || lock) && <div class="set-desc">{lock ? `Not changed from Zigbee Studio: ${lock}. ` : ""}{prop.description}</div>}
      <div class="set-control">
        {input}
        {has && <button type="button" class="link-btn" onClick={() => ctx.undo(path)}>Undo</button>}
        {!has && !ro && current !== undefined && dflt !== undefined && JSON.stringify(current) !== JSON.stringify(dflt) &&
          <button type="button" class="link-btn" onClick={() => ctx.set(path, null)}>Use default</button>}
      </div>
    </div>
  );
}

function TextCommit({ value, onCommit, type = "text", placeholder, area }: { value: string; onCommit: (raw: string) => void; type?: string; placeholder?: string; area?: boolean }) {
  const [d, setD] = useState<string | null>(null);
  const commit = () => {
    if (d !== null && d !== value) onCommit(d);
    setD(null);
  };
  const props = {
    value: d ?? value, placeholder, class: area ? "set-area" : "set-input",
    onInput: (e: Event) => setD((e.target as HTMLInputElement).value),
    onBlur: commit,
  };
  return area ? <textarea rows={3} {...props} /> : <input type={type} {...props} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function JsonCommit({ value, onCommit }: { value: any; onCommit: (v: any) => void }) {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [d, setD] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (d === null || d === text) { setD(null); return; }
    if (d.trim() === "") { onCommit(null); setD(null); setBad(false); return; }
    try {
      onCommit(JSON.parse(d));
      setD(null);
      setBad(false);
    } catch {
      setBad(true);
    }
  };
  return (
    <span class="json-edit">
      <textarea rows={Math.min(8, Math.max(2, (d ?? text).split("\n").length))} class={`set-area mono ${bad ? "bad" : ""}`} value={d ?? text}
        placeholder="JSON" onInput={(e) => setD((e.target as HTMLTextAreaElement).value)} onBlur={commit} />
      {bad && <span class="warn-text small">Not valid JSON</span>}
    </span>
  );
}

// ---------------------------------------------------------------------- tools

function download(base64: string, name: string): number {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return bytes.length;
}

const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Tools() {
  const [busy, setBusy] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [health, setHealth] = useState<boolean | null>(null);
  const [missing, setMissing] = useState<{ ieee_address: string; friendly_name: string }[] | null>(null);
  const ro = !control.value;
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch { /* toasted */ } finally { setBusy(null); }
  };
  const b = bridge.value;
  return (
    <div class="masonry">
      <Card title="Restart">
        <p class="muted small">Restarts Zigbee2MQTT (needed after some setting changes). Devices keep working on their own meanwhile; nothing reaches Home Assistant for the 20–40 seconds it takes.</p>
        {b?.restart_required && <p class="note warn"><Icon name="refresh" size={16} /> Saved settings are waiting for a restart.</p>}
        <button type="button" class="btn" disabled={ro} title={ro ? RO_NOTE : undefined} onClick={restartZ2M}><Icon name="power" size={16} /> Restart Zigbee2MQTT</button>
      </Card>
      <Card title="Backup">
        <p class="muted small">Downloads Zigbee2MQTT's data folder as a zip: its configuration (with the network key and MQTT password), the device database, the coordinator's backup and the saved states (not logs or firmware files). Keep it private.</p>
        <button type="button" class="btn" disabled={ro || busy === "backup"} title={ro ? RO_NOTE : undefined}
          onClick={() => run("backup", async () => {
            const d = await req("backup", {}, undefined, 120);
            const d0 = new Date(), two = (n: number) => String(n).padStart(2, "0");
            const stamp = `${d0.getFullYear()}-${two(d0.getMonth() + 1)}-${two(d0.getDate())}-${two(d0.getHours())}${two(d0.getMinutes())}`;
            const n = download(d.zip, `zigbee2mqtt-backup-${stamp}.zip`);
            setBackup(`${kb(n)}, ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
          })}><Icon name="download" size={16} /> {busy === "backup" ? "Making the backup…" : "Download backup"}</button>
        {backup && <p class="muted small">Downloaded: {backup}</p>}
      </Card>
      <Card title="Health check">
        <p class="muted small">Asks Zigbee2MQTT whether it is healthy (it answers when it is running and connected).</p>
        <button type="button" class="btn" disabled={ro || busy === "health"} title={ro ? RO_NOTE : undefined}
          onClick={() => run("health", async () => { const d = await req("health_check", {}); setHealth(!!d?.healthy); })}>
          {busy === "health" ? "Checking…" : "Check"}</button>
        {health !== null && <p class={health ? "ok-text" : "warn-text"}><Icon name={health ? "check" : "alert"} size={16} /> {health ? "Healthy" : "Not healthy"}</p>}
      </Card>
      <Card title="Coordinator check">
        <p class="muted small">Asks the coordinator which routers it has lost track of (routers Zigbee2MQTT knows that aren't in the coordinator's tables).</p>
        <button type="button" class="btn" disabled={ro || busy === "coord"} title={ro ? RO_NOTE : undefined}
          onClick={() => run("coord", async () => { const d = await req("coordinator_check", {}, undefined, 60); setMissing(d?.missing_routers || []); })}>
          {busy === "coord" ? "Checking…" : "Check"}</button>
        {missing && (!missing.length ? <p class="ok-text"><Icon name="check" size={16} /> No router is missing.</p> : (
          <>
          <p class="warn-text"><Icon name="alert" size={16} /> {missing.length} router{missing.length === 1 ? "" : "s"} missing</p>
          <ul class="plain">{missing.map((m) => {
            const dev = devByKey.value.get(m.ieee_address);
            return <li>{dev ? <a href={href("device", dev.ieee)}>{m.friendly_name}</a> : m.friendly_name} <span class="muted mono">{m.ieee_address}</span></li>;
          })}</ul>
          </>
        ))}
      </Card>
      <Card title="Install codes">
        <p class="muted small">Devices that need an install code to join are added on the pairing page.</p>
        <a class="btn" href={href("pairing")}><Icon name="plus" size={16} /> Add devices</a>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------- Touchlink

type Found = { ieee_address: string; channel: number };

function Touchlink() {
  const [found, setFound] = useState<Found[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const ro = !control.value;
  useEffect(() => {
    if (!scanning) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [scanning]);
  const scan = async () => {
    if (!await confirmIt({
      title: "Scan for Touchlink devices?", confirm: "Scan",
      body: <p>The coordinator goes through every Zigbee channel looking for lights within a metre or two of it. While it scans (about a minute) it is off your network's channel, so devices can't reach it.</p>,
    })) return;
    setScanning(true);
    setElapsed(0);
    try {
      const d = await req("touchlink/scan", {}, undefined, 300);
      setFound(d?.found || []);
    } catch { /* toasted */ } finally {
      setScanning(false);
    }
  };
  const nameOf = (ieee: string) => devByKey.value.get(ieee)?.name;
  const reset = async (f: Found | null) => {
    const who = f ? nameOf(f.ieee_address) || f.ieee_address : "the nearest Touchlink device";
    if (!await confirmIt({
      title: `Factory reset ${who}?`, confirm: "Factory reset", danger: true,
      body: <p>It leaves whatever network it is on and forgets its settings. {f && nameOf(f.ieee_address) ? "It is one of your devices: it will have to be paired again." : "Pair it afterwards with Add devices."}</p>,
    })) return;
    setBusy(f ? f.ieee_address + "r" : "nearest");
    try {
      await req("touchlink/factory_reset", f ? { ieee_address: f.ieee_address, channel: f.channel } : {}, `Reset ${who}`, 120);
      if (f) setFound((x) => (x || []).filter((y) => y.ieee_address !== f.ieee_address));
    } catch { /* toasted */ } finally {
      setBusy(null);
    }
  };
  return (
    <div class="page-sub">
      <Card title="Touchlink">
        <p class="muted small">
          Touchlink (Zigbee Light Link) reaches lights very close to the coordinator, on any channel, even ones on another network or none.
          Use it to make a bulb blink or to factory-reset one that won't pair. Bring it within a metre or two of the coordinator.
        </p>
        <div class="toolbar">
          <button type="button" class="btn primary" disabled={ro || scanning} title={ro ? RO_NOTE : undefined} onClick={scan}>
            <Icon name="search" size={16} /> {scanning ? `Scanning… ${elapsed} s` : "Scan"}</button>
          <button type="button" class="btn" disabled={ro || scanning || busy === "nearest"} title={ro ? RO_NOTE : undefined} onClick={() => reset(null)}>
            Factory reset the nearest</button>
        </div>
      </Card>
      {found && (
        <Card title={`${found.length} found`}>
          {!found.length ? <Empty>No Touchlink device answered. Bring it closer to the coordinator, power it on, and scan again.</Empty> : (
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>Device</th><th>IEEE address</th><th class="num">Channel</th><th /></tr></thead>
                <tbody>
                  {found.map((f) => {
                    const dev = devByKey.value.get(f.ieee_address);
                    return (
                      <tr>
                        <td>{dev ? <a href={href("device", dev.ieee)}>{dev.name}</a> : <span class="muted">Not in this network</span>}</td>
                        <td class="mono">{f.ieee_address}</td>
                        <td class="num">{f.channel}</td>
                        <td class="row-actions">
                          <button type="button" class="btn small" disabled={ro || !!busy} onClick={async () => {
                            setBusy(f.ieee_address + "i");
                            try { await req("touchlink/identify", f, `${dev?.name || f.ieee_address} should blink`, 60); } catch { /* toasted */ } finally { setBusy(null); }
                          }}>Identify</button>
                          <button type="button" class="btn small danger" disabled={ro || !!busy} onClick={() => reset(f)}>Factory reset</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
