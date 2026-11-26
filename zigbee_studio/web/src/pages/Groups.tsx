// Groups: live state; for lights, power, brightness, white and colour as far as every member
// can follow; members, scenes, Zigbee2MQTT's options for the group; with control, create, rename,
// delete, and add/remove members.

import { useEffect, useState } from "preact/hooks";
import { useComputed } from "@preact/signals";
import { groups, devByKey, devices, stateOf, exposesOf, areaOf, control } from "../store";
import { call, req, setState } from "../conn";
import { ask, confirmIt } from "../dialog";
import { groupLight, primaries } from "../exposes";
import { ExposeControl } from "../controls";
import { SchemaField, z2mSchema } from "./DeviceConfig";
import { DeviceRow } from "../rows";
import { Icon } from "../icons";
import { Card, Chip, Empty, Toggle } from "../ui";
import { ScenesEditor } from "./DeviceMisc";
import type { Group } from "../types";

export function Groups() {
  const gs = groups.value;
  const create = async () => {
    const v = await ask({
      title: "New group", confirm: "Create",
      body: "A Zigbee group: one command reaches every member at once, in the same instant.",
      fields: [{ name: "name", label: "Name", placeholder: "e.g. Kitchen Lights" }, { name: "id", label: "Group number (optional)", type: "number" }],
    });
    if (!v?.name.trim()) return;
    await req("group/add", { friendly_name: v.name.trim(), ...(v.id ? { id: Number(v.id) } : {}) }, `Group ${v.name.trim()} created`).catch(() => undefined);
  };
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Groups</h1>
          <p class="lede">{gs.length} Zigbee groups: one command, every member at once</p>
        </div>
        {control.value && <div class="toolbar"><button type="button" class="btn primary" onClick={create}><Icon name="plus" size={15} /> New group</button></div>}
      </div>
      {gs.length === 0 && <Empty>No groups.</Empty>}
      <div class="masonry">{gs.map((g) => <GroupCard g={g} key={g.key} />)}</div>
    </div>
  );
}

function GroupCard({ g }: { g: Group }) {
  const st = stateOf(g.key).value;
  const [adding, setAdding] = useState(false);
  const members = g.members.map((m) => ({ m, d: devByKey.value.get(m.ieee) })).filter((x) => x.d) as { m: Group["members"][0]; d: NonNullable<ReturnType<typeof devByKey.value.get>> }[];
  const devs = members.map((x) => x.d);
  const lights = devs.length > 0 && devs.every((d) => primaries(exposesOf(d)).some((e) => e.type === "light"));
  const switchable = devs.length > 0 && devs.every((d) => primaries(exposesOf(d)).some((e) => e.type === "light" || e.type === "switch"));
  // Zigbee2MQTT publishes a group's state once something changes it; until then, go by the members
  const memberStates = devs.map((d) => stateOf(d.ieee).value);
  const anyOn = memberStates.some((s) => s.state === "ON");
  const on = st.state !== undefined ? st.state === "ON" : memberStates.some((s) => s.state !== undefined) ? anyOn : undefined;
  const light = lights ? groupLight(devs.map((d) => exposesOf(d))) : null;
  // the group's own state where Zigbee2MQTT has published it, else what the members say
  const lightState = useComputed(() => {
    const own = stateOf(g.key).value;
    const ms = g.members.map((m) => stateOf(m.ieee).value);
    const litNow = ms.filter((s) => s.state === "ON");
    const avg = (k: string) => {
      const xs = litNow.map((s) => s[k]).filter((v) => typeof v === "number");
      return xs.length ? Math.round(xs.reduce((a, v) => a + v, 0) / xs.length) : undefined;
    };
    const first = litNow.find((s) => s.color !== undefined || s.color_temp !== undefined) || {};
    const fallback: Record<string, any> = {
      state: ms.some((s) => s.state !== undefined) ? (litNow.length ? "ON" : "OFF") : undefined,
      brightness: avg("brightness"), color_temp: avg("color_temp"), color: first.color, color_mode: first.color_mode,
    };
    return { ...Object.fromEntries(Object.entries(fallback).filter(([, v]) => v !== undefined)), ...own };
  });
  const rooms = [...new Set(devs.map((d) => areaOf(d.ieee)?.name).filter(Boolean))];
  const rename = async () => {
    const v = await ask({ title: `Rename ${g.name}`, confirm: "Rename", fields: [{ name: "to", label: "New name", value: g.name }] });
    if (v?.to.trim() && v.to.trim() !== g.name) await req("group/rename", { from: g.name, to: v.to.trim() }, "Renamed").catch(() => undefined);
  };
  const remove = async () => {
    if (await confirmIt({
      title: `Delete ${g.name}?`, danger: true, confirm: "Delete", typeToConfirm: g.name,
      body: <>The group goes from Zigbee2MQTT and from its {g.members.length} member{g.members.length === 1 ? "" : "s"}; the devices stay.
        Bindings and automations that use the group stop working.</>,
    })) await req("group/remove", { id: g.name }, `${g.name} deleted`).catch(() => undefined);
  };
  const dropMember = async (m: Group["members"][0], name: string) => {
    if (await confirmIt({ title: `Take ${name} out of ${g.name}?`, confirm: "Remove", danger: true })) {
      await req("group/members/remove", { group: g.name, device: m.ieee, endpoint: m.ep }, `${name} removed from ${g.name}`).catch(() => undefined);
    }
  };
  return (
    <Card class="group-card" title={<>{g.name} <span class="muted small">#{g.id}</span></>}
      actions={switchable && !light && control.value && <Toggle on={on} label={`Turn ${g.name} ${on ? "off" : "on"}`} onChange={(v) => setState(g.key, { state: v ? "ON" : "OFF" })} />}>
      <p class="muted small">
        {g.members.length} member{g.members.length === 1 ? "" : "s"}{rooms.length ? ` · ${rooms.join(", ")}` : ""}
        {g.scenes.length > 0 && <> · {g.scenes.length} scenes</>}
      </p>
      {light && <div class="controls group-light"><ExposeControl k={g.key} e={light} st={lightState} /></div>}
      <div class="rows">
        {members.map(({ m, d }) => (
          <div class="member">
            <DeviceRow dev={d} key={`${d.ieee}/${m.ep}`} sub={members.filter((x) => x.d.ieee === d.ieee).length > 1 ? `endpoint ${m.ep}` : undefined} />
            {control.value && (
              <button type="button" class="icon-btn small-x" title={`Take ${d.name} out of the group`} aria-label={`Take ${d.name} out of ${g.name}`}
                onClick={() => dropMember(m, d.name)}><Icon name="x" size={14} /></button>
            )}
          </div>
        ))}
      </div>
      {g.members.length > members.length && <Chip tone="warn">{g.members.length - members.length} unknown member(s)</Chip>}
      {control.value && (adding ? <AddMember g={g} done={() => setAdding(false)} /> : null)}
      <details class="setting-group">
        <summary>Scenes <span class="muted">{g.scenes.length}</span></summary>
        <ScenesEditor k={g.key} name={g.name} scenes={g.scenes} />
      </details>
      <GroupOptions g={g} />
      {control.value && (
        <div class="card-foot">
          {!adding && <button type="button" class="link-btn small" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Add member</button>}
          <button type="button" class="link-btn small" onClick={rename}>Rename</button>
          <button type="button" class="link-btn small danger-text" onClick={remove}>Delete</button>
        </div>
      )}
    </Card>
  );
}

const SKIP_GROUP = new Set(["friendly_name", "devices", "ID", "description"]);

/** Zigbee2MQTT's options for a group (retain, optimistic, off_state, filtered attributes...),
 *  from its settings schema; loaded when opened, changed through group/options. */
function GroupOptions({ g }: { g: Group }) {
  const [open, setOpen] = useState(false);
  const [own, setOwn] = useState<Record<string, any> | null>(null);
  const [schema, setSchema] = useState<any>(null);
  const load = () => call("group_options", { group: g.id }).then(setOwn, () => setOwn({}));
  useEffect(() => {
    if (!open) return;
    load();
    z2mSchema().then(setSchema, () => setSchema({}));
  }, [open, g.id]);
  const setOpt = async (name: string, v: any) => {
    await req("group/options", { id: g.id, options: { [name]: v } }, v === null ? "Back to default" : "Saved").catch(() => undefined);
    load();
  };
  const props = Object.entries(schema?.definitions?.group?.properties || {}).filter(([k]) => !SKIP_GROUP.has(k)) as [string, any][];
  const set = own ? Object.keys(own).filter((k) => !SKIP_GROUP.has(k)).length : 0;
  return (
    <details class="setting-group" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Options {set > 0 && <span class="muted">{set} set</span>}</summary>
      {open && (!own || !schema ? <Empty>Loading…</Empty> : (
        <div class="fields">
          {props.map(([name, p]) => <SchemaField name={name} prop={p} value={own[name]} onSet={(v) => setOpt(name, v)} />)}
        </div>
      ))}
    </details>
  );
}

function AddMember({ g, done }: { g: Group; done: () => void }) {
  const [dev, setDev] = useState("");
  const [ep, setEp] = useState("");
  const [busy, setBusy] = useState(false);
  const inGroup = new Set(g.members.map((m) => m.ieee));
  const candidates = devices.value.filter((d) => d.type !== "Coordinator" && !inGroup.has(d.ieee) && primaries(exposesOf(d)).length);
  const chosen = devByKey.value.get(dev);
  const eps = chosen ? [...new Set(primaries(exposesOf(chosen)).map((e) => e.endpoint).filter(Boolean))] : [];
  const add = async () => {
    if (!dev) return;
    setBusy(true);
    await req("group/members/add", { group: g.name, device: dev, ...(ep ? { endpoint: ep } : {}) }, `${chosen?.name} added to ${g.name}`).then(done, () => undefined);
    setBusy(false);
  };
  return (
    <div class="add-member">
      <select value={dev} onChange={(e) => { setDev((e.target as HTMLSelectElement).value); setEp(""); }} aria-label="Device to add">
        <option value="">Choose a device</option>
        {candidates.map((d) => <option value={d.ieee}>{d.name}{areaOf(d.ieee) ? ` · ${areaOf(d.ieee)!.name}` : ""}</option>)}
      </select>
      {eps.length > 1 && (
        <select value={ep} onChange={(e) => setEp((e.target as HTMLSelectElement).value)} aria-label="Endpoint">
          <option value="">Default endpoint</option>
          {eps.map((x) => <option value={x}>{x}</option>)}
        </select>
      )}
      <button type="button" class="btn small primary" disabled={!dev || busy} onClick={add}>Add</button>
      <button type="button" class="btn small" onClick={done}>Cancel</button>
    </div>
  );
}
