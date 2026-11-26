// Network health: bridge, coordinator, availability, the Sniffer's verdicts, weak links,
// chatty devices and recent events, on one page.

import { bridge, health, devices, devByKey, counts, snifferCounts, availOf, snifferOf, stateOf, events, control } from "../store";
import { write } from "../conn";
import { ago, dayClock, duration, num, title } from "../format";
import { href } from "../route";
import { Card, Chip, Empty, HEALTH_TONE, KV, Lqi, Stat } from "../ui";
import { Icon } from "../icons";
import { lastHeard } from "./Devices";
import { SnifferFindings, SnifferIncidents, SnifferTraffic } from "./HealthSniffer";
import { AdapterStat } from "./Adapter";

export function Health() {
  const b = bridge.value;
  const h = health.value;
  const c = counts.value;
  const sc = snifferCounts.value;
  const devs = devices.value.filter((d) => d.type !== "Coordinator");
  const offline = devs.filter((d) => availOf(d.ieee).value === "offline");
  const flagged = devs
    .map((d) => ({ d, s: snifferOf(d.ieee).value }))
    .filter((x) => x.s && (x.s.s === "warning" || x.s.s === "problem"))
    .sort((a, b) => (a.s!.s === "problem" ? -1 : 0) - (b.s!.s === "problem" ? -1 : 0));
  const weak = devs
    .map((d) => ({ d, lqi: stateOf(d.ieee).value.linkquality as number | undefined, sig: snifferOf(d.ieee).value?.signal }))
    .filter((x) => (x.lqi !== undefined && x.lqi < 60) || (x.sig !== undefined && x.sig !== null && x.sig < -85))
    .sort((a, b) => (a.lqi ?? 255) - (b.lqi ?? 255));
  const talkers = h ? Object.entries(h.devices).filter(([, v]) => v.mps).sort((a, b) => (b[1].mps || 0) - (a[1].mps || 0)).slice(0, 8) : [];
  const leavers = h ? Object.entries(h.devices).filter(([, v]) => (v.leaves || 0) > 0 || (v.nwk_changes || 0) > 0) : [];
  const recent = events.value.slice(-25).reverse();
  const name = (ieee: string) => devByKey.value.get(ieee)?.name || ieee;
  const permit = async () => {
    const on = !b?.permit_join;
    await write("req", { topic: "permit_join", payload: { time: on ? 240 : 0 } }, on ? "Joining allowed for 4 minutes" : "Joining closed").catch(() => undefined);
  };
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Network health</h1>
          <p class="lede">Zigbee2MQTT {b?.version} · {b?.coordinator.type} {b?.coordinator.revision} · channel {b?.network.channel}</p>
        </div>
        <div class="toolbar">
          {control.value && (
            <button type="button" class={`btn ${b?.permit_join ? "primary" : ""}`} onClick={permit}>
              <Icon name="plus" size={15} /> {b?.permit_join ? "Stop joining" : "Permit join"}
            </button>
          )}
        </div>
      </div>

      <div class="stats">
        <Stat label="Bridge" value={b?.state === "online" && b.connected ? "Online" : "Offline"} tone={b?.state === "online" && b.connected ? "ok" : "bad"}
          sub={h?.process.uptime_sec ? `up ${duration(h.process.uptime_sec)}` : undefined} />
        <Stat label="Devices online" value={`${c.online}/${c.total}`} tone={c.offline ? "warn" : "ok"} sub={`${c.routers} routers · ${c.ends} end devices`} />
        <Stat label="Sniffer" value={Object.keys(sc).length ? `${sc.ok || 0} ok` : "—"} tone={(sc.problem || 0) ? "bad" : (sc.warning || 0) ? "warn" : "ok"}
          sub={Object.keys(sc).length ? ["problem", "warning", "note", "not heard"].filter((k) => sc[k]).map((k) => `${sc[k]} ${k}`).join(" · ") || "no findings" : "no Zigbee Sniffer sensors"} />
        <Stat label="MQTT" value={h?.mqtt.connected ? "Connected" : "—"} tone={h?.mqtt.connected ? "ok" : "warn"}
          sub={h ? `${num(h.mqtt.published)} out · ${num(h.mqtt.received)} in · ${h.mqtt.queued ?? 0} queued` : undefined} />
        <AdapterStat />
      </div>

      {b?.restart_required && <p class="note warn"><Icon name="alert" size={16} /> Zigbee2MQTT needs a restart to apply a setting.</p>}
      {b?.permit_join && <p class="note"><Icon name="info" size={16} /> Joining is open{b.permit_join_end ? ` until ${dayClock(b.permit_join_end / 1000)}` : ""}.</p>}

      <SnifferTraffic />
      <SnifferFindings />
      <div class="masonry">
        <SnifferIncidents />
        <Card title={<>Offline <span class="muted">{offline.length}</span></>}>
          {offline.length === 0 ? <Empty>Everything is online.</Empty> : (
            <ul class="plain">{offline.map((d) => <li><a href={href("device", d.ieee)}>{d.name}</a> <span class="muted">last heard {ago(lastHeard(d))}</span></li>)}</ul>
          )}
        </Card>
        <Card title={<>Sniffer findings <span class="muted">{flagged.length}</span></>}>
          {flagged.length === 0 ? <Empty>No warnings or problems.</Empty> : (
            <ul class="plain">
              {flagged.map(({ d, s }) => (
                <li><a href={href("device", d.ieee)}>{d.name}</a> <Chip tone={HEALTH_TONE[s!.s]}>{s!.s}</Chip>
                  <div class="muted small">{s!.findings.join(" · ")}</div></li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={<>Weak links <span class="muted">{weak.length}</span></>}>
          {weak.length === 0 ? <Empty>No weak links (LQI under 60 or signal under −85 dBm).</Empty> : (
            <ul class="plain">{weak.map((x) => <li><a href={href("device", x.d.ieee)}>{x.d.name}</a> <Lqi v={x.lqi} />{x.sig !== undefined && x.sig !== null && <span class="muted"> · {num(x.sig)} dBm</span>}</li>)}</ul>
          )}
        </Card>
        <Card title="Busiest devices">
          {talkers.length === 0 ? <Empty>No health report yet.</Empty> : (
            <ul class="plain">{talkers.map(([ieee, v]) => <li><a href={href("device", ieee)}>{name(ieee)}</a> <span class="muted">{num((v.mps || 0) * 3600)} msgs/h</span></li>)}</ul>
          )}
          {leavers.length > 0 && (
            <>
              <h4>Leaves and address changes</h4>
              <ul class="plain">{leavers.map(([ieee, v]) => <li><a href={href("device", ieee)}>{name(ieee)}</a> <span class="muted">{v.leaves || 0} leaves · {v.nwk_changes || 0} address changes</span></li>)}</ul>
            </>
          )}
        </Card>
        <Card title="Recent events">
          {recent.length === 0 ? <Empty>No joins, leaves or availability changes since the add-on started.</Empty> : (
            <ul class="events">{recent.map((e) => (
              <li><span class="muted">{dayClock(e.ts)}</span> {title(e.type)}{" "}
                {e.key ? <a href={href("device", e.key)}>{e.friendly_name || name(e.key)}</a> : e.friendly_name}
                {e.state ? ` → ${e.state}` : e.status ? ` (${e.status})` : ""}</li>
            ))}</ul>
          )}
        </Card>
        <Card title="Bridge">
          <KV rows={[
            ["Zigbee2MQTT", b?.version],
            ["Herdsman / converters", `${b?.herdsman ?? "—"} / ${b?.zhc ?? "—"}`],
            ["Coordinator", `${b?.coordinator.type ?? "—"} ${b?.coordinator.revision ?? ""}`],
            ["Adapter", b?.adapter],
            ["Channel / PAN", `${b?.network.channel ?? "—"} / ${b?.network.pan_id ?? "—"}`],
            ["Transmit power", b?.transmit_power !== undefined ? `${b.transmit_power} dBm` : "—"],
            ["Availability", b?.availability ? "On" : "Off"],
            ["Log level", b?.log_level],
            ["External extensions", b?.extensions.join(", ") || "—"],
            ["External converters", b?.converters.join(", ") || "—"],
            ["Host", b?.os.cpus],
            ["Node.js", b?.os.node_version],
            ["Last health report", h?.response_time ? ago(h.response_time > 1e11 ? h.response_time / 1000 : h.response_time) : "—"],
          ]} />
        </Card>
      </div>
    </div>
  );
}
