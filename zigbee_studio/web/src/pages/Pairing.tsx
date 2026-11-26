// Add devices: open joining (everywhere or through one router), watch joins and interviews as they
// happen, name what joined. Install codes for devices that need one.

import { useEffect, useState } from "preact/hooks";
import { bridge, control, devByKey, devices, events, areaOf, nowS } from "../store";
import { req } from "../conn";
import { ask } from "../dialog";
import { dayClock, title } from "../format";
import { Icon } from "../icons";
import { href } from "../route";
import { Card, Chip, Empty } from "../ui";

const JOIN_EVENTS = new Set(["device_joined", "device_interview", "device_announce", "device_leave", "device_added", "device_removed"]);

function useSecondTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

export function Pairing() {
  const b = bridge.value;
  const open = !!b?.permit_join;
  useSecondTick(open);
  const left = open && b?.permit_join_end ? Math.max(0, Math.round(b.permit_join_end / 1000 - nowS())) : null;
  const [via, setVia] = useState("");
  const [opened] = useState(() => nowS());
  const routers = devices.value.filter((d) => d.type === "Router" || d.type === "Coordinator");
  const recent = events.value.filter((e) => JOIN_EVENTS.has(e.type) && e.ts > nowS() - 3 * 3600).slice(-40).reverse();
  const fresh = devices.value.filter((d) => d.interview !== "SUCCESSFUL" || recent.some((e) => e.key === d.ieee && e.type === "device_joined"));
  const start = (seconds: number) =>
    req("permit_join", { time: seconds, ...(via ? { device: via } : {}) },
      seconds ? `Joining open for ${Math.round(seconds / 60)} min${via ? ` through ${devByKey.value.get(via)?.name}` : ""}` : "Joining closed").catch(() => undefined);
  const name = async (ieee: string) => {
    const d = devByKey.value.get(ieee);
    const v = await ask({ title: "Name the new device", confirm: "Save", fields: [{ name: "to", label: "Name", value: d?.name === ieee ? "" : d?.name, placeholder: "e.g. Back Door" }] });
    if (v?.to.trim()) await req("device/rename", { from: ieee, to: v.to.trim() }, `Named ${v.to.trim()}`).catch(() => undefined);
  };
  const installCode = async () => {
    const v = await ask({ title: "Add an install code", confirm: "Add", body: "For devices that came with an install code (a QR code or a long number on the box).",
      fields: [{ name: "code", label: "Install code", placeholder: "the code or the QR text" }] });
    if (v?.code.trim()) await req("install_code/add", { value: v.code.trim() }, "Install code added").catch(() => undefined);
  };
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Add devices</h1>
          <p class="lede">Open joining, then reset or pair the device; it shows up here as it joins.</p>
        </div>
      </div>
      <div class="dev-grid">
        <div class="dev-col">
          <Card title={<>Joining {open ? <Chip tone="warn">open{left !== null ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : ""}</Chip> : <Chip tone="muted">closed</Chip>}</>}>
            {!control.value ? <p class="muted">Read-only: turn on Allow control in the add-on's configuration to pair devices.</p> : (
              <>
                <label class="field-label" for="via">Join through</label>
                <select id="via" value={via} onChange={(e) => setVia((e.target as HTMLSelectElement).value)} class="wide-select">
                  <option value="">Any router (the whole network)</option>
                  {routers.map((d) => <option value={d.ieee}>{d.type === "Coordinator" ? "Coordinator only" : d.name}{areaOf(d.ieee) ? ` · ${areaOf(d.ieee)!.name}` : ""}</option>)}
                </select>
                <p class="muted small">Joining through the router nearest the new device gives it a better first route.</p>
                <div class="row-btns">
                  {!open && <button type="button" class="btn primary" onClick={() => start(240)}><Icon name="plus" size={15} /> Open for 4 minutes</button>}
                  {open && <button type="button" class="btn" onClick={() => start(240)}>Restart the 4 minutes</button>}
                  {open && <button type="button" class="btn danger" onClick={() => start(0)}>Stop joining</button>}
                </div>
              </>
            )}
          </Card>
          <Card title={<>New devices <span class="muted">{fresh.length}</span></>}>
            {fresh.length === 0 ? <Empty>Nothing new yet.</Empty> : (
              <ul class="plain list-rows">
                {fresh.map((d) => (
                  <li>
                    <a href={href("device", d.ieee)}><b>{d.name}</b></a>
                    <span class="muted small">{[d.vendor, d.model].filter(Boolean).join(" ") || "identifying…"}</span>
                    {d.interview === "SUCCESSFUL" ? <Chip tone="ok">ready</Chip> : d.interview === "FAILED" ? <Chip tone="bad">interview failed</Chip> : <Chip tone="info">interviewing…</Chip>}
                    {control.value && d.name === d.ieee && <button type="button" class="link-btn small push-right" onClick={() => name(d.ieee)}>Name it</button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {control.value && (
            <Card title="Install codes">
              <p class="muted small">Some devices only join with their install code added first.</p>
              <button type="button" class="btn small" onClick={installCode}>Add an install code</button>
            </Card>
          )}
        </div>
        <div class="dev-col">
          <Card title="What happened">
            {recent.length === 0 ? <Empty>No joins, interviews or leaves in the last 3 hours.</Empty> : (
              <ul class="events">
                {recent.map((e) => (
                  <li class={e.ts >= opened ? "new-event" : ""}>
                    <span class="muted">{dayClock(e.ts)}</span>{" "}
                    {title(e.type.replace("device_", ""))}{e.status ? ` ${e.status}` : ""}{" "}
                    {e.key ? <a href={href("device", e.key)}>{devByKey.value.get(e.key)?.name || e.friendly_name || e.key}</a> : e.friendly_name}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
