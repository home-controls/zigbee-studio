// One device, in tabs: Overview (controls, readings, the Sniffer's findings), Settings (its own
// settings and Zigbee2MQTT's options for it), Bind, Reporting, Scenes, Firmware, Advanced.

import { useEffect, useState } from "preact/hooks";
import { call, req, write } from "../conn";
import { ask, confirmIt } from "../dialog";
import { devByKey, exposesOf, stateOf, availOf, snifferOf, heardOf, areaOf, rooms, control, windfront, events, health, groups, bridge, snifferPanel, adapter } from "../store";
import { kindOf, sections } from "../exposes";
import { ExposeControl } from "../controls";
import { ago, dayClock, hex, isoToTs, num, title } from "../format";
import { Icon, KIND_ICON } from "../icons";
import { go, href } from "../route";
import { Card, Chip, Empty, Ext, HEALTH_TONE, KV, Lqi } from "../ui";
import { lastHeard } from "./Devices";
import { OptionsCard } from "./DeviceConfig";
import { BindTab, ReportingTab } from "./DeviceBind";
import { FirmwareTab, ScenesTab, updateState } from "./DeviceMisc";
import { SnifferTab } from "./DeviceSniffer";
import { AdapterTab } from "./Adapter";
import { ConsoleTab } from "./DeviceConsole";
import { useDeepLink } from "../links";
import { nwkHex } from "../sniffer";
import type { Dev, Expose } from "../types";

type Tab = "overview" | "adapter" | "sniffer" | "settings" | "bind" | "reporting" | "scenes" | "firmware" | "console" | "advanced";

export function Device({ ieee, tab }: { ieee: string; tab?: string }) {
  const dev = devByKey.value.get(ieee);
  if (!dev) return <div class="page"><Empty>No device {ieee}. <a href={href("devices")}>All devices</a></Empty></div>;
  return <DevicePage dev={dev} tab={(tab as Tab) || "overview"} key={ieee} />;
}

/** The device's endpoints/options/config, fetched again whenever Zigbee2MQTT republishes its
 * device list (a new binding, reporting change or rename changes the device's entry). */
function useDetail(dev: Dev) {
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call("device", { key: dev.ieee }).then((d) => live && (setDetail(d), setErr(null)), (e) => live && setErr(e.message));
    return () => { live = false; };
  }, [dev, bridge.value]); // bridge/info carries the device's options
  return { detail, err };
}

function DevicePage({ dev, tab }: { dev: Dev; tab: Tab }) {
  const ex = exposesOf(dev);
  const kind = kindOf(dev, ex);
  const st = stateOf(dev.ieee);
  const av = availOf(dev.ieee).value;
  const sn = snifferOf(dev.ieee).value;
  const area = areaOf(dev.ieee);
  const ha = rooms.value?.dev[dev.ieee];
  const [imgOk, setImgOk] = useState(true);
  const heard = lastHeard(dev);
  const { detail, err } = useDetail(dev);
  const img = dev.model ? `https://www.zigbee2mqtt.io/images/devices/${dev.model.replace(/[/:\s]/g, "-")}.png` : null;
  const hasScenes = Object.values((detail?.endpoints || {}) as Record<string, any>).some((e) => (e.clusters?.input || []).includes("genScenes"));
  const upd = updateState(st.value);
  const coordinator = dev.type === "Coordinator";
  const z2mLink = useDeepLink(windfront.value, `#/device/0/${dev.ieee}/info`);
  const nwk = nwkHex(dev);
  const snLink = useDeepLink(snifferPanel.value, nwk ? `#/device/${nwk}` : "");
  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: "overview", label: "Overview" },
    ...(coordinator && adapter.value ? [{ id: "adapter" as Tab, label: "Network adapter" }] : []),
    ...(snifferPanel.value && dev.nwk !== undefined ? [{ id: "sniffer" as Tab, label: "Signal & traffic" }] : []),
    // the coordinator has no settings of its own, nothing to bind and nothing that reports
    ...(coordinator ? [] : [{ id: "settings" as Tab, label: "Settings" }, { id: "bind" as Tab, label: "Bind" }, { id: "reporting" as Tab, label: "Reporting" }]),
    ...(hasScenes ? [{ id: "scenes" as Tab, label: "Scenes" }] : []),
    ...(dev.ota || upd.state ? [{ id: "firmware" as Tab, label: "Firmware", badge: upd.state === "available" ? "1" : upd.state === "updating" ? `${upd.progress ?? 0}%` : undefined }] : []),
    ...(control.value && dev.type !== "Coordinator" ? [{ id: "console" as Tab, label: "Dev console" }] : []),
    { id: "advanced", label: "Advanced" },
  ];
  const isCoordinator = dev.type === "Coordinator";
  return (
    <div class="page device-page">
      <a class="back" href={href("devices")}><Icon name="back" size={16} /> Devices</a>
      <header class="dev-hero card">
        <div class="dev-img">
          {img && imgOk ? <img src={img} alt="" loading="lazy" onError={() => setImgOk(false)} /> : <Icon name={KIND_ICON[kind]} size={40} />}
        </div>
        <div class="dev-id">
          <h1>{dev.name}</h1>
          <p class="lede">{[area?.name, dev.vendor, dev.model].filter(Boolean).join(" · ")}</p>
          {dev.desc && <p class="muted small">{dev.desc}</p>}
          <div class="chips">
            {av && <Chip tone={av === "online" ? "ok" : "bad"}>{av}</Chip>}
            <Chip tone="muted" title="Link quality of the last message (last hop)"><Lqi v={st.value.linkquality} /></Chip>
            {sn && <Chip tone={HEALTH_TONE[sn.s]} title="Zigbee Sniffer health">{sn.s}</Chip>}
            {sn?.signal !== undefined && sn?.signal !== null && <Chip tone="muted" title={`Signal at ${sn.by || "the sniffer"}`}>{num(sn.signal)} dBm</Chip>}
            {!isCoordinator && <Chip tone="muted" title={heard ? dayClock(heard) : undefined}>heard {ago(heard)}</Chip>}
            <Chip tone="muted">{dev.type === "EndDevice" ? "End device" : dev.type}</Chip>
            {dev.power && <Chip tone="muted">{dev.power}</Chip>}
            {upd.state === "available" && <Chip tone="warn">update available</Chip>}
            {!dev.supported && !isCoordinator && <Chip tone="warn">unsupported</Chip>}
            {dev.disabled && <Chip tone="warn">disabled</Chip>}
            {dev.interview !== "SUCCESSFUL" && !isCoordinator && <Chip tone="warn">interview {dev.interview.toLowerCase().replace("_", " ")}</Chip>}
          </div>
          <div class="links">
            {ha?.id && <Ext href={`/config/devices/device/${ha.id}`}>Home Assistant</Ext>}
            {z2mLink.href && <Ext href={z2mLink.href} newTab={z2mLink.newTab} title={z2mLink.newTab ? "This device in Zigbee2MQTT's own page (new tab)" : undefined}>Zigbee2MQTT</Ext>}
            {snLink.href && (sn || snifferPanel.value) && <Ext href={snLink.href} newTab={snLink.newTab} title={snLink.newTab ? "This device in the Zigbee Sniffer (new tab)" : undefined}>Zigbee Sniffer</Ext>}
          </div>
        </div>
      </header>

      <nav class="subtabs" aria-label="Device sections">
        {tabs.map((t) => (
          <a href={href("device", dev.ieee, t.id)} class={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}{t.badge && <span class="badge">{t.badge}</span>}
          </a>
        ))}
      </nav>
      {err && <p class="note warn"><Icon name="alert" size={16} /> {err}</p>}

      {tab === "overview" && (isCoordinator ? <CoordinatorOverview dev={dev} /> : <Overview dev={dev} ex={ex} />)}
      {tab === "adapter" && isCoordinator && <AdapterTab />}
      {tab === "sniffer" && <SnifferTab dev={dev} />}
      {tab === "settings" && (
        <div class="dev-grid">
          <div class="dev-col"><DeviceSettings dev={dev} ex={ex} /></div>
          <div class="dev-col"><OptionsCard dev={dev} detail={detail} /></div>
        </div>
      )}
      {tab === "bind" && <BindTab dev={dev} detail={detail} />}
      {tab === "reporting" && <ReportingTab dev={dev} detail={detail} />}
      {tab === "scenes" && <ScenesTab dev={dev} detail={detail} />}
      {tab === "firmware" && <FirmwareTab dev={dev} />}
      {tab === "console" && control.value && <ConsoleTab dev={dev} detail={detail} />}
      {tab === "advanced" && <Advanced dev={dev} ex={ex} detail={detail} />}
    </div>
  );
}

// ------------------------------------------------------------------ overview

/** The coordinator is the adapter: what it is, its firmware and the network it runs. */
function CoordinatorOverview({ dev }: { dev: Dev }) {
  const b = bridge.value;
  const n: Record<string, any> = b?.network || {};
  const hexOf = (v: any) => (typeof v === "number" ? "0x" + v.toString(16).padStart(4, "0") : v ?? "—");
  return (
    <div class="dev-grid">
      <div class="dev-col">
        <Card title="Adapter">
          <KV rows={[
            ["Type", b?.coordinator?.type || "—"],
            ["Firmware", b?.coordinator?.revision || "—"],
            ["Driver", b?.adapter || "—"],
            ["IEEE", <code>{dev.ieee}</code>],
            ["Transmit power", b?.transmit_power !== undefined && b?.transmit_power !== null ? `${b.transmit_power} dBm` : "Adapter default"],
          ]} />
        </Card>
        <Card title="Network">
          <KV rows={[
            ["Channel", n.channel ?? "—"],
            ["PAN ID", <code>{hexOf(n.pan_id)}</code>],
            ["Extended PAN ID", n.extended_pan_id ? <code>{String(n.extended_pan_id)}</code> : "—"],
          ]} />
          <p class="muted small">The network key isn't shown: Zigbee2MQTT doesn't share it. Channel and network identity are changed in the Zigbee2MQTT add-on's configuration.</p>
        </Card>
      </div>
      <div class="dev-col">
        <Card title="Zigbee2MQTT">
          <KV rows={[
            ["Version", b?.version || "—"],
            ["zigbee-herdsman", b?.herdsman || "—"],
            ["zigbee-herdsman-converters", b?.zhc || "—"],
          ]} />
        </Card>
        <SnifferCard dev={dev} />
      </div>
    </div>
  );
}

function Overview({ dev, ex }: { dev: Dev; ex: Expose[] }) {
  const st = stateOf(dev.ieee);
  const sec = sections(ex, !control.value);
  const memberOf = groups.value.filter((g) => g.members.some((m) => m.ieee === dev.ieee));
  return (
    <div class="dev-grid">
      <div class="dev-col">
        {sec.controls.length > 0 && (
          <Card title="Controls">
            <div class="controls">{sec.controls.map((e) => <ExposeControl k={dev.ieee} dev={dev} e={e} st={st} />)}</div>
          </Card>
        )}
        {sec.readings.length > 0 && (
          <Card title="Readings">
            <div class="fields">{sec.readings.map((e) => <ExposeControl k={dev.ieee} dev={dev} e={e} st={st} />)}</div>
          </Card>
        )}
        {!sec.controls.length && !sec.readings.length && <Card title="Controls"><Empty>Nothing to control or read on this device.</Empty></Card>}
      </div>
      <div class="dev-col">
        <SnifferCard dev={dev} />
        {memberOf.length > 0 && (
          <Card title="In groups">
            <ul class="plain">{memberOf.map((g) => <li><a href={href("groups")}>{g.name}</a> <span class="muted small">#{g.id}</span></li>)}</ul>
          </Card>
        )}
        <DeviceEvents dev={dev} />
      </div>
    </div>
  );
}

function SnifferCard({ dev }: { dev: Dev }) {
  const sn = snifferOf(dev.ieee).value;
  if (!sn) return null;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num(v)}%`);
  return (
    <Card title={<>Zigbee Sniffer <Chip tone={HEALTH_TONE[sn.s]}>{sn.s}</Chip></>}>
      {sn.findings.length > 0 ? (
        <ul class="findings">{sn.findings.map((f) => <li><Icon name="alert" size={15} />{f}</li>)}</ul>
      ) : (
        <p class="muted small">No findings.</p>
      )}
      <KV rows={[
        ["Signal", sn.signal !== null && sn.signal !== undefined ? `${num(sn.signal)} dBm${sn.by ? ` at ${sn.by}` : ""}` : "—"],
        ["Resent", pct(sn.resent)],
        ["No ACK", pct(sn.noack)],
        ["Lost", pct(sn.lost)],
        ["Next hop", sn.hop || "—"],
        ["Best link cost", sn.cost ?? "—"],
        ["Mesh neighbours", sn.nb ?? "—"],
        ["Messages last hour", sn.msgs ?? "—"],
        ["Last heard", sn.heard ? ago(isoToTs(sn.heard)) : "—"],
      ]} />
    </Card>
  );
}

function DeviceEvents({ dev }: { dev: Dev }) {
  const mine = events.value.filter((e) => e.key === dev.ieee).slice(-12).reverse();
  if (!mine.length) return null;
  return (
    <Card title="Recent events">
      <ul class="events">
        {mine.map((e) => (
          <li><span class="muted">{dayClock(e.ts)}</span> {title(e.type)}{e.state ? `: ${e.state}` : e.status ? `: ${e.status}` : ""}</li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ settings

function DeviceSettings({ dev, ex }: { dev: Dev; ex: Expose[] }) {
  const st = stateOf(dev.ieee);
  const groupsOf = sections(ex, !control.value).config;
  const [open, setOpen] = useState<string | null>(groupsOf[0]?.title ?? null);
  return (
    <Card title="Device settings" actions={control.value ? <RenameButton dev={dev} /> : <Chip tone="muted" icon="lock">read-only</Chip>}>
      {groupsOf.length === 0 ? <Empty>This device has no settings of its own.</Empty> : groupsOf.map((g) => (
        <details class="setting-group" open={open === g.title} onToggle={(e) => (e.target as HTMLDetailsElement).open && setOpen(g.title)}>
          <summary>{g.title} <span class="muted">{g.items.length}</span></summary>
          <div class="fields">{g.items.map((e) => <ExposeControl k={dev.ieee} dev={dev} e={e} st={st} />)}</div>
        </details>
      ))}
    </Card>
  );
}

function RenameButton({ dev }: { dev: Dev }) {
  const rename = async () => {
    const v = await ask({
      title: `Rename ${dev.name}`, confirm: "Rename",
      fields: [{ name: "to", label: "New name", value: dev.name },
        { name: "ha", type: "checkbox", label: "Also rename Home Assistant's entity IDs (automations that use them will break)" }],
    });
    if (!v || !v.to.trim() || v.to.trim() === dev.name) return;
    await write("req", { topic: "device/rename", payload: { from: dev.ieee, to: v.to.trim(), homeassistant_rename: v.ha === "true" } }, `Renamed to ${v.to.trim()}`).catch(() => undefined);
  };
  return <button type="button" class="btn small" onClick={rename}><Icon name="pencil" size={14} /> Rename</button>;
}

// ------------------------------------------------------------------ advanced

function Advanced({ dev, ex, detail }: { dev: Dev; ex: Expose[]; detail: any }) {
  const st = stateOf(dev.ieee);
  const diag = sections(ex, !control.value).diagnostic;
  const h = health.value?.devices[dev.ieee];
  const hb = heardOf(dev.ieee).value;
  const eps = detail ? Object.entries(detail.endpoints || {}) as [string, any][] : [];
  const isCoordinator = dev.type === "Coordinator";
  const remove = async () => {
    const v = await ask({
      title: `Remove ${dev.name}?`, danger: true, confirm: "Remove", typeToConfirm: dev.name,
      body: <>Zigbee2MQTT asks the device to leave and forgets it; it will need pairing again. Its Home Assistant entities go too.</>,
      fields: [
        { name: "force", type: "checkbox", label: "Force: the device is gone or not answering (forget it without asking it to leave)" },
        { name: "block", type: "checkbox", label: "Block: don't let it join again" },
      ],
    });
    if (!v) return;
    await req("device/remove", { id: dev.ieee, force: v.force === "true", block: v.block === "true" }, `${dev.name} removed`, 60).then(() => go("devices")).catch(() => undefined);
  };
  const toggleDisabled = async () => {
    const off = !dev.disabled;
    if (off && !(await confirmIt({
      title: `Disable ${dev.name}?`, confirm: "Disable",
      body: "It stays paired, but Zigbee2MQTT stops using it: no availability checks, no state, and its Home Assistant entities become unavailable. Automations that use it stop working until you enable it again.",
    }))) return;
    req("device/options", { id: dev.ieee, options: { disabled: off } }, off ? `${dev.name} disabled` : `${dev.name} enabled`).catch(() => undefined);
  };
  const interview = async () => {
    if (await confirmIt({ title: `Interview ${dev.name} again?`, body: "Zigbee2MQTT asks the device what it is and what it can do. A sleepy device must be awake (press its button).", confirm: "Interview" })) {
      req("device/interview", { id: dev.ieee }, `${dev.name} interviewed`, 120).catch(() => undefined);
    }
  };
  const reconfigure = async () => {
    if (await confirmIt({ title: `Reconfigure ${dev.name}?`, body: "Sets up its bindings to the coordinator and its reporting again, as at pairing. A sleepy device must be awake.", confirm: "Reconfigure" })) {
      req("device/configure", { id: dev.ieee }, `${dev.name} reconfigured`, 120).catch(() => undefined);
    }
  };
  return (
    <div class="dev-grid">
      <div class="dev-col">
        <Card title="Device">
          <KV rows={[
            ["IEEE", <code>{dev.ieee}</code>],
            ["Network address", <code>{hex(dev.nwk)}</code>],
            ["Model ID", dev.model_id],
            ["Manufacturer", dev.mfr],
            ["Firmware", dev.sw],
            ["Date code", dev.date],
            ["Power", dev.power],
            ["Converter", dev.src],
            ["Interview", dev.interview],
            ["Messages / h", h?.mps !== undefined ? num(h.mps * 3600) : "—"],
            ["Leaves", h?.leaves ?? "—"],
            ["Address changes", h?.nwk_changes ?? "—"],
          ]} />
        </Card>
        {diag.length > 0 && (
          <Card title="Diagnostic">
            <div class="fields">{diag.map((e) => <ExposeControl k={dev.ieee} dev={dev} e={e} st={st} />)}</div>
          </Card>
        )}
        <Card title="State">
          <details class="raw">
            <summary>Raw state from Zigbee2MQTT {hb ? <span class="muted">· updated {ago(hb)}</span> : null}</summary>
            <pre>{JSON.stringify(st.value, null, 2)}</pre>
          </details>
          <button type="button" class="link-btn small" onClick={() => go("logs", dev.name)}>Log lines for this device</button>
        </Card>
      </div>
      <div class="dev-col">
        {control.value && !isCoordinator && (
          <Card title="Actions">
            <div class="actions-list">
              <div><button type="button" class="btn" onClick={interview}><Icon name="refresh" size={14} /> Interview again</button>
                <span class="muted small">Re-read what the device is (after a firmware update, or if it shows unsupported).</span></div>
              <div><button type="button" class="btn" onClick={reconfigure}><Icon name="link" size={14} /> Reconfigure</button>
                <span class="muted small">Redo its coordinator bindings and reporting.</span></div>
              <div><button type="button" class={`btn ${dev.disabled ? "primary" : ""}`} onClick={toggleDisabled}><Icon name="power" size={14} /> {dev.disabled ? "Enable" : "Disable"}</button>
                <span class="muted small">{dev.disabled
                  ? "Disabled: Zigbee2MQTT ignores it and Home Assistant shows it unavailable. Enable to use it again."
                  : "Make Zigbee2MQTT ignore it (no availability checks, no Home Assistant entities) while it stays paired."}</span></div>
              <div><button type="button" class="btn danger" onClick={remove}><Icon name="x" size={14} /> Remove</button>
                <span class="muted small">Make it leave and forget it.</span></div>
            </div>
          </Card>
        )}
        <Card title={<>Endpoints <span class="muted">{eps.length}</span></>}>
          {!detail ? <Empty>Loading…</Empty> : eps.map(([id, ep]) => (
            <div class="ep-block">
              <h4>Endpoint {id}</h4>
              <p class="small"><b>In:</b> {(ep.clusters?.input || []).join(", ") || "—"}</p>
              <p class="small"><b>Out:</b> {(ep.clusters?.output || []).join(", ") || "—"}</p>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
