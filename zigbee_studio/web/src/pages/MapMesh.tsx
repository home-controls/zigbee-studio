// The mesh as a map: who hears whom, from the routers' Link Status (every 15 s, through the Zigbee
// Sniffer), laid out by Home Assistant's floors and rooms so it reads like the house. Drag a device
// to move it (it stays there while the page is open), click it to open its signal and traffic.

import { useMemo, useRef, useState } from "preact/hooks";
import { devices, rooms } from "../store";
import { devByNwk, RANGES, type Range, useSniffer } from "../sniffer";
import { useWidth } from "../chart";
import { Card, Empty, Search, Seg } from "../ui";
import { Icon } from "../icons";
import { ago } from "../format";
import { go, href } from "../route";
import { CostChip, CostLegend, costClass, jitter, loadOpts, MapTip, placeLabels, saveOpts, typeWord, worstCost } from "../mapcommon";
import type { Dev } from "../types";

type MNode = {
  addr: string; name?: string; type?: string; rssi_avg?: number | null; sev?: number; last_seen?: number; tx?: number;
  mesh?: { n: number; best: number; worst: number; good: number; own: boolean } | null;
};
type Link = [string, string, number | null, number | null, number]; // a, b, cost a->b, cost b->a, when
type Mesh = { range: string; nodes: MNode[]; links: Link[]; children: [string, string][] };
type Opts = { links: "best" | "all" | "weak"; ends: boolean; names: boolean; layout: "rooms" | "free"; range: Range };

const OPTS_KEY = "zs.mesh";
const COORD = "0x0000";
// where each device sits, as fractions of the panel; kept while the page is away, so coming back
// finds the same picture
const POS = new Map<string, { u: number; v: number }>();
const PINNED = new Set<string>();
let laidOutAs = "";

interface Place { dev?: Dev; area: string | null; areaName: string | null; floor: string | null }
interface Band { key: string; name: string; y0: number; y1: number; areas: { id: string; name: string; x: number }[] }

function placeOf(n: MNode, coord?: Dev): Place {
  const dev = n.addr === COORD ? coord : devByNwk.value.get(n.addr);
  const r = rooms.value;
  const aid = dev ? r?.dev[dev.ieee]?.area ?? null : null;
  const area = aid ? r?.areas.find((a) => a.id === aid) : undefined;
  return { dev, area: area?.id ?? null, areaName: area?.name ?? null, floor: area ? area.floor ?? "" : null };
}

/** Floors as bands (highest on top), rooms spread across each; every device's anchor. */
function bandsFor(nodes: MNode[], places: Map<string, Place>, W: number, H: number, byRoom: boolean) {
  const r = rooms.value;
  const anchor = new Map<string, { x: number; y: number; band: Band }>();
  if (!byRoom || !r) {
    const band: Band = { key: "all", name: "", y0: 0, y1: H, areas: [] };
    for (const n of nodes) anchor.set(n.addr, { x: W / 2, y: H / 2, band });
    return { bands: [] as Band[], anchor, free: true };
  }
  const floorKeys = new Set<string>();
  for (const n of nodes) {
    const p = places.get(n.addr)!;
    floorKeys.add(p.area === null ? "~none" : p.floor || "~nofloor");
  }
  const floors = [...floorKeys].sort((a, b) => {
    const fa = r.floors.find((f) => f.id === a), fb = r.floors.find((f) => f.id === b);
    if (!fa || !fb) return fa ? -1 : fb ? 1 : a.localeCompare(b);
    return (fb.level ?? -99) - (fa.level ?? -99) || fa.name.localeCompare(fb.name);
  });
  // busier floors get taller bands
  const count = new Map<string, number>();
  for (const n of nodes) {
    const p = places.get(n.addr)!;
    const k = p.area === null ? "~none" : p.floor || "~nofloor";
    count.set(k, (count.get(k) || 0) + 1);
  }
  const weight = floors.map((k) => Math.pow(Math.max(3, count.get(k) || 0), 0.7));
  const total = weight.reduce((a, b) => a + b, 0);
  let y = 0;
  const bands: Band[] = floors.map((key, i) => {
    const y0 = y;
    y += (H * weight[i]) / total;
    return {
      key, y0, y1: y, areas: [],
      name: key === "~none" ? "No room in Home Assistant" : key === "~nofloor" ? "Rooms without a floor" : r.floors.find((f) => f.id === key)?.name || key,
    };
  });
  const byKey = new Map(bands.map((b) => [b.key, b]));
  for (const b of bands) {
    const ids = new Set<string>();
    for (const n of nodes) {
      const p = places.get(n.addr)!;
      const k = p.area === null ? "~none" : p.floor || "~nofloor";
      if (k === b.key) ids.add(p.area ?? "~");
    }
    const list = [...ids].map((id) => ({ id, name: id === "~" ? "" : r.areas.find((a) => a.id === id)?.name || id }))
      .sort((a, c) => a.name.localeCompare(c.name));
    b.areas = list.map((a, i) => ({ ...a, x: ((i + 0.5) / list.length) * W }));
  }
  for (const n of nodes) {
    const p = places.get(n.addr)!;
    const band = byKey.get(p.area === null ? "~none" : p.floor || "~nofloor")!;
    const a = band.areas.find((x) => x.id === (p.area ?? "~"));
    anchor.set(n.addr, { x: a ? a.x : W / 2, y: band.y0 + (band.y1 - band.y0) * 0.55, band });
  }
  return { bands, anchor, free: false };
}

/** A force layout (Fruchterman–Reingold), pulled toward each device's room; only `movable` move.
 * By floor, devices push apart only within their floor's band and only links within a floor pull:
 * the rooms place a device across, the links within its floor next to whom it hears. */
function settle(nodes: MNode[], springs: [number, number, number][], anchor: Map<string, { x: number; y: number; band: Band }>,
  W: number, H: number, iters: number, free: boolean, movable: (addr: string) => boolean) {
  const N = nodes.length;
  if (!N) return;
  const A = nodes.map((n) => anchor.get(n.addr)!);
  const inBand = new Map<Band, number>();
  for (const a of A) inBand.set(a.band, (inBand.get(a.band) || 0) + 1);
  const K = A.map((a) => 0.6 * Math.sqrt((W * (free ? H : a.band.y1 - a.band.y0)) / (free ? N : inBand.get(a.band)!)));
  const P = nodes.map((n) => { const p = POS.get(n.addr)!; return { x: p.u * W, y: p.v * H }; });
  const gx = free ? 0.04 : 0.08, gy = free ? 0.04 : 0.12;
  const dx = new Float64Array(N), dy = new Float64Array(N);
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      if (!free && A[i].band !== A[j].band) continue;
      let ex = P[i].x - P[j].x, ey = P[i].y - P[j].y;
      let d = Math.hypot(ex, ey);
      if (d < 0.01) { ex = jitter(nodes[i].addr, it); ey = jitter(nodes[j].addr, it); d = 0.5; }
      const k = (K[i] + K[j]) / 2;
      if (!free && d > 2.5 * k) continue; // near neighbours only: far ones would push everything to the band's edges
      const f = (k * k) / d / d;
      dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
    }
    for (const [i, j, w] of springs) {
      if (!free && A[i].band !== A[j].band) continue;
      const ex = P[i].x - P[j].x, ey = P[i].y - P[j].y;
      const k = (K[i] + K[j]) / 2;
      const d = Math.hypot(ex, ey) || 0.01, f = (d / k) * w;
      dx[i] -= ex * f; dy[i] -= ey * f; dx[j] += ex * f; dy[j] += ey * f;
    }
    for (let i = 0; i < N; i++) {
      if (!movable(nodes[i].addr)) continue;
      dx[i] += (A[i].x - P[i].x) * gx;
      dy[i] += (A[i].y - P[i].y) * gy;
      // the band's edges push back softly, so devices don't line up along them
      const top = (free ? 0 : A[i].band.y0) + 30, bottom = (free ? H : A[i].band.y1) - 22;
      if (P[i].y < top) dy[i] += (top - P[i].y) * 1.5;
      if (P[i].y > bottom) dy[i] -= (P[i].y - bottom) * 1.5;
      if (P[i].x < 30) dx[i] += (30 - P[i].x) * 1.5;
      if (P[i].x > W - 30) dx[i] -= (P[i].x - W + 30) * 1.5;
      const t = Math.max(1, K[i] * 0.5 * cool);
      const len = Math.hypot(dx[i], dy[i]);
      if (len > 0) { const s = Math.min(len, t) / len; P[i].x += dx[i] * s; P[i].y += dy[i] * s; }
      const b = A[i].band;
      P[i].x = Math.min(W - 14, Math.max(14, P[i].x));
      P[i].y = Math.min((free ? H : b.y1) - 12, Math.max((free ? 0 : b.y0) + 22, P[i].y));
    }
  }
  nodes.forEach((n, i) => { if (movable(n.addr)) POS.set(n.addr, { u: P[i].x / W, v: P[i].y / H }); });
}

/** Each device's three best links (both ends count), the mesh's backbone. */
function bestLinks(links: Link[], shown: Set<string>): Set<Link> {
  const per = new Map<string, Link[]>();
  for (const l of links) {
    if (!shown.has(l[0]) || !shown.has(l[1])) continue;
    for (const a of [l[0], l[1]]) {
      if (!per.has(a)) per.set(a, []);
      per.get(a)!.push(l);
    }
  }
  const keep = new Set<Link>();
  for (const ls of per.values()) {
    ls.sort((x, y) => (worstCost(x[2], x[3]) || 9) - (worstCost(y[2], y[3]) || 9));
    ls.slice(0, 3).forEach((l) => keep.add(l));
  }
  return keep;
}

export function MeshMap() {
  const [opts, setOptsState] = useState<Opts>(() => loadOpts<Opts>(OPTS_KEY, { links: "best", ends: true, names: true, layout: "rooms", range: "24h" }));
  const setOpts = (o: Partial<Opts>) => { const n = { ...opts, ...o }; setOptsState(n); saveOpts(OPTS_KEY, n); };
  const { data, err, loading } = useSniffer<Mesh>("/api/mesh", { range: opts.range }, 60);
  const [ref, W] = useWidth();
  const [, setTick] = useState(0);
  const [arranged, setArranged] = useState(0);
  const arrangedSeen = useRef(0);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; body: preact.ComponentChildren } | null>(null);
  const [q, setQ] = useState("");
  const [hit, setHit] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ addr: string; id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const coord = devices.value.find((d) => d.type === "Coordinator");

  const nodesAll = data?.nodes || [];
  const kidSet = new Set((data?.children || []).map((c) => c[0]));
  const linked = new Set<string>();
  for (const l of data?.links || []) { linked.add(l[0]); linked.add(l[1]); }
  const nodes = nodesAll.filter((n) => opts.ends || !(n.type === "EndDevice" || (kidSet.has(n.addr) && !linked.has(n.addr))));
  const shownSet = new Set(nodes.map((n) => n.addr));
  const places = new Map(nodes.map((n) => [n.addr, placeOf(n, coord)]));
  const floorsN = new Set([...places.values()].map((p) => (p.area === null ? "~none" : p.floor || "~nofloor"))).size;
  const H = Math.round(Math.min(900, Math.max(420, W * 0.55, opts.layout === "rooms" ? floorsN * 170 : 0)));
  const { bands, anchor, free } = bandsFor(nodes, places, W, H, opts.layout === "rooms");
  const backbone = useMemo(() => bestLinks(data?.links || [], shownSet), [data, opts.ends]);
  const links = (data?.links || []).filter((l) => shownSet.has(l[0]) && shownSet.has(l[1]) && (
    opts.links === "all" ? true : opts.links === "weak" ? (worstCost(l[2], l[3]) || 0) >= 5 : backbone.has(l)));
  const kids = opts.ends ? (data?.children || []).filter((c) => shownSet.has(c[0]) && shownSet.has(c[1])) : [];

  // place new devices, and lay everything out when asked to (or the first time)
  useMemo(() => {
    if (!nodes.length) return;
    const as = opts.layout;
    const all = laidOutAs !== as || arranged !== arrangedSeen.current;
    arrangedSeen.current = arranged;
    if (all) {
      for (const k of [...POS.keys()]) if (!PINNED.has(k) || laidOutAs !== as) POS.delete(k);
      if (laidOutAs !== as) PINNED.clear();
      laidOutAs = as;
    }
    const fresh = new Set(nodes.filter((n) => !POS.has(n.addr)).map((n) => n.addr));
    if (!fresh.size) return;
    const parent = new Map((data?.children || []).map((c) => [c[0], c[1]]));
    for (const addr of fresh) {
      const a = anchor.get(addr)!, par = parent.get(addr), pp = par ? POS.get(par) : undefined;
      const spread = free ? 0.35 : 0.5 / Math.max(1, a.band.areas.length);
      POS.set(addr, pp ? { u: pp.u + jitter(addr) * 0.04, v: pp.v + jitter(addr, 1) * 0.04 }
        : { u: a.x / W + jitter(addr) * spread, v: a.y / H + jitter(addr, 1) * (free ? 0.35 : 0.08) });
    }
    const idx = new Map(nodes.map((n, i) => [n.addr, i]));
    const springs: [number, number, number][] = [];
    for (const l of backbone) {
      const i = idx.get(l[0]), j = idx.get(l[1]);
      if (i === undefined || j === undefined) continue;
      const c = worstCost(l[2], l[3]) || 7;
      springs.push([i, j, c <= 1 ? 1 : c <= 3 ? 0.6 : 0.25]);
    }
    for (const [c, p] of data?.children || []) {
      const i = idx.get(c), j = idx.get(p);
      if (i !== undefined && j !== undefined) springs.push([i, j, 2]);
    }
    const everything = fresh.size === nodes.length;
    settle(nodes, springs, anchor, W, H, everything ? 320 : 140, free, everything ? (a) => !PINNED.has(a) : (a) => fresh.has(a));
  }, [data, opts.layout, opts.ends, arranged, nodes.length]);

  // search: matching devices, Enter steps through them
  const hits = q.trim() ? nodes.filter((n) => (n.name || "").toLowerCase().includes(q.trim().toLowerCase()) || n.addr.includes(q.trim().toLowerCase())) : [];
  const focus = hits.length ? hits[hit % hits.length].addr : null;
  const active = hover ?? focus;
  const near = new Set<string>();
  if (active) {
    near.add(active);
    for (const l of links) { if (l[0] === active) near.add(l[1]); if (l[1] === active) near.add(l[0]); }
    for (const [c, p] of kids) { if (c === active) near.add(p); if (p === active) near.add(c); }
  }
  const byAddr = new Map(nodes.map((n) => [n.addr, n]));
  const nameOf = (a: string) => byAddr.get(a)?.name || a;
  const xy = (a: string) => { const p = POS.get(a) || { u: 0.5, v: 0.5 }; return [p.u * W, p.v * H]; };
  const local = (e: PointerEvent) => { const r = svgRef.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  const nodeTip = (n: MNode, e: PointerEvent) => {
    const p = places.get(n.addr);
    const [x, y] = local(e);
    setTip({ x, y, body: (
      <>
        <div class="tip-head">{typeWord(n.type)}{p?.areaName ? ` · ${p.areaName}` : ""}</div>
        <div class="tip-title">{n.name || n.addr}</div>
        {n.rssi_avg != null && <div class="tip-row"><b>{Math.round(n.rssi_avg)} dBm</b> at the sniffer that hears it best</div>}
        {n.mesh && <div class="tip-row"><b>{n.mesh.n}</b> neighbours, {n.mesh.good} at cost 1–3 (best {n.mesh.best})</div>}
        {n.last_seen && <div class="tip-row">Heard <b>{ago(n.last_seen)}</b></div>}
        {n.sev && n.sev >= 2 ? <div class="tip-row warn-text">Needs attention (see its Signal &amp; traffic)</div> : null}
      </>
    ) });
  };
  const linkTip = (l: Link, e: PointerEvent) => {
    const [x, y] = local(e);
    setTip({ x, y, body: (
      <>
        <div class="tip-head">Link · updated {ago(l[4])}</div>
        <div class="tip-row"><CostChip c={l[2]} /> {nameOf(l[0])} → {nameOf(l[1])}</div>
        <div class="tip-row"><CostChip c={l[3]} /> {nameOf(l[1])} → {nameOf(l[0])}</div>
      </>
    ) });
  };
  const openNode = (addr: string) => {
    const dev = addr === COORD ? coord : devByNwk.value.get(addr);
    if (dev && dev.type !== "Coordinator") go("device", dev.ieee, "sniffer");
  };
  const onDown = (addr: string) => (e: PointerEvent) => {
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { addr, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    setTip(null);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    const [x, y] = local(e);
    POS.set(d.addr, { u: Math.min(1, Math.max(0, x / W)), v: Math.min(1, Math.max(0, y / H)) });
    PINNED.add(d.addr);
    setTick((t) => t + 1);
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) openNode(d.addr);
  };

  const radius = (n: MNode) => (n.addr === COORD ? 9 : n.type === "EndDevice" ? 4.5 : 6.5);
  const labelText = (n: MNode) => { const l = n.name || n.addr; return l.length > 24 ? l.slice(0, 23) + "…" : l; };
  const maxTx = Math.max(1, ...nodes.map((n) => n.tx || 0));
  const sides = placeLabels(nodes.map((n) => {
    const [x, y] = xy(n.addr);
    const lead = n.addr === active || n.addr === focus ? 0 : active && near.has(n.addr) ? 1 : n.addr === COORD ? 2 : n.type === "EndDevice" ? 4 : 3;
    const shown = lead <= 1 || (opts.names && (n.type !== "EndDevice" || nodes.length <= 40));
    // busier routers name themselves first
    return { key: n.addr, x, y, r: radius(n), text: labelText(n), rank: shown ? lead - (n.tx || 0) / maxTx / 2 : 99, force: lead <= 1 && !!active };
  }).filter((l) => l.rank < 99), W);
  const fill = (n: MNode) => n.addr === COORD ? "n-coord" : (n.sev ?? 0) >= 3 ? "n-bad" : (n.sev ?? 0) >= 2 ? "n-warn" : n.type === "EndDevice" ? "n-end" : "n-router";

  return (
    <div class="page-sub">
      <div class="toolbar">
        <Search value={q} onInput={(v) => { setQ(v); setHit(0); }} placeholder="Find a device" />
        {q.trim() && <span class="muted small">{hits.length ? `${(hit % hits.length) + 1} of ${hits.length}` : "no match"}</span>}
        {hits.length > 1 && <button type="button" class="btn small" onClick={() => setHit(hit + 1)}>Next</button>}
        <Seg label="Links" value={opts.links} onChange={(v) => setOpts({ links: v })}
          options={[{ v: "best", label: "Strongest 3" }, { v: "all", label: "All links" }, { v: "weak", label: "Weak only" }]} />
        <Seg label="Layout" value={opts.layout} onChange={(v) => setOpts({ layout: v })}
          options={[{ v: "rooms", label: "By floor" }, { v: "free", label: "Free" }]} />
        <button type="button" class="btn small" aria-pressed={opts.ends} onClick={() => setOpts({ ends: !opts.ends })}>End devices</button>
        <button type="button" class="btn small" aria-pressed={opts.names} onClick={() => setOpts({ names: !opts.names })}>Names</button>
        <button type="button" class="btn small" onClick={() => { PINNED.clear(); setArranged(arranged + 1); }}><Icon name="refresh" size={14} /> Re-arrange</button>
        <span class="spacer" />
        <Seg label="Range" value={opts.range} onChange={(v) => setOpts({ range: v })} options={RANGES} />
      </div>
      {err && <p class="note warn"><Icon name="alert" size={16} /> {err}</p>}
      <Card class={loading && data ? "refreshing" : ""}>
        <div class="mesh-box" ref={ref} style={{ height: `${H}px` }}>
          {!data ? <Empty>{err ? "Nothing to show." : "Loading the mesh…"}</Empty>
            : !nodes.length ? <Empty>No mesh heard yet: the Sniffer reads it from the routers' Link Status, which needs the network key.</Empty> : (
              <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="mesh" onPointerMove={onMove} onPointerUp={onUp}
                onPointerCancel={() => { drag.current = null; }} onPointerLeave={() => { setTip(null); setHover(null); }}>
                <g>
                  {bands.map((b, i) => (
                    <g>
                      <rect x={0} y={b.y0} width={W} height={b.y1 - b.y0} class={i % 2 ? "band alt" : "band"} />
                      <text class="band-name" x={10} y={b.y0 + 16}>{b.name}</text>
                      {opts.names && W >= 640 && b.areas.map((a) => {
                        const room = Math.max(4, Math.floor(W / b.areas.length / 6.5));
                        return a.name && <text class="area-name" x={a.x} y={b.y1 - 6} text-anchor="middle">{a.name.length > room ? a.name.slice(0, room - 1) + "…" : a.name}</text>;
                      })}
                    </g>
                  ))}
                </g>
                <g>
                  {kids.map(([c, p]) => {
                    const [x1, y1] = xy(c), [x2, y2] = xy(p);
                    return <line class={`kid ${active && c !== active && p !== active ? "faded" : ""}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
                  })}
                </g>
                <g>
                  {links.map((l) => {
                    const [x1, y1] = xy(l[0]), [x2, y2] = xy(l[1]);
                    const off = active && l[0] !== active && l[1] !== active;
                    return (
                      <g class={off ? "faded" : ""}>
                        <line class={`link cost-line-${costClass(worstCost(l[2], l[3]))}`} x1={x1} y1={y1} x2={x2} y2={y2} />
                        <line class="link-hit" x1={x1} y1={y1} x2={x2} y2={y2}
                          onPointerMove={(e) => !drag.current && linkTip(l, e as PointerEvent)} onPointerLeave={() => setTip(null)} />
                      </g>
                    );
                  })}
                </g>
                <g>
                  {nodes.map((n) => {
                    const [x, y] = xy(n.addr);
                    const r = radius(n), side = sides.get(n.addr);
                    return (
                      <g class={`node ${active && !near.has(n.addr) ? "faded" : ""} ${n.addr === focus ? "found" : ""}`} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
                        onPointerDown={onDown(n.addr) as any}
                        onPointerEnter={(e) => { if (!drag.current) { setHover(n.addr); nodeTip(n, e as PointerEvent); } }}
                        onPointerLeave={() => { if (!drag.current) { setHover(null); setTip(null); } }}>
                        <circle r={r + 7} class="hit" />
                        {n.addr === focus && <circle r={r + 5} class="ring" />}
                        <circle r={r} class={`dot ${fill(n)}`} />
                        {side && <text x={side === "r" ? r + 4 : -r - 4} y={4} text-anchor={side === "r" ? "start" : "end"} class="node-name">{labelText(n)}</text>}
                      </g>
                    );
                  })}
                </g>
              </svg>
            )}
          {tip && <MapTip x={tip.x} y={tip.y} w={W}>{tip.body}</MapTip>}
        </div>
        <div class="map-foot">
          <CostLegend />
          <span class="chart-legend map-legend">
            <span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" class="dot n-coord" /></svg>Coordinator</span>
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="dot n-router" /></svg>Router</span>
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="3.5" class="dot n-end" /></svg>End device</span>
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="dot n-warn" /></svg>Needs attention</span>
            {opts.ends && <span><i class="key line kid-key" />End device's parent</span>}
          </span>
          {data && <p class="muted small">{nodes.length} devices · {links.length} of {data.links.length} links shown · drag a device to move it, click it to open its signal and traffic</p>}
        </div>
      </Card>
      {data && <MeshTables data={data} nameOf={(a) => data.nodes.find((n) => n.addr === a)?.name || a} places={places} />}
    </div>
  );
}

function DevLink({ addr, name }: { addr: string; name: string }) {
  const dev = devByNwk.value.get(addr);
  return dev && dev.type !== "Coordinator" ? <a href={href("device", dev.ieee, "sniffer")}>{name}</a> : <span>{name}</span>;
}

function MeshTables({ data, nameOf, places }: { data: Mesh; nameOf: (a: string) => string; places: Map<string, Place> }) {
  const [allR, setAllR] = useState(false);
  const [allL, setAllL] = useState(false);
  const routers = data.nodes.filter((n) => n.mesh && n.mesh.own && n.addr !== COORD)
    .sort((a, b) => a.mesh!.good - b.mesh!.good || a.mesh!.n - b.mesh!.n);
  const lopsided = data.links.filter((l) => l[2] && l[3] && Math.min(l[2], l[3]) <= 3 && Math.max(l[2], l[3]) >= 5)
    .sort((a, b) => Math.abs(b[2]! - b[3]!) - Math.abs(a[2]! - a[3]!) || Math.max(b[2]!, b[3]!) - Math.max(a[2]!, a[3]!));
  return (
    <div class="grid two">
      <Card title="Routers with the fewest good links" actions={<span class="muted small">few = fragile</span>}>
        {!routers.length ? <Empty>No router has reported its links yet.</Empty> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Router</th><th>Room</th><th class="num" title="Routers it hears">Neighbours</th><th class="num" title="Links at cost 1–3">Good</th><th>Best</th></tr></thead>
              <tbody>
                {routers.slice(0, allR ? undefined : 8).map((n) => (
                  <tr>
                    <td><DevLink addr={n.addr} name={n.name || n.addr} /></td>
                    <td class="muted">{places.get(n.addr)?.areaName || "–"}</td>
                    <td class="num">{n.mesh!.n}</td>
                    <td class="num">{n.mesh!.good}</td>
                    <td><CostChip c={n.mesh!.best} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {routers.length > 8 && <button type="button" class="link-btn" onClick={() => setAllR(!allR)}>{allR ? "Show fewer" : `Show all ${routers.length}`}</button>}
          </div>
        )}
      </Card>
      <Card title="Lopsided links" actions={<span class="muted small">one way good, the other poor</span>}>
        {!lopsided.length ? <Empty>No lopsided links: every link that works one way works the other.</Empty> : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Link</th><th title="Cost from the first to the second">→</th><th title="Cost from the second to the first">←</th><th>Updated</th></tr></thead>
              <tbody>
                {lopsided.slice(0, allL ? undefined : 8).map((l) => (
                  <tr>
                    <td><DevLink addr={l[0]} name={nameOf(l[0])} /> <span class="muted">↔</span> <DevLink addr={l[1]} name={nameOf(l[1])} /></td>
                    <td><CostChip c={l[2]} /></td>
                    <td><CostChip c={l[3]} /></td>
                    <td class="muted">{ago(l[4])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lopsided.length > 8 && <button type="button" class="link-btn" onClick={() => setAllL(!allL)}>{allL ? "Show fewer" : `Show all ${lopsided.length}`}</button>}
          </div>
        )}
        <p class="muted small">Often a transmit-power difference, or interference near one end. Cost 1–3 is good, 5–6 poor, 7 bad.</p>
      </Card>
    </div>
  );
}
