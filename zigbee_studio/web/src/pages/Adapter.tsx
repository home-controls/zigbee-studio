// The network adapter (a Zigbee Ethernet bridge serving the coordinator over TCP): live health,
// traffic and response time on the coordinator's page; the link and the few changes Studio
// makes under Settings. Network, port, baud, firmware and its password stay on its own page.

import { useState } from "preact/hooks";
import { adapter, control, devices } from "../store";
import { call, toast } from "../conn";
import { confirmIt } from "../dialog";
import { LineChart, type XY } from "../chart";
import { Card, Chip, Empty, KV, Lqi, Search, Stat } from "../ui";
import { Icon } from "../icons";
import { href } from "../route";
import { ago, dayClock, duration, matches, num } from "../format";
import { adapterSet, atUptime, bytes, lastN, slStatus, useAdapter } from "../adapter";
import { devByNwk } from "../sniffer";
import type { AdapterDevice, AdapterEvent, AdapterHistory, AdapterStatus } from "../types";

const BUCKET = 10;

function buckets(h: AdapterHistory, nowUp: number, col: keyof AdapterHistory, how: "sum" | "avg" | "max" | "avgNZ"): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < h.t.length; i += BUCKET) {
    const sl = h[col].slice(i, i + BUCKET);
    let v: number;
    if (how === "sum") v = sl.reduce((a, b) => a + b, 0);
    else if (how === "max") v = Math.max(0, ...sl);
    else if (how === "avg") v = sl.reduce((a, b) => a + b, 0) / sl.length;
    else {
      const nz = sl.filter((x) => x > 0);
      v = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    }
    out.push([atUptime(nowUp, h.t[Math.min(i + BUCKET, h.t.length) - 1]), v, null, null]);
  }
  return out;
}

const tone = (score: number) => (score >= 85 ? "ok" : score >= 60 ? "warn" : "bad");

function NotLinked() {
  const a = adapter.value;
  return (
    <Card title={<><Icon name="router" size={18} /> Network adapter</>}>
      <p class="muted" style={{ marginTop: 0 }}>
        {a?.suggested
          ? <>Zigbee2MQTT reaches its adapter over the network at <code>{a.suggested}</code>. Link Zigbee Studio to it to see its health, traffic and response time here.</>
          : <>If the coordinator sits on a network adapter (a Zigbee Ethernet bridge), link Zigbee Studio to it to see its health, traffic and response time here.</>}
      </p>
      <a class="btn primary" href={href("settings", "adapter")}><Icon name="link" size={15} /> Link the adapter</a>
    </Card>
  );
}

function linkOf(host: string | null | undefined) {
  return host ? <a class="ext" href={`http://${host}/`} target="_blank" rel="noopener">{host} <Icon name="external" size={13} /></a> : "—";
}

/** The coordinator's "Network adapter" tab. */
export function AdapterTab() {
  const a = adapter.value;
  const st = useAdapter<AdapterStatus>("status", {}, 3);
  const hi = useAdapter<AdapterHistory>("history", {}, 10);
  const ev = useAdapter<{ events: AdapterEvent[] }>("events", {}, 10);
  if (!a?.linked) return <NotLinked />;
  const s = st.data;
  if (!s) return st.err ? <p class="note warn"><Icon name="alert" size={16} /> {st.err}</p> : <Empty>Loading…</Empty>;
  const h = hi.data;
  const k = s.counters;
  const ok = lastN(h, "ok", 300), fail = lastN(h, "fail", 300);
  const pct = ok + fail ? (ok / (ok + fail)) * 100 : null;
  let rs = 0, rn = 0, rmax = 0;
  if (h) for (let i = Math.max(0, h.t.length - 60); i < h.t.length; i++) { if (h.rtt[i]) { rs += h.rtt[i]; rn++; } rmax = Math.max(rmax, h.rttmax[i]); }
  const x1 = Date.now() / 1000, x0 = x1 - 900;
  const linkErrs = k.host.crc_err + k.ncp.crc_err + k.host.nak + k.ncp.nak + k.host.retx + k.ncp.retx + k.ncp.error;
  const events = (ev.data?.events || []).slice(-12).reverse();
  return (
    <>
      {st.err && <p class="note warn"><Icon name="alert" size={16} /> {st.err} (showing the last answer)</p>}
      <div class="stats">
        <Stat label="Adapter health" value={s.health.score} tone={tone(s.health.score)} sub={s.health.reason} />
        <Stat label="Zigbee2MQTT link" value={s.client.connected ? "Connected" : "Waiting"} tone={s.client.connected ? "ok" : "bad"}
          sub={s.client.connected ? `from ${s.client.ip} · ${duration(s.uptime - s.client.since)}` : `tcp/${s.client.tcp_port}`} />
        <Stat label="Delivery (5 min)" value={pct === null ? "—" : `${pct >= 99.95 ? "100" : pct.toFixed(1)} %`}
          tone={pct === null ? "" : pct >= 98 ? "ok" : pct >= 90 ? "warn" : "bad"} sub={`${num(ok)} ok · ${num(fail)} failed`} />
        <Stat label="Response time (1 min)" value={rn ? `${(rs / rn).toFixed(1)} ms` : "—"} sub={rn ? `slowest ${Math.round(rmax)} ms` : "no commands"} />
      </div>
      <div class="grid two">
        <Card title="Zigbee traffic" actions={<span class="muted small">per {BUCKET} s, as the adapter counts it</span>}>
          {h && h.t.length > 1 ? (
            <LineChart zero label="Zigbee messages" x0={x0} x1={x1} height={180} series={[
              { name: "Received", color: "var(--series-1)", points: buckets(h, s.uptime, "rx", "sum") },
              { name: "Delivered", color: "var(--series-3)", points: buckets(h, s.uptime, "ok", "sum") },
              { name: "Failed", color: "var(--bad)", points: buckets(h, s.uptime, "fail", "sum") },
            ]} />
          ) : <Empty>Collecting…</Empty>}
        </Card>
        <Card title="Coordinator response time" actions={<span class="muted small">Zigbee2MQTT command to answer</span>}>
          {h && h.t.length > 1 ? (() => {
            const avg = buckets(h, s.uptime, "rtt", "avgNZ"), mx = buckets(h, s.uptime, "rttmax", "max");
            return <LineChart zero label="Response time" unit="ms" x0={x0} x1={x1} height={180}
              series={[{ name: "Average", color: "var(--series-2)", points: avg.map((p, i) => [p[0], p[1], p[1], mx[i][1]] as XY) }]}
              refs={[{ y: 50, color: "var(--warn)", label: "50 ms" }]} />;
          })() : <Empty>Collecting…</Empty>}
        </Card>
      </div>
      <div class="masonry" style={{ marginTop: "16px" }}>
        <Card title={<><Icon name="router" size={18} /> Adapter</>} actions={linkOf(a.host)}>
          <KV rows={[
            ["Dongle", s.dongle.open ? `${s.dongle.product}` : <span class="bad-text">not connected</span>],
            ["Serial", s.dongle.serial ? <code>{s.dongle.serial}</code> : "—"],
            ["Coordinator", s.ncp.stack ? `EmberZNet ${s.ncp.stack} · EZSP ${s.ncp.ezsp}` : "—"],
            ["Zigbee network", s.ncp.network === "up" ? <span class="ok-text">up</span> : s.ncp.network === "down" ? <span class="bad-text">down</span> : "unknown"],
            ["Ethernet", s.eth.link ? `${s.eth.speed} Mbps · ${s.eth.ip}` : <span class="bad-text">link down</span>],
            ["Firmware", `${s.fw.version}${s.fw.pending_verify ? " (on trial)" : ""}`],
            ["Up", s.sys.watchdog ? <span class="warn-text">{duration(s.uptime)} · restarted by its watchdog: {s.sys.watchdog}</span>
              : `${duration(s.uptime)} · last reboot: ${s.sys.reset_reason.toLowerCase()}`],
            ["Chip", `${s.sys.temp_c.toFixed(1)} °C`],
          ]} />
        </Card>
        <Card title="Serial link">
          <KV rows={[
            ["Moved", `${bytes(k.ncp.bytes)} in · ${bytes(k.host.bytes)} out`],
            ["Link errors", linkErrs ? <span class="warn-text">{num(linkErrs)}</span> : <span class="ok-text">none</span>],
            ["Retransmits", `${num(k.host.retx)} out · ${num(k.ncp.retx)} in`],
            ["CRC errors / NAKs", `${num(k.host.crc_err + k.ncp.crc_err)} / ${num(k.host.nak + k.ncp.nak)}`],
            ["ASH ack time", k.ack_avg_ms ? `${k.ack_avg_ms.toFixed(1)} ms avg · ${Math.round(k.ack_max_ms)} ms max` : "—"],
            ["Sessions", `${num(k.clients_accepted)} · ${num(k.clients_refused)} refused · ${num(k.client_drops)} dropped`],
          ]} />
        </Card>
        <Card title="Zigbee, as the adapter saw it" actions={<span class="muted small">since {dayClock(atUptime(s.uptime, s.stats_since))}</span>}>
          <KV rows={[
            ["Received", num(k.zb_rx)],
            ["Sent", `${num(k.zb_unicast)} unicast · ${num(k.zb_broadcast)} broadcast`],
            ["Delivered / failed", `${num(k.zb_sent_ok)} / ${num(k.zb_sent_fail)}`],
            ["Route errors", num(k.route_errors)],
            ["Joins / leaves", `${num(k.joins)} / ${num(k.leaves)}`],
            ["Response time", k.rtt_n ? `${k.rtt_avg_ms.toFixed(1)} ms avg · ${Math.round(k.rtt_max_ms)} ms max` : "—"],
          ]} />
        </Card>
        <Card title="Adapter events">
          {events.length === 0 ? <Empty>Nothing yet.</Empty> : (
            <ul class="plain">
              {events.map((e) => (
                <li class={e.level === 2 ? "bad-text" : e.level === 1 ? "warn-text" : ""}>
                  <span class="muted small">{dayClock(e.epoch || atUptime(s.uptime, e.up))}</span> {e.text}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <HeardTable nowUp={s.uptime} />
    </>
  );
}

function rssiTone(v: number) {
  return v >= -70 ? "ok" : v >= -82 ? "warn" : "bad";
}

/** Devices the coordinator heard, with Zigbee2MQTT's names (matched by network address). */
function HeardTable({ nowUp }: { nowUp: number }) {
  const r = useAdapter<{ uptime: number; devices: AdapterDevice[] }>("devices", {}, 10);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"name" | "rssi" | "succ" | "rx">("rssi");
  devices.value; // re-render when names change
  const rows = (r.data?.devices || []).map((d) => {
    const dev = devByNwk.value.get(d.short);
    const tx = d.tx_ok + d.tx_fail;
    return { d, dev, name: dev?.name || d.short, succ: tx ? d.tx_ok / tx : -1, tx };
  }).filter((x) => matches(q, x.name, x.d.short, x.d.ieee));
  rows.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true })
    : sort === "rssi" ? a.d.rssi_avg - b.d.rssi_avg : sort === "succ" ? a.succ - b.succ : b.d.rx - a.d.rx);
  const th = (k: typeof sort, label: string, numCol = false) => (
    <th class={numCol ? "num" : ""}><button type="button" onClick={() => setSort(k)}>{label}{sort === k && <span class="sort">▲</span>}</button></th>
  );
  return (
    <Card class="wide" title={<><Icon name="signal" size={18} /> Heard by the coordinator</>}
      actions={<Search value={q} onInput={setQ} placeholder="Filter" />}>
      <p class="muted small" style={{ marginTop: 0 }}>The last hop into the coordinator, so a device behind a router shows that router's link. Weakest first.</p>
      {!r.data ? <Empty>{r.err || "Loading…"}</Empty> : rows.length === 0 ? <Empty>No traffic yet.</Empty> : (
        <div class="table-wrap">
          <table class="devices compact">
            <thead><tr>{th("name", "Device")}{th("rssi", "Signal")}<th>LQI</th>{th("rx", "Messages", true)}<th class="num">Last heard</th>{th("succ", "Delivery", true)}</tr></thead>
            <tbody>
              {rows.map(({ d, dev, name, succ, tx }) => (
                <tr>
                  <td><div class="cell-name">{dev ? <a href={href("device", dev.ieee)}>{name}</a> : <code>{name}</code>}{dev && <small><code>{d.short}</code></small>}</div></td>
                  <td>{d.rx ? <span class={`lqi ${rssiTone(d.rssi_avg)}`}>{d.rssi_avg} dBm</span> : "—"}</td>
                  <td>{d.rx ? <Lqi v={d.lqi_avg} /> : "—"}</td>
                  <td class="num">{num(d.rx)}</td>
                  <td class="num">{d.rx ? ago(atUptime(nowUp, d.last)) : "—"}</td>
                  <td class="num">{succ < 0 ? "—" : (
                    <span title={d.tx_fail ? `last failure: ${slStatus(d.last_fail_status)}` : undefined}>
                      <Chip tone={succ >= 0.98 ? "ok" : succ >= 0.9 ? "warn" : "bad"}>{(succ * 100).toFixed(succ >= 0.999 ? 0 : 1)} %</Chip>
                      <span class="muted small"> {num(tx)}</span>
                    </span>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Settings, "Network adapter": the link, and the changes Studio makes on the adapter. */
export function AdapterSettings() {
  const a = adapter.value;
  const st = useAdapter<AdapterStatus>("status", {}, 5);
  const [host, setHost] = useState(a?.host || a?.suggested || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [allow, setAllow] = useState<string | null>(null);
  if (!a) return <Empty>This Zigbee Studio has no network adapter support.</Empty>;
  const s = st.data;

  const link = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await call("adapter_link", { host, token });
      setToken("");
      toast("ok", `Linked to the adapter at ${host} (firmware ${r?.fw?.version ?? "?"})`, 4000);
    } catch (x: any) {
      toast(x.message?.includes("read-only") ? "warn" : "error", x.message || String(x), 8000);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async () => {
    if (!await confirmIt({ title: "Unlink the network adapter?", confirm: "Unlink", body: "Zigbee Studio forgets its address and token. The adapter itself keeps working; Zigbee2MQTT doesn't notice." })) return;
    try { await call("adapter_unlink"); toast("ok", "Unlinked"); } catch (x: any) { toast("error", x.message); }
  };
  const saveAllow = async () => {
    try { await adapterSet("allow", { allow: (allow ?? "").trim() }, "Allowed host saved on the adapter"); setAllow(null); st.reload(); } catch { /* toasted */ }
  };
  const reboot = async () => {
    if (!await confirmIt({ title: "Reboot the network adapter?", confirm: "Reboot", body: "Zigbee2MQTT loses its coordinator for about 10 seconds and reconnects by itself; devices keep working meanwhile." })) return;
    try { await adapterSet("reboot", {}, "The adapter is rebooting"); } catch { /* toasted */ }
  };
  const reset = async () => {
    if (!await confirmIt({ title: "Reset the adapter's statistics?", confirm: "Reset", body: "Its counters, charts and the devices it heard start again from zero." })) return;
    try { await adapterSet("stats_reset", {}, "Statistics reset"); } catch { /* toasted */ }
  };

  return (
    <div class="grid two">
      <Card title={<><Icon name="link" size={18} /> Link</>} actions={a.linked ? <Chip tone={a.error ? "warn" : "ok"}>{a.error ? "trouble" : "linked"}</Chip> : <Chip>not linked</Chip>}>
        {a.linked ? (
          <>
            <KV rows={[
              ["Adapter", linkOf(a.host)],
              ["Last answer", a.ok_at ? ago(a.ok_at) : "—"],
              ["Firmware", s ? s.fw.version : "—"],
            ]} />
            {a.error && <p class="note warn"><Icon name="alert" size={16} /> {a.error}</p>}
            <div class="row-btns">
              <a class="btn" href={href("device", devices.value.find((d) => d.type === "Coordinator")?.ieee || "", "adapter")}><Icon name="health" size={15} /> Live view</a>
              {control.value && <button type="button" class="btn" onClick={unlink}>Unlink</button>}
            </div>
          </>
        ) : null}
        {(!a.linked || control.value) && (
          <form class="form-grid one" onSubmit={link} style={{ marginTop: a.linked ? "14px" : 0 }}>
            {!a.linked && <p class="muted small" style={{ margin: 0 }}>On the adapter's own page (open its address in a browser): create its admin password, then Settings, API access, Create token. Paste the token here; Zigbee Studio keeps it and never shows it again.</p>}
            <label>Adapter address
              <input value={host} placeholder={a.suggested || "192.168.1.50"} onInput={(e) => setHost((e.target as HTMLInputElement).value)} />
              {a.suggested && !a.linked && <span class="field-help">Zigbee2MQTT reaches its adapter at {a.suggested}.</span>}
            </label>
            <label>API token
              <input type="password" autoComplete="off" value={token} placeholder="64 characters" onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
            </label>
            <div><button class="btn primary" disabled={busy || !host || !token || !control.value}
              title={control.value ? undefined : "Read-only: turn on Allow control in the add-on's configuration"}>
              {a.linked ? "Link again" : "Link"}</button></div>
          </form>
        )}
      </Card>

      {a.linked && (
        <Card title={<><Icon name="gear" size={18} /> On the adapter</>}>
          {!s ? <Empty>{st.err || "Loading…"}</Empty> : (
            <>
              <div class="form-grid one">
                <label>Allowed Zigbee2MQTT host
                  <input value={allow ?? s.client.allowed} placeholder="anyone" disabled={!control.value}
                    onInput={(e) => setAllow((e.target as HTMLInputElement).value)} />
                  <span class="field-help">Only this address (or range) may connect to tcp/{s.client.tcp_port}. Zigbee Studio refuses a value that would shut out {s.client.connected ? `Zigbee2MQTT at ${s.client.ip}` : "Zigbee2MQTT"}.</span>
                </label>
              </div>
              <div class="row-btns">
                <button type="button" class="btn primary" disabled={!control.value || allow === null || allow.trim() === s.client.allowed} onClick={saveAllow}>Save</button>
                <button type="button" class="btn" disabled={!control.value} onClick={reboot}><Icon name="power" size={15} /> Reboot</button>
                <button type="button" class="btn" disabled={!control.value} onClick={reset}><Icon name="refresh" size={15} /> Reset statistics</button>
              </div>
              <h4>Set on the adapter's own page</h4>
              <KV rows={[
                ["Address", `${s.eth.ip} (${s.eth.mode === "static" ? "static" : "DHCP"}) · ${s.eth.hostname}.local`],
                ["TCP port", `${s.client.tcp_port}`],
                ["Dongle baud rate", num(s.dongle.baud)],
                ["Firmware", s.fw.version],
              ]} />
              <p class="muted small">Network, port, baud, firmware updates and the adapter's password change only on {linkOf(a.host)}: a slip there would cut Zigbee2MQTT off from its coordinator.</p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

/** One line for the Health page. */
export function AdapterStat() {
  const a = adapter.value;
  const st = useAdapter<AdapterStatus>("status", {}, 10);
  if (!a?.linked) return null;
  const s = st.data;
  return (
    <Stat label="Network adapter" value={s ? s.health.score : "—"} tone={s ? tone(s.health.score) : st.err ? "warn" : ""}
      sub={s ? `${s.health.reason} · ${s.client.connected ? "Zigbee2MQTT connected" : "no Zigbee2MQTT"}` : st.err || "…"} />
  );
}
