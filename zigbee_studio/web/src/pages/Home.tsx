// Home: every device by floor and room (Home Assistant's), live.

import { useState } from "preact/hooks";
import { computed } from "@preact/signals";
import { devices, rooms, exposesOf, stateOf, availOf, snifferOf, counts, groups } from "../store";
import { isOn, feature, primaries, kindOf } from "../exposes";
import { matches } from "../format";
import { DeviceRow } from "../rows";
import { Search, Seg, Empty } from "../ui";
import { Icon } from "../icons";
import type { Dev } from "../types";

type Filter = "all" | "on" | "offline" | "issues";

const layout = computed(() => {
  const r = rooms.value;
  const devs = devices.value.filter((d) => d.type !== "Coordinator");
  const byArea = new Map<string, Dev[]>();
  const loose: Dev[] = [];
  for (const d of devs) {
    const a = r?.dev[d.ieee]?.area;
    if (a) byArea.set(a, [...(byArea.get(a) || []), d]);
    else loose.push(d);
  }
  const floors = (r?.floors || []).map((f) => ({
    ...f,
    areas: (r?.areas || []).filter((a) => a.floor === f.id && byArea.has(a.id)).map((a) => ({ ...a, devs: byArea.get(a.id)! })),
  })).filter((f) => f.areas.length);
  const noFloor = (r?.areas || []).filter((a) => !a.floor && byArea.has(a.id)).map((a) => ({ ...a, devs: byArea.get(a.id)! }));
  if (noFloor.length) floors.push({ id: "_none", name: "Other rooms", level: null, icon: null, areas: noFloor });
  return { floors, loose };
});

function keep(d: Dev, q: string, f: Filter): boolean {
  if (q && !matches(q, d.name, d.model, d.vendor, d.desc)) return false;
  if (f === "all") return true;
  if (f === "offline") return availOf(d.ieee).value === "offline";
  if (f === "issues") {
    const s = snifferOf(d.ieee).value?.s;
    return availOf(d.ieee).value === "offline" || s === "warning" || s === "problem";
  }
  const ex = exposesOf(d);
  return primaries(ex).some((e) => isOn(stateOf(d.ieee).value, feature(e, "state")));
}

const lightsOn = computed(() => devices.value.filter((d) => {
  const ex = exposesOf(d);
  return kindOf(d, ex) === "light" && primaries(ex).some((e) => isOn(stateOf(d.ieee).value, feature(e, "state")));
}).length);

export function Home() {
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filter>("all");
  const { floors, loose } = layout.value;
  const c = counts.value;
  let shown = 0;
  const areaCard = (a: { id: string; name: string; devs: Dev[] }) => {
    const list = a.devs.filter((d) => keep(d, q, f));
    shown += list.length;
    if (!list.length) return null;
    return (
      <section class="room card" key={a.id}>
        <header class="room-head">
          <h3>{a.name}</h3>
          <span class="muted">{list.length}</span>
        </header>
        <div class="rows">{list.map((d) => <DeviceRow dev={d} key={d.ieee} />)}</div>
      </section>
    );
  };
  const body = (
    <>
      {floors.map((fl) => {
        const cards = fl.areas.map(areaCard).filter(Boolean);
        return cards.length ? (
          <div class="floor" key={fl.id}>
            <h2 class="floor-title">{fl.name}</h2>
            <div class="masonry">{cards}</div>
          </div>
        ) : null;
      })}
      {loose.length > 0 && (() => {
        const card = areaCard({ id: "_loose", name: "Not in a room", devs: loose });
        return card ? <div class="floor"><h2 class="floor-title">Elsewhere</h2><div class="masonry">{card}</div></div> : null;
      })()}
    </>
  );
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Home</h1>
          <p class="lede">
            {c.total} devices · <span class={c.offline ? "bad-text" : ""}>{c.offline} offline</span> · {lightsOn.value} lights on · {groups.value.length} groups
          </p>
        </div>
        <div class="toolbar">
          <Search value={q} onInput={setQ} placeholder="Filter devices" />
          <Seg label="Show" value={f} onChange={setF} options={[
            { v: "all", label: "All" }, { v: "on", label: "On" }, { v: "offline", label: "Offline" }, { v: "issues", label: "Issues" },
          ]} />
        </div>
      </div>
      {!rooms.value && (
        <p class="note"><Icon name="info" size={16} /> Rooms come from Home Assistant; they appear once it answers.</p>
      )}
      {body}
      {shown === 0 && <Empty>No devices match.</Empty>}
    </div>
  );
}
