// Scenes (a device's or a group's: store the current state under a number, recall it, remove it)
// and firmware updates (OTA: check, update now, update when a sleepy device next wakes).

import { setState, req, toast } from "../conn";
import { ask, confirmIt } from "../dialog";
import { control, stateOf } from "../store";
import { title } from "../format";
import { Icon } from "../icons";
import { Card, Chip, Empty, KV } from "../ui";
import type { Dev } from "../types";

// ------------------------------------------------------------------ scenes

export function ScenesEditor({ k, name, scenes, endpoint }: { k: string; name: string; scenes: { id: number; name?: string }[]; endpoint?: string }) {
  const set = (payload: Record<string, any>) => setState(k, payload, endpoint);
  const store = async () => {
    const next = Math.max(0, ...scenes.map((s) => s.id)) + 1;
    const v = await ask({
      title: `Store ${name}'s current state as a scene`, confirm: "Store",
      body: <>Whatever {name} shows now (on/off, brightness, colour) is saved in the device{scenes.length ? "s" : ""} under this number.</>,
      fields: [{ name: "id", label: "Scene number", value: String(next), type: "number" }, { name: "name", label: "Name", placeholder: "e.g. Evening" }],
    });
    if (!v) return;
    await set({ scene_store: { ID: Number(v.id), name: v.name || `Scene ${v.id}` } });
  };
  const rename = async (s: { id: number; name?: string }) => {
    const v = await ask({ title: `Rename scene ${s.id}`, confirm: "Rename", fields: [{ name: "name", label: "Name", value: s.name || "" }] });
    if (v?.name) await set({ scene_rename: { ID: s.id, name: v.name } });
  };
  const remove = async (s: { id: number; name?: string }) => {
    if (await confirmIt({ title: `Remove scene “${s.name || s.id}”?`, confirm: "Remove", danger: true })) await set({ scene_remove: s.id });
  };
  return (
    <div class="scenes">
      {scenes.length === 0 ? <p class="muted small">No scenes.</p> : (
        <ul class="plain list-rows">
          {[...scenes].sort((a, b) => a.id - b.id).map((s) => (
            <li>
              <span class="ep">#{s.id}</span>
              <b>{s.name || `Scene ${s.id}`}</b>
              {control.value && (
                <span class="push-right row-btns">
                  <button type="button" class="btn small" onClick={() => set({ scene_recall: s.id })}><Icon name="play" size={13} /> Recall</button>
                  <button type="button" class="link-btn small" onClick={() => rename(s)}>Rename</button>
                  <button type="button" class="link-btn small" onClick={() => remove(s)}>Remove</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {control.value && <button type="button" class="btn small" onClick={store}><Icon name="plus" size={14} /> Store current state</button>}
    </div>
  );
}

export function ScenesTab({ dev, detail }: { dev: Dev; detail: any }) {
  const eps = Object.entries((detail?.endpoints || {}) as Record<string, any>).filter(([, e]) => (e.clusters?.input || []).includes("genScenes"));
  if (!detail) return <Card title="Scenes"><Empty>Loading…</Empty></Card>;
  return (
    <div class="dev-col">
      {eps.map(([ep, e]) => (
        <Card title={eps.length > 1 ? `Scenes on endpoint ${ep}` : "Scenes"}>
          <ScenesEditor k={dev.ieee} name={dev.name} scenes={e.scenes || []} endpoint={eps.length > 1 ? ep : undefined} />
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ firmware

export function versionText(v: any): string {
  if (v === undefined || v === null) return "—";
  return typeof v === "number" ? `${v} (0x${v.toString(16).padStart(8, "0")})` : String(v);
}

const UPDATE_TONE: Record<string, "ok" | "warn" | "info" | "muted"> = { available: "warn", updating: "info", scheduled: "info", idle: "ok" };

export function updateState(st: Record<string, any>): { state?: string; progress?: number; remaining?: number; installed?: any; latest?: any; notes?: string; source?: string } {
  const u = st.update || {};
  return { state: u.state, progress: u.progress, remaining: u.remaining, installed: u.installed_version, latest: u.latest_version, notes: u.latest_release_notes, source: u.latest_source };
}

export async function otaCheck(dev: Dev, quiet = false) {
  return req("device/ota_update/check", { id: dev.ieee }, undefined, 120).then((d) => {
    if (!quiet) toast(d?.update_available ? "warn" : "ok", d?.update_available ? `${dev.name}: an update is available` : `${dev.name} is up to date`);
    return d;
  });
}

export async function otaUpdate(dev: Dev) {
  if (!(await confirmIt({
    title: `Update ${dev.name}'s firmware?`, confirm: "Update", danger: true,
    body: <>This can take from a few minutes to over an hour. The device keeps working meanwhile and restarts at the end;
      don't remove its power until it's done. Progress shows here.</>,
  }))) return;
  req("device/ota_update/update", { id: dev.ieee }, `${dev.name} updated`, 4 * 3600).catch(() => undefined);
}

export function FirmwareTab({ dev }: { dev: Dev }) {
  const st = stateOf(dev.ieee).value;
  const u = updateState(st);
  const sleepy = dev.power === "Battery";
  return (
    <div class="dev-col">
      <Card title={<>Firmware {u.state && <Chip tone={UPDATE_TONE[u.state] || "muted"}>{u.state === "available" ? "update available" : u.state}</Chip>}</>}>
        <KV rows={[
          ["Installed", versionText(u.installed)],
          ["Latest known", versionText(u.latest)],
          ["Build", dev.sw],
          ["Date code", dev.date],
          ["OTA", dev.ota ? "Supported" : "Not supported by this device"],
        ]} />
        {u.state === "updating" && (
          <div class="progress-wrap">
            <div class="progress"><i style={{ width: `${u.progress ?? 0}%` }} /></div>
            <span class="muted small">{u.progress ?? 0}%{u.remaining ? ` · about ${Math.ceil(u.remaining / 60)} min left` : ""}</span>
          </div>
        )}
        {u.notes && <p class="small"><b>Release notes:</b> {u.notes}</p>}
        {u.source && <p class="small muted" style={{ overflowWrap: "anywhere" }}>From {u.source}</p>}
        {control.value && dev.ota && (
          <div class="row-btns">
            <button type="button" class="btn" disabled={u.state === "updating"} onClick={() => otaCheck(dev).catch(() => undefined)}><Icon name="refresh" size={14} /> Check for update</button>
            {u.state === "available" && <button type="button" class="btn primary" onClick={() => otaUpdate(dev)}>Update now</button>}
            {u.state === "updating" && (
              <button type="button" class="btn danger" onClick={async () => {
                if (await confirmIt({ title: `Stop updating ${dev.name}?`, danger: true, confirm: "Stop the update",
                  body: "The download stops and the device keeps the firmware it has now. You can start again later; it starts from the beginning." })) {
                  req("device/ota_update/update/abort", { id: dev.ieee }, "Update stopped").catch(() => undefined);
                }
              }}>Stop the update</button>
            )}
            {sleepy && u.state === "available" && (
              <button type="button" class="btn" onClick={() => req("device/ota_update/schedule", { id: dev.ieee }, "Will update when it next wakes").catch(() => undefined)}>Update when it wakes</button>
            )}
            {u.state === "scheduled" && (
              <button type="button" class="btn" onClick={() => req("device/ota_update/unschedule", { id: dev.ieee }, "Unscheduled").catch(() => undefined)}>Unschedule</button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

export function updateLabel(st: Record<string, any>): string {
  const u = updateState(st);
  if (!u.state) return "—";
  if (u.state === "updating") return `Updating ${u.progress ?? 0}%`;
  return u.state === "available" ? "Update available" : title(u.state);
}
