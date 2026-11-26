// Devices: one sortable table with link quality, the Sniffer's signal and health, last heard.

import { useState } from "preact/hooks";
import { devices, exposesOf, stateOf, availOf, heardOf, snifferOf, areaOf, health } from "../store";
import { kindOf, battery } from "../exposes";
import { ago, isoToTs, matches, num } from "../format";
import { Icon, KIND_ICON } from "../icons";
import { href } from "../route";
import { Chip, HEALTH_TONE, Lqi, Search, Seg, Empty } from "../ui";
import type { Dev } from "../types";

type Sort = "name" | "room" | "lqi" | "signal" | "health" | "heard" | "model" | "rate";
type TypeF = "all" | "Router" | "EndDevice";
type Status = "all" | "offline" | "issues" | "weak";

const SEV: Record<string, number> = { problem: 4, warning: 3, note: 2, "not heard": 1, ok: 0 };

export function lastHeard(d: Dev): number | undefined {
  const mine = heardOf(d.ieee).value;
  const sniff = isoToTs(snifferOf(d.ieee).value?.heard);
  return Math.max(mine || 0, sniff || 0) || undefined;
}

function value(d: Dev, s: Sort): string | number {
  switch (s) {
    case "name": return d.name.toLowerCase();
    case "room": return (areaOf(d.ieee)?.name || "~").toLowerCase();
    case "lqi": return stateOf(d.ieee).value.linkquality ?? -1;
    case "signal": return snifferOf(d.ieee).value?.signal ?? -999;
    case "health": return SEV[snifferOf(d.ieee).value?.s || ""] ?? -1;
    case "heard": return lastHeard(d) ?? 0;
    case "model": return `${d.vendor} ${d.model}`.toLowerCase();
    case "rate": return health.value?.devices[d.ieee]?.mps ?? 0;
  }
}

export function Devices() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [desc, setDesc] = useState(false);
  const [typ, setTyp] = useState<TypeF>("all");
  const [status, setStatus] = useState<Status>("all");
  let list = devices.value.filter((d) => d.type !== "Coordinator");
  if (typ !== "all") list = list.filter((d) => d.type === typ);
  if (q) list = list.filter((d) => matches(q, d.name, d.model, d.vendor, d.desc, d.ieee, areaOf(d.ieee)?.name));
  if (status === "offline") list = list.filter((d) => availOf(d.ieee).value === "offline");
  if (status === "issues") list = list.filter((d) => ["warning", "problem"].includes(snifferOf(d.ieee).value?.s || "") || availOf(d.ieee).value === "offline");
  if (status === "weak") list = list.filter((d) => (stateOf(d.ieee).value.linkquality ?? 255) < 60 || (snifferOf(d.ieee).value?.signal ?? 0) < -85);
  const sorted = [...list].sort((a, b) => {
    const va = value(a, sort), vb = value(b, sort);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return desc ? -c : c;
  });
  const th = (s: Sort, label: string, cls = "") => (
    <th class={cls} aria-sort={sort === s ? (desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => { if (sort === s) setDesc(!desc); else { setSort(s); setDesc(["lqi", "signal", "health", "heard", "rate"].includes(s)); } }}>
        {label}{sort === s && <span class="sort">{desc ? "▾" : "▴"}</span>}
      </button>
    </th>
  );
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Devices</h1>
          <p class="lede">{sorted.length} shown</p>
        </div>
        <div class="toolbar">
          <Search value={q} onInput={setQ} placeholder="Name, model, room, IEEE" />
          <Seg label="Type" value={typ} onChange={setTyp} options={[{ v: "all", label: "All" }, { v: "Router", label: "Routers" }, { v: "EndDevice", label: "End devices" }]} />
          <Seg label="Status" value={status} onChange={setStatus} options={[{ v: "all", label: "Any" }, { v: "offline", label: "Offline" }, { v: "issues", label: "Issues" }, { v: "weak", label: "Weak link" }]} />
        </div>
      </div>
      <div class="table-wrap card">
        <table class="devices">
          <thead>
            <tr>
              {th("name", "Device")}
              {th("room", "Room", "hide-sm")}
              {th("model", "Model", "hide-md")}
              {th("lqi", "LQI")}
              {th("signal", "Signal", "hide-sm")}
              {th("health", "Health")}
              {th("rate", "Msgs/h", "hide-md")}
              {th("heard", "Last heard", "hide-sm")}
            </tr>
          </thead>
          <tbody>{sorted.map((d) => <Row d={d} key={d.ieee} />)}</tbody>
        </table>
        {sorted.length === 0 && <Empty>No devices match.</Empty>}
      </div>
    </div>
  );
}

function Row({ d }: { d: Dev }) {
  const ex = exposesOf(d);
  const kind = kindOf(d, ex);
  const st = stateOf(d.ieee).value;
  const av = availOf(d.ieee).value;
  const sn = snifferOf(d.ieee).value;
  const bat = battery(st);
  const mps = health.value?.devices[d.ieee]?.mps;
  return (
    <tr class={av === "offline" ? "offline" : ""}>
      <td>
        <a class="cell-name" href={href("device", d.ieee)}>
          <Icon name={KIND_ICON[kind]} size={18} />
          <span>
            {d.name}
            <small>{d.type === "Router" ? "Router" : "End device"}{bat !== undefined ? ` · ${bat}%` : ""}{av === "offline" ? " · offline" : ""}</small>
          </span>
        </a>
      </td>
      <td class="hide-sm">{areaOf(d.ieee)?.name || <span class="muted">—</span>}</td>
      <td class="hide-md"><span class="model">{d.vendor} {d.model}</span></td>
      <td><Lqi v={st.linkquality} /></td>
      <td class="hide-sm num">{sn?.signal !== undefined && sn?.signal !== null ? `${num(sn.signal)} dBm` : <span class="muted">—</span>}</td>
      <td>{sn ? <Chip tone={HEALTH_TONE[sn.s]} title={sn.findings.join("\n") || undefined}>{sn.s}</Chip> : <span class="muted">—</span>}</td>
      <td class="hide-md num">{mps !== undefined ? num(mps * 3600) : "—"}</td>
      <td class="hide-sm">{ago(lastHeard(d))}</td>
    </tr>
  );
}
