// Bind and Reporting tabs. Bindings let a device talk to another device or a group directly
// (a remote switching a light without Zigbee2MQTT); reporting sets how often an attribute is
// reported. Both read the device's endpoints (refetched when Zigbee2MQTT republishes devices).

import { useEffect, useState } from "preact/hooks";
import { call, req, toast } from "../conn";
import { confirmIt } from "../dialog";
import { control, devByKey, devices, groups } from "../store";
import { Icon } from "../icons";
import { Card, Empty } from "../ui";
import type { Dev } from "../types";

/** Zigbee2MQTT answers a bind that worked for some clusters as a success, with the rest in
 *  `failed` (a sleeping device, or one that doesn't take that cluster): say which. */
function bindOutcome(verb: "Bound" | "Unbound", d: any, asked: string[]): void {
  const failed: string[] = Array.isArray(d?.failed) ? d.failed : [];
  const done: string[] = Array.isArray(d?.clusters) ? d.clusters : asked.filter((c) => !failed.includes(c));
  const wake = "A battery device has to be awake: press one of its buttons, then try again.";
  if (!failed.length) toast("ok", `${verb} ${done.join(", ") || asked.join(", ")}`, 3500);
  else if (!done.length) toast("error", `Nothing ${verb.toLowerCase()}: ${failed.join(", ")} failed. ${wake}`, 10000);
  else toast("warn", `${verb} ${done.join(", ")}, but ${failed.join(", ")} failed. ${wake}`, 10000);
}

// Clusters a binding makes sense for (Windfront offers the same set)
const BINDABLE = ["genScenes", "genOnOff", "genLevelCtrl", "lightingColorCtrl", "closuresWindowCovering", "hvacThermostat",
  "msIlluminanceMeasurement", "msTemperatureMeasurement", "msRelativeHumidity", "msSoilMoisture", "msCO2", "genPowerCfg",
  "haElectricalMeasurement", "seMetering", "manuSpecificPhilips", "manuSpecificLegrandDevices3"];

type Endpoints = Record<string, { bindings?: any[]; configured_reportings?: any[]; clusters?: { input?: string[]; output?: string[] }; scenes?: any[] }>;

function targetName(t: any): string {
  if (!t) return "?";
  if (t.type === "group") return groups.value.find((g) => g.id === t.id)?.name || `Group ${t.id}`;
  const d = devByKey.value.get(t.ieee_address);
  return `${d?.name || t.ieee_address}${t.endpoint !== undefined ? ` / ${t.endpoint}` : ""}`;
}

// ------------------------------------------------------------------ Bind

export function BindTab({ dev, detail }: { dev: Dev; detail: any }) {
  const eps: Endpoints = detail?.endpoints || {};
  const rows = Object.entries(eps).flatMap(([ep, e]) => (e.bindings || []).map((b) => ({ ep, ...b })));
  // group rows by endpoint + target so one Unbind removes all its clusters
  const byTarget = new Map<string, { ep: string; target: any; clusters: string[] }>();
  for (const r of rows) {
    const k = `${r.ep}|${JSON.stringify(r.target)}`;
    const cur = byTarget.get(k) || { ep: r.ep, target: r.target, clusters: [] as string[] };
    cur.clusters.push(r.cluster);
    byTarget.set(k, cur);
  }
  const unbind = async (b: { ep: string; target: any; clusters: string[] }) => {
    if (!(await confirmIt({ title: `Unbind ${targetName(b.target)}?`, body: <>Clusters: {b.clusters.join(", ")}</>, confirm: "Unbind", danger: true }))) return;
    const to = b.target.type === "group" ? b.target.id : b.target.ieee_address;
    const d = await req("device/unbind", { from: dev.ieee, from_endpoint: Number(b.ep), to, to_endpoint: b.target.endpoint, clusters: b.clusters }).catch(() => undefined);
    if (d !== undefined) bindOutcome("Unbound", d, b.clusters);
  };
  return (
    <div class="dev-col">
      <Card title={<>Bindings <span class="muted">{byTarget.size}</span></>}>
        {!detail ? <Empty>Loading…</Empty> : byTarget.size === 0 ? <Empty>No bindings. This device only talks to the coordinator.</Empty> : (
          <ul class="plain list-rows">
            {[...byTarget.values()].map((b) => (
              <li>
                <span class="ep">ep {b.ep}</span>
                <Icon name="chevron" size={14} />
                <b>{targetName(b.target)}</b>
                <span class="muted small">{b.clusters.join(", ")}</span>
                {control.value && <button type="button" class="link-btn small push-right" onClick={() => unbind(b)}>Unbind</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {control.value && detail && <AddBinding dev={dev} eps={eps} />}
    </div>
  );
}

function AddBinding({ dev, eps }: { dev: Dev; eps: Endpoints }) {
  const sources = Object.entries(eps).filter(([, e]) => (e.clusters?.output || []).length);
  const [src, setSrc] = useState(sources[0]?.[0] || Object.keys(eps)[0] || "1");
  const [target, setTarget] = useState("");
  const [targetEp, setTargetEp] = useState("");
  const [targetEps, setTargetEps] = useState<Endpoints | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const isGroup = target.startsWith("g:");
  useEffect(() => {
    setTargetEps(null);
    setTargetEp("");
    if (!target || isGroup) return;
    call("device", { key: target }).then((d) => {
      setTargetEps(d.endpoints || {});
      setTargetEp(Object.keys(d.endpoints || {})[0] || "");
    }, () => setTargetEps({}));
  }, [target]);
  const out = eps[src]?.clusters?.output || [];
  const into = isGroup ? null : targetEps?.[targetEp]?.clusters?.input || [];
  const offer = out.filter((c) => BINDABLE.includes(c) && (into === null || into.includes(c)));
  useEffect(() => setPicked(offer.filter((c) => ["genOnOff", "genLevelCtrl", "lightingColorCtrl"].includes(c))), [src, target, targetEp, targetEps]);
  const bind = async () => {
    if (!target || !picked.length) return;
    setBusy(true);
    const to = isGroup ? Number(target.slice(2)) : target;
    const d = await req("device/bind", { from: dev.ieee, from_endpoint: Number(src), to, ...(isGroup ? {} : { to_endpoint: Number(targetEp) }), clusters: picked }).catch(() => undefined);
    if (d !== undefined) bindOutcome("Bound", d, picked);
    setBusy(false);
  };
  return (
    <Card title="Add a binding">
      <div class="form-grid">
        <label>From endpoint
          <select value={src} onChange={(e) => setSrc((e.target as HTMLSelectElement).value)}>
            {Object.keys(eps).map((ep) => <option value={ep}>{ep}{(eps[ep].clusters?.output || []).length ? "" : " (no output clusters)"}</option>)}
          </select>
        </label>
        <label>To
          <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}>
            <option value="">Choose a device or group</option>
            <optgroup label="Groups">{groups.value.map((g) => <option value={`g:${g.id}`}>{g.name}</option>)}</optgroup>
            <optgroup label="Devices">
              {devices.value.filter((d) => d.ieee !== dev.ieee).map((d) => <option value={d.ieee}>{d.type === "Coordinator" ? "Coordinator" : d.name}</option>)}
            </optgroup>
          </select>
        </label>
        {!isGroup && target && (
          <label>Endpoint
            <select value={targetEp} onChange={(e) => setTargetEp((e.target as HTMLSelectElement).value)}>
              {Object.keys(targetEps || {}).map((ep) => <option value={ep}>{ep}</option>)}
            </select>
          </label>
        )}
      </div>
      {target && (
        <>
          <h4>Clusters</h4>
          {offer.length === 0 ? <p class="muted small">No cluster this endpoint sends is one the target takes.</p> : (
            <div class="checks">
              {offer.map((c) => (
                <label class="check-pill">
                  <input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked((e.target as HTMLInputElement).checked ? [...picked, c] : picked.filter((x) => x !== c))} />
                  {c}
                </label>
              ))}
            </div>
          )}
          <div class="row-btns"><button type="button" class="btn primary" disabled={busy || !picked.length} onClick={bind}>{busy ? "Binding…" : "Bind"}</button></div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Reporting

const clusterCache: Record<string, any> = {};
export async function clusterNames(ieee: string): Promise<any> {
  if (!clusterCache[ieee]) clusterCache[ieee] = await call("clusters", { key: ieee });
  return clusterCache[ieee];
}

export function ReportingTab({ dev, detail }: { dev: Dev; detail: any }) {
  const eps: Endpoints = detail?.endpoints || {};
  const rows = Object.entries(eps).flatMap(([ep, e]) => (e.configured_reportings || []).map((r) => ({ ep, ...r })));
  return (
    <div class="dev-col">
      <Card title={<>Reporting <span class="muted">{rows.length}</span></>}>
        <p class="muted small">How often the device reports an attribute by itself: at most every <i>min</i> seconds, at least every
          <i> max</i> seconds, and whenever it changes by <i>change</i>.</p>
        {!detail ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>Nothing configured.</Empty> : (
          <div class="table-wrap">
            <table class="devices compact">
              <thead><tr><th>Endpoint</th><th>Cluster</th><th>Attribute</th><th>Min s</th><th>Max s</th><th>Change</th>{control.value && <th />}</tr></thead>
              <tbody>{rows.map((r) => <ReportRow dev={dev} r={r} key={`${r.ep}${r.cluster}${r.attribute}`} />)}</tbody>
            </table>
          </div>
        )}
      </Card>
      {control.value && detail && <AddReporting dev={dev} eps={eps} />}
    </div>
  );
}

function ReportRow({ dev, r }: { dev: Dev; r: any }) {
  const [min, setMin] = useState(String(r.minimum_report_interval));
  const [max, setMax] = useState(String(r.maximum_report_interval));
  const [change, setChange] = useState(String(r.reportable_change ?? ""));
  const dirty = min !== String(r.minimum_report_interval) || max !== String(r.maximum_report_interval) || change !== String(r.reportable_change ?? "");
  const send = (maxOverride?: number) => req("device/configure_reporting", {
    id: dev.ieee, endpoint: Number(r.ep), cluster: r.cluster, attribute: r.attribute,
    minimum_report_interval: Number(min), maximum_report_interval: maxOverride ?? Number(max), reportable_change: change === "" ? 0 : Number(change),
  }, maxOverride === 65535 ? "Reporting off" : "Reporting saved").catch(() => undefined);
  if (!control.value) {
    return <tr><td>{r.ep}</td><td>{r.cluster}</td><td>{r.attribute}</td><td>{r.minimum_report_interval}</td><td>{r.maximum_report_interval}</td><td>{String(r.reportable_change ?? "")}</td></tr>;
  }
  return (
    <tr>
      <td>{r.ep}</td><td>{r.cluster}</td><td>{r.attribute}</td>
      <td><input class="cell-input" type="number" value={min} onInput={(e) => setMin((e.target as HTMLInputElement).value)} /></td>
      <td><input class="cell-input" type="number" value={max} onInput={(e) => setMax((e.target as HTMLInputElement).value)} /></td>
      <td><input class="cell-input" type="number" value={change} onInput={(e) => setChange((e.target as HTMLInputElement).value)} /></td>
      <td class="num">
        {dirty && <button type="button" class="link-btn small" onClick={() => send()}>Apply</button>}{" "}
        <button type="button" class="link-btn small" onClick={() => send(65535)}>Turn off</button>
      </td>
    </tr>
  );
}

function AddReporting({ dev, eps }: { dev: Dev; eps: Endpoints }) {
  const epIds = Object.keys(eps).filter((ep) => (eps[ep].clusters?.input || []).length);
  const [ep, setEp] = useState(epIds[0] || "1");
  const [cluster, setCluster] = useState("");
  const [attribute, setAttribute] = useState("");
  const [min, setMin] = useState("1");
  const [max, setMax] = useState("3600");
  const [change, setChange] = useState("1");
  const [names, setNames] = useState<any>(null);
  useEffect(() => { clusterNames(dev.ieee).then(setNames, () => setNames({})); }, [dev.ieee]);
  const attrs: string[] = (names?.custom?.[cluster] || names?.clusters?.[cluster])?.attributes || [];
  const add = () => req("device/configure_reporting", {
    id: dev.ieee, endpoint: Number(ep), cluster, attribute,
    minimum_report_interval: Number(min), maximum_report_interval: Number(max), reportable_change: Number(change),
  }, `Reporting set for ${attribute}`).catch(() => undefined);
  return (
    <Card title="Set up reporting">
      <div class="form-grid">
        <label>Endpoint
          <select value={ep} onChange={(e) => setEp((e.target as HTMLSelectElement).value)}>{epIds.map((x) => <option value={x}>{x}</option>)}</select>
        </label>
        <label>Cluster
          <select value={cluster} onChange={(e) => { setCluster((e.target as HTMLSelectElement).value); setAttribute(""); }}>
            <option value="">Choose</option>
            {(eps[ep]?.clusters?.input || []).map((c) => <option value={c}>{c}</option>)}
          </select>
        </label>
        <label>Attribute
          <input list="zs-attrs" value={attribute} onInput={(e) => setAttribute((e.target as HTMLInputElement).value)} placeholder={cluster ? "e.g. currentLevel" : "choose a cluster"} />
          <datalist id="zs-attrs">{attrs.map((a) => <option value={a} />)}</datalist>
        </label>
        <label>Min s<input type="number" value={min} onInput={(e) => setMin((e.target as HTMLInputElement).value)} /></label>
        <label>Max s<input type="number" value={max} onInput={(e) => setMax((e.target as HTMLInputElement).value)} /></label>
        <label>Change<input type="number" value={change} onInput={(e) => setChange((e.target as HTMLInputElement).value)} /></label>
      </div>
      <div class="row-btns"><button type="button" class="btn primary" disabled={!cluster || !attribute} onClick={add}>Apply</button></div>
    </Card>
  );
}
