// A device's history from the Zigbee Sniffer: signal per sniffer against its normal, traffic and
// resends, its route to the coordinator, the neighbours it resends to, its mesh neighbours and
// link costs, incidents it was part of, events and the latest frames.

import { useState } from "preact/hooks";
import { ColumnChart, LineChart, type LineSeries, type RefLine } from "../chart";
import { ago, clock, num } from "../format";
import { Icon } from "../icons";
import { href } from "../route";
import { devByNwk, nwkHex, RANGES, type Range, SERIES, SEV_TONE, useSniffer } from "../sniffer";
import { snifferPanel } from "../store";
import type { Dev } from "../types";
import { Card, Chip, Empty, Ext, Seg, Stat } from "../ui";

const BROADCAST: Record<string, string> = { "0xffff": "everyone", "0xfffd": "everyone awake", "0xfffc": "all routers", "0xfffb": "low-power routers" };
const isBroadcast = (a?: string) => !!a && a in BROADCAST;

export function Who({ addr, name }: { addr?: string; name?: string | null }) {
  const d = addr ? devByNwk.value.get(addr) : undefined;
  const label = d?.name || name || (addr && BROADCAST[addr]) || addr || "?";
  return d ? <a href={href("device", d.ieee, "sniffer")}>{label}</a> : <span>{label}</span>;
}

function Path({ hops }: { hops: ({ addr: string; name?: string } | null)[] }) {
  return (
    <span class="hops">
      {hops.map((h, i) => <>{i > 0 && <Icon name="chevron" size={12} />}{h ? <Who addr={h.addr} name={h.name} /> : <span class="muted" title="A router the Sniffer didn't hear name itself">unknown</span>}</>)}
    </span>
  );
}

/** Hour and minute ("9:07 PM"); with the day when it isn't today. */
export function hm(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function when(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString() ? hm(ts)
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Events newest first, a run of the same event (what and detail) as one row with a count. */
function runs(events: any[]): { ts: number; first?: number; what: string; detail: string; n: number }[] {
  const out: { ts: number; first?: number; what: string; detail: string; n: number }[] = [];
  for (const e of events) {
    const what = e.what || e.kind, detail = e.detail || "";
    const last = out[out.length - 1];
    if (last && last.what === what && last.detail === detail) {
      last.n += 1;
      last.first = e.ts;
    } else out.push({ ts: e.ts, what, detail, n: 1 });
  }
  return out;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}%`);

export function Incidents({ list, empty }: { list: any[]; empty: string }) {
  const [all, setAll] = useState(false);
  if (!list?.length) return <Empty>{empty}</Empty>;
  const newest = [...list].sort((a, b) => b.start - a.start);
  return (
    <>
    <ul class="plain incidents">
      {(all ? newest : newest.slice(0, 6)).map((i) => (
        <li>
          <div><Chip tone={SEV_TONE[i.sev] || "muted"}>{i.sev}</Chip> <b>{i.title}</b></div>
          <div class="muted small">{when(i.start)}{i.end ? `–${hm(i.end)}` : " (ongoing)"} · {i.detail}{i.cause ? ` · ${i.cause}` : ""}</div>
          {i.devices?.length > 0 && (
            <div class="small">{i.devices.slice(0, 12).map((d: any, k: number) => <>{k > 0 && ", "}<Who addr={d.addr} name={d.name} /></>)}
              {i.devices.length > 12 && <span class="muted"> and {i.devices.length - 12} more</span>}</div>
          )}
        </li>
      ))}
    </ul>
    {newest.length > 6 && <button type="button" class="link-btn small" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${newest.length}`}</button>}
    </>
  );
}

export function Frames({ frames, me }: { frames: any[]; me?: string }) {
  if (!frames?.length) return <Empty>No frames in the live buffer.</Empty>;
  return (
    <div class="table-wrap">
      <table class="data frames">
        <thead><tr><th>Time</th><th>From → to</th><th>What</th><th class="num">Signal</th><th>Heard by</th></tr></thead>
        <tbody>
          {frames.map((f) => (
            <tr class={f.retry ? "retry" : ""}>
              <td class="mono">{clock(f.ts)}</td>
              <td>
                <Who addr={f.src} name={f.src_name} /> → <Who addr={f.dst} name={f.dst_name} />
                {(f.nwk_src && f.nwk_src !== f.src) || (f.nwk_dst && f.nwk_dst !== f.dst && f.nwk_dst !== me && !isBroadcast(f.nwk_dst)) ? (
                  <div class="muted small">for <Who addr={f.nwk_src} name={f.nwk_src_name} /> → <Who addr={f.nwk_dst} name={f.nwk_dst_name} /></div>
                ) : null}
              </td>
              <td>{f.info || f.kind}{f.retry && <Chip tone="warn">resent</Chip>}</td>
              <td class="num">{f.rssi} dBm</td>
              <td class="muted small">{(f.by || []).map((b: any[]) => `${b[0]} ${b[1]}`).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SnifferTab({ dev }: { dev: Dev }) {
  const addr = nwkHex(dev);
  const [range, setRange] = useState<Range>("24h");
  const { data: d, err, loading } = useSniffer(addr ? `/api/device/${addr}` : null, { range }, range === "1h" ? 30 : 60);
  const [allNb, setAllNb] = useState(false);
  if (!addr) return <Empty>This device has no network address yet.</Empty>;
  const toolbar = (
    <div class="toolbar">
      <Seg label="Time range" value={range} onChange={setRange} options={RANGES} />
      {loading && <span class="muted small">updating…</span>}
      <span class="spacer" />
      {snifferPanel.value && <Ext href={snifferPanel.value}>Zigbee Sniffer</Ext>}
    </div>
  );
  if (!d) return <div class="page-sub">{toolbar}{err ? <p class="note warn"><Icon name="alert" size={16} /> {err}</p> : <Empty>Loading…</Empty>}</div>;
  const row = d.device || {};
  const x1 = d.now, x0 = d.now - d.span;
  const hours = d.span / 3600;
  const sigs: LineSeries[] = (d.signal_series || []).map((s: any, i: number) => ({
    name: s.name, color: SERIES[i % SERIES.length], points: s.data.map((p: number[]) => [p[0], p[1], p[2], p[3]]),
  }));
  const refs: RefLine[] = (d.signal_series || []).filter((s: any) => s.ref !== null && s.ref !== undefined).map((s: any, i: number) => ({
    y: s.ref, color: SERIES[i % SERIES.length], label: `${s.name} ${s.ref_kind === "normal" ? "normal" : "average"} ${Math.round(s.ref)} dBm`,
  }));
  const series: number[][] = d.series || [];
  const xs = series.map((r) => r[0]);
  const shown = (row.signal || []).find((s: any) => s.sniffer === row.rssi_sniffer);
  const neighbours = [...(d.neighbours || [])].filter(Boolean).sort((a, b) => (a.cost ?? 9) - (b.cost ?? 9));
  const flags: any[] = row.flags || [];
  return (
    <div class="page-sub">
      {toolbar}
      {err && <p class="note warn"><Icon name="alert" size={16} /> {err} (showing the last answer)</p>}
      <div class={`stats ${loading ? "refreshing" : ""}`}>
        <Stat label="Signal" value={row.rssi_avg !== null && row.rssi_avg !== undefined ? `${num(row.rssi_avg)} dBm` : "—"}
          sub={<>{row.rssi_sniffer_name ? `at ${row.rssi_sniffer_name}` : ""}{shown?.change !== undefined && shown?.change !== null
            ? ` · ${Math.abs(shown.change) < 1 ? "as usual" : `${Math.round(Math.abs(shown.change))} dB ${shown.change < 0 ? "weaker" : "stronger"} than normal`}` : ""}</>} />
        <Stat label="Resent" value={pct(row.retry_pct)} tone={row.retry_pct >= 15 ? "warn" : undefined}
          sub={`${(row.retry ?? 0).toLocaleString()} of ${(row.uni ?? 0).toLocaleString()} sent to one device${d.baseline?.retry_pct !== undefined ? ` · normal ${pct(d.baseline.retry_pct)}` : ""}`} />
        <Stat label="Lost on the way to it" value={pct(row.rx_lost_pct)} tone={row.rx_lost_pct >= 10 ? "warn" : undefined}
          sub={`${(row.rx_lost ?? 0).toLocaleString()} of ${(row.rx ?? 0).toLocaleString()} sent to it${row.noack_missed ? ` · ${row.noack_missed} ACKs the sniffers missed` : ""}`} />
        <Stat label="Messages" value={`${num(Math.round((row.msgs ?? 0) / hours))}/h`}
          sub={`${d.baseline?.msgs_per_h !== undefined ? `normal ${num(Math.round(d.baseline.msgs_per_h))}/h · ` : ""}relays ${num(Math.round((row.relay ?? 0) / hours))}/h`} />
        <Stat label="Next hop" value={row.via ? <Who addr={row.via.addr} name={row.via.name} /> : "—"}
          sub={row.via ? `${row.via.share}% of what it sends` : row.mesh ? `${row.mesh.n} neighbours` : undefined} />
      </div>

      {flags.length > 0 && (
        <Card title="What the Sniffer found">
          <ul class="plain sn-findings">
            {flags.map((f) => (
              <li><Chip tone={SEV_TONE[f.sev] || "muted"}>{f.sev}</Chip>
                <div><div>{f.text}</div>{f.detail && <div class="muted small">{f.detail}</div>}</div></li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={sigs.length === 1 ? `Signal at ${sigs[0].name}` : "Signal at each sniffer"}>
        {sigs.length ? <LineChart series={sigs} refs={refs} x0={x0} x1={x1} unit="dBm" label={`Signal of ${dev.name} in dBm`} />
          : <Empty>Not heard in this time.</Empty>}
        <p class="muted small">The line is the average per {d.bucket >= 3600 ? "hour" : `${d.bucket / 60} minutes`}, the band the weakest
          to strongest frame. The thin line is its normal signal at that sniffer (its 7-day average).</p>
      </Card>

      <Card title="Frames it sent">
        {xs.length ? (
          <ColumnChart xs={xs} x0={x0} x1={x1} bucket={d.bucket} label={`Frames ${dev.name} sent`}
            stacks={[
              { name: "First time", color: SERIES[0], values: series.map((r) => Math.max(0, (r[1] || 0) - (r[7] || 0))) },
              { name: "Resent", color: SERIES[1], values: series.map((r) => r[7] || 0) },
            ]}
            extras={[
              { name: "messages of its own", values: series.map((r) => r[10]) },
              { name: "relayed for others", values: series.map((r) => r[8]) },
              { name: "sent to it without an ACK heard", values: series.map((r) => r[12]) },
            ]} />
        ) : <Empty>Nothing sent in this time.</Empty>}
      </Card>

      <div class="dev-grid">
        <div class="dev-col">
          <Card title="Route">
            {(d.routes_out || []).length === 0 && (d.routes_in || []).length === 0 && <Empty>No source routes seen.</Empty>}
            <ul class="plain routes">
              {(d.routes_out || []).map((r: any) => <li><span class="muted small">to {r.name || r.addr} · {r.n.toLocaleString()}×</span><Path hops={r.path} /></li>)}
              {(d.routes_in || []).map((r: any) => <li><span class="muted small">from {r.name || r.addr} · {r.n.toLocaleString()}×</span><Path hops={r.path} /></li>)}
            </ul>
          </Card>
          <Card title="Who it resends to">
            {(d.next_hops || []).length === 0 ? <Empty>Nothing sent to one neighbour.</Empty> : (
              <div class="table-wrap">
                <table class="data">
                  <thead><tr><th>Next hop</th><th class="num">Sent</th><th class="num">Resent</th><th class="num">No ACK</th><th class="num">Resent %</th></tr></thead>
                  <tbody>{d.next_hops.filter(Boolean).map((h: any) => (
                    <tr><td><Who addr={h.addr} name={h.name} /></td><td class="num">{h.uni.toLocaleString()}</td><td class="num">{h.retry.toLocaleString()}</td>
                      <td class="num">{h.noack.toLocaleString()}</td><td class={`num ${h.pct >= 15 ? "warn-text" : ""}`}>{pct(h.pct)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Incidents it was part of"><Incidents list={d.incidents} empty="None in this time." /></Card>
          <Card title="Events">
            {(d.events || []).length === 0 ? <Empty>None in this time.</Empty> : (
              <ul class="plain events">
                {runs(d.events).slice(0, 30).map((r) => (
                  <li><span class="muted small">{when(r.ts)}{r.n > 1 && r.first ? `–${hm(r.first)}` : ""}</span> <b>{r.what}</b>
                    {r.n > 1 && <Chip tone="muted">×{r.n}</Chip>} <span class="muted small">{r.detail}</span></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div class="dev-col">
          <Card title={<>Mesh neighbours <span class="muted">{neighbours.length}</span></>}>
            {neighbours.length === 0 ? <Empty>No link status heard (end devices send none).</Empty> : (
              <>
                <div class="table-wrap">
                  <table class="data">
                    <thead><tr><th>Neighbour</th><th class="num" title="Link cost 1 (best) to 7">Cost</th><th class="num" title="Average cost it reports for the link in / out">In / out</th><th>Heard</th></tr></thead>
                    <tbody>{(allNb ? neighbours : neighbours.slice(0, 12)).map((n) => (
                      <tr><td><Who addr={n.addr} name={n.name} />{n.own === false && n.reported && <span class="muted small"> (only it reports)</span>}</td>
                        <td class={`num ${(n.cost ?? 0) >= 5 ? "warn-text" : ""}`}>{n.cost ?? "—"}</td>
                        <td class="num muted">{n.in_avg !== undefined ? num(n.in_avg) : "—"} / {n.out_avg !== undefined ? num(n.out_avg) : "—"}</td>
                        <td class="muted small">{n.ts ? ago(n.ts) : "—"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
                {neighbours.length > 12 && <button type="button" class="link-btn small" onClick={() => setAllNb(!allNb)}>{allNb ? "Show fewer" : `Show all ${neighbours.length}`}</button>}
                {(row.lopsided || []).length > 0 && <p class="muted small">Lopsided: {row.lopsided.map((l: any, k: number) => <>{k > 0 && ", "}<Who addr={l.addr} name={l.name} /> ({l.in} in, {l.out} out)</>)}</p>}
              </>
            )}
          </Card>
          <Card title="Talks with">
            <div class="talks">
              {([["Sends to", d.sends_to], ["Hears from", d.hears_from], ["Relays for", d.relays_for], ["Relayed by", d.relayed_by]] as [string, any[]][]).map(([t, list]) => (
                <div>
                  <h4>{t}</h4>
                  {(list || []).length === 0 ? <span class="muted small">—</span> : (
                    <ul class="plain">{list.filter(Boolean).slice(0, 5).map((x) => <li><Who addr={x.addr} name={x.name} /> <span class="muted small">{x.n.toLocaleString()}{x.rssi_avg !== null && x.rssi_avg !== undefined ? ` · ${num(x.rssi_avg)} dBm` : ""}</span></li>)}</ul>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card title="Latest frames"><Frames frames={(d.frames || []).slice(0, 40)} me={addr} /></Card>
    </div>
  );
}
