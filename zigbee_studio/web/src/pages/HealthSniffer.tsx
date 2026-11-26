// The Zigbee Sniffer's view of the whole network on the Health page: traffic over time (ours and
// other networks on the channel, resends) and the incidents it found.

import { useState } from "preact/hooks";
import { ColumnChart, compact } from "../chart";
import { ago, num } from "../format";
import { Icon } from "../icons";
import { href } from "../route";
import { RANGES, type Range, SERIES, nwkHex, useSniffer } from "../sniffer";
import { devices, snifferPanel } from "../store";
import { Card, Chip, Ext, Seg } from "../ui";
import { Incidents } from "./DeviceSniffer";

export function SnifferTraffic() {
  const [range, setRange] = useState<Range>("24h");
  const { data: o, err, loading } = useSniffer("/api/overview", { range }, 60);
  const { data: st } = useSniffer("/api/status", {}, 30);
  if (!snifferPanel.value) return null;
  const net: number[][] = o?.net || [];
  const t = o?.totals;
  const sniffers: any[] = st?.sniffers || [];
  const up = sniffers.filter((s) => s.connected).length;
  return (
    <>
      <Card title="Zigbee traffic" class={`wide ${loading ? "refreshing" : ""}`}
        actions={<Seg label="Time range" value={range} onChange={setRange} options={RANGES} />}>
        {err && !o && <p class="note warn"><Icon name="alert" size={16} /> {err}</p>}
        {o && (
          <>
            <p class="muted small">
              {sniffers.length ? `${up} of ${sniffers.length} sniffer${sniffers.length > 1 ? "s" : ""} listening` : "Zigbee Sniffer"}
              {st?.channel ? ` on channel ${st.channel}` : ""}{st?.fps !== undefined ? ` · ${num(st.fps)} frames/s now` : ""}
              {t ? ` · ${compact(t.ours)} frames of ours, ${compact(t.others)} from other networks · ${t.uni ? num((100 * t.retry) / t.uni) : 0}% resent` : ""}
              {" · "}<Ext href={snifferPanel.value}>Zigbee Sniffer</Ext>
            </p>
            <ColumnChart xs={net.map((r) => r[0])} x0={o.now - o.span} x1={o.now} bucket={o.bucket} label="Frames on the channel"
              stacks={[
                { name: "Our network", color: SERIES[0], values: net.map((r) => r[1] || 0) },
                { name: "Other networks", color: SERIES[1], values: net.map((r) => r[2] || 0) },
              ]}
              extras={[
                { name: "resent (ours)", values: net.map((r) => r[7]) },
                { name: "without an ACK heard", values: net.map((r) => r[8]) },
                { name: "% of the air ours", values: net.map((r) => (r[5] ? (100 * r[4]) / r[5] : null)), format: (v) => `${Math.round(v)}%` },
              ]} />
          </>
        )}
      </Card>
    </>
  );
}

export function SnifferIncidents() {
  const { data: o } = useSniffer("/api/overview", { range: "24h" }, 60);
  if (!snifferPanel.value || !o) return null;
  return (
    <Card title={<>Incidents <span class="muted">{(o.incidents || []).length}</span></>}>
      <Incidents list={o.incidents || []} empty="No network-wide trouble in the last 24 hours." />
    </Card>
  );
}

const SEV: Record<string, number> = { high: 3, warn: 2, info: 1 };
const SEV_TONE: Record<string, "bad" | "warn" | "muted"> = { high: "bad", warn: "warn", info: "muted" };
const SEV_WORD: Record<string, string> = { high: "serious", warn: "warning", info: "note" };

/** What the Sniffer finds about the network as a whole (busy channel, resends, PAN conflicts, no
 *  key...), the devices it warns about, and the other networks it hears on our channel. */
export function SnifferFindings() {
  const { data: o } = useSniffer("/api/overview", { range: "24h" }, 60);
  if (!snifferPanel.value || !o) return null;
  const att: any[] = o.attention || [];
  const net = att.filter((a) => !a.addr && a.code !== "incident");
  const devs = att.filter((a) => a.addr && (SEV[a.sev] ?? 0) >= 2);
  const nets: any[] = o.networks || [];
  const byNwk = new Map(devices.value.map((d) => [nwkHex(d), d]));
  return (
    <Card title="The Sniffer's findings" class="wide">
      {net.length === 0 ? <p class="ok-text"><Icon name="check" size={16} /> Nothing network-wide in the last 24 hours.</p> : (
        <ul class="sn-findings">
          {net.map((a) => (
            <li><Chip tone={SEV_TONE[a.sev] || "muted"}>{SEV_WORD[a.sev] || a.sev}</Chip> <b>{a.name}</b> <span>{a.text}</span></li>
          ))}
        </ul>
      )}
      {devs.length > 0 && (
        <>
          <h4>Devices it warns about <span class="muted">{devs.length}</span></h4>
          <ul class="sn-findings">
            {devs.slice(0, 12).map((a) => {
              const d = byNwk.get(String(a.addr).toLowerCase());
              return (
                <li><Chip tone={SEV_TONE[a.sev] || "muted"}>{SEV_WORD[a.sev] || a.sev}</Chip>{" "}
                  {d ? <a href={href("device", d.ieee, "sniffer")}>{d.name}</a> : <b>{a.name}</b>} <span>{a.text}</span></li>
              );
            })}
          </ul>
          {devs.length > 12 && <p class="muted small">and {devs.length - 12} more in the <Ext href={snifferPanel.value}>Zigbee Sniffer</Ext></p>}
        </>
      )}
      {nets.length > 0 && (
        <>
          <h4>Other networks on the channel <span class="muted">{nets.length}</span></h4>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>PAN</th><th class="num">Share of frames</th><th class="num">Devices</th><th class="num">Signal</th><th>Last heard</th></tr></thead>
              <tbody>
                {nets.map((n) => (
                  <tr><td class="mono">{n.pan || "unknown"}</td><td class="num">{num(n.share)}%</td><td class="num">{n.devices}</td>
                    <td class="num">{num(n.rssi_avg)} dBm</td><td>{ago(n.last_seen)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted small">Neighbours' Zigbee (or Thread) on our channel share the air with us; a busy neighbour is a reason to change channel.</p>
        </>
      )}
    </Card>
  );
}
