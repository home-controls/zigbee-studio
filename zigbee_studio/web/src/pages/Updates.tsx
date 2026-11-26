// Firmware updates for every device that supports OTA: what's installed, what's available,
// progress while updating; check one or all, update one.

import { useState } from "preact/hooks";
import { devices, stateOf, control, areaOf } from "../store";
import { toast } from "../conn";
import { Icon } from "../icons";
import { href } from "../route";
import { Chip, Empty, Seg } from "../ui";
import { otaCheck, otaUpdate, updateLabel, updateState, versionText } from "./DeviceMisc";
import type { Dev } from "../types";

type Show = "all" | "available" | "updating";

export function Updates() {
  const [show, setShow] = useState<Show>("all");
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const ota = devices.value.filter((d) => d.ota && d.type !== "Coordinator");
  const states = ota.map((d) => ({ d, u: updateState(stateOf(d.ieee).value) }));
  const available = states.filter((x) => x.u.state === "available").length;
  const updating = states.filter((x) => x.u.state === "updating").length;
  const list = states.filter((x) => show === "all" || (show === "available" ? x.u.state === "available" : x.u.state === "updating" || x.u.state === "scheduled"));
  const checkAll = async () => {
    const todo = ota.filter((d) => updateState(stateOf(d.ieee).value).state !== "updating" && d.power !== "Battery");
    setChecking({ done: 0, total: todo.length });
    let found = 0;
    for (let i = 0; i < todo.length; i++) {
      try {
        const r = await otaCheck(todo[i], true);
        if (r?.update_available) found++;
      } catch {
        /* the toast said why; carry on */
      }
      setChecking({ done: i + 1, total: todo.length });
    }
    setChecking(null);
    toast(found ? "warn" : "ok", found ? `${found} update${found === 1 ? "" : "s"} available` : "Everything checked is up to date");
  };
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Firmware updates</h1>
          <p class="lede">{ota.length} devices support updates · {available} available{updating ? ` · ${updating} updating` : ""}</p>
        </div>
        <div class="toolbar">
          <Seg label="Show" value={show} onChange={setShow} options={[{ v: "all", label: "All" }, { v: "available", label: `Available${available ? ` (${available})` : ""}` }, { v: "updating", label: "In progress" }]} />
          {control.value && (
            <button type="button" class="btn" disabled={!!checking} onClick={checkAll} title="Battery devices are skipped: they answer only when awake">
              <Icon name="refresh" size={15} /> {checking ? `Checking ${checking.done}/${checking.total}…` : "Check all"}
            </button>
          )}
        </div>
      </div>
      <div class="table-wrap card">
        <table class="devices">
          <thead><tr><th><button type="button">Device</button></th><th class="hide-sm"><button type="button">Installed</button></th><th class="hide-sm"><button type="button">Latest</button></th><th><button type="button">Status</button></th>{control.value && <th />}</tr></thead>
          <tbody>{list.map(({ d }) => <Row d={d} key={d.ieee} />)}</tbody>
        </table>
        {list.length === 0 && <Empty>{show === "all" ? "No device here supports updates." : "Nothing here."}</Empty>}
      </div>
    </div>
  );
}

function Row({ d }: { d: Dev }) {
  const st = stateOf(d.ieee).value;
  const u = updateState(st);
  return (
    <tr>
      <td><a class="cell-name" href={href("device", d.ieee, "firmware")}><span>{d.name}<small>{[areaOf(d.ieee)?.name, d.vendor, d.model].filter(Boolean).join(" · ")}</small></span></a></td>
      <td class="hide-sm num">{versionText(u.installed).split(" ")[0]}</td>
      <td class="hide-sm num">{versionText(u.latest).split(" ")[0]}</td>
      <td>
        {u.state === "updating" ? (
          <div class="progress-wrap"><div class="progress"><i style={{ width: `${u.progress ?? 0}%` }} /></div><span class="small">{u.progress ?? 0}%</span></div>
        ) : <Chip tone={u.state === "available" ? "warn" : u.state === "idle" ? "ok" : "muted"}>{updateLabel(st)}</Chip>}
      </td>
      {control.value && (
        <td class="num">
          {u.state === "available" ? <button type="button" class="btn small primary" onClick={() => otaUpdate(d)}>Update</button>
            : u.state !== "updating" && <button type="button" class="link-btn small" onClick={() => otaCheck(d).catch(() => undefined)}>Check</button>}
        </td>
      )}
    </tr>
  );
}

