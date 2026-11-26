// Floor maps: plans of the house (an image, or a blank grid in metres) with devices and sniffers
// placed on them, and the Zigbee coverage the Zigbee Sniffer estimates from what its sniffers hear
// (its path-loss model: each router's strength, how fast signal falls with distance, the loss per
// floor). Set up here with Allow control on; the Sniffer keeps it (its own Map page shows the same).

import { useEffect, useRef, useState } from "preact/hooks";
import { control, devByKey, rooms, areaOf } from "../store";
import { RANGES, type Range, useSniffer } from "../sniffer";
import { useWidth } from "../chart";
import { write, toast } from "../conn";
import { confirmIt } from "../dialog";
import { Card, Empty, Search, Seg } from "../ui";
import { Icon } from "../icons";
import { go } from "../route";
import { costClass, CostLegend, heatColours, HeatLegend, heatRGB, loadOpts, MapTip, placeLabels, saveOpts, signalWord, typeWord } from "../mapcommon";

type Floor = {
  id: string; name: string; level: number; image: string | null; img_w: number | null; img_h: number | null;
  scale: number | null; width_m?: number; height_m?: number; size_m: [number, number] | null;
};
type Item = { key: string; kind: "device" | "sniffer"; addr?: string; name: string; type: string; model?: string };
type Meta = { floors: Floor[]; positions: Record<string, { floor: string; x: number; y: number }>; items: Item[]; floor_height_m: number };
type CovItem = Item & {
  floor: string; x: number; y: number; sev?: number; flags?: string[]; signal?: Record<string, { rssi: number; n: number }>;
  strength?: number | null; strength_from?: string | null; connected?: boolean;
};
type Model = {
  ok: boolean; why?: string; samples?: number; devices?: number; n?: number; n10: number; n_fixed?: boolean; floor_loss: number;
  floor_loss_fitted?: boolean; rmse?: number; devices_with_strength?: number; gains?: { sniffer: string; name?: string; db: number; ref: boolean }[];
};
type Cov = { model: Model; items: CovItem[]; links: { a: string; b: string; cost: number | null }[]; floors: Floor[]; sniffers: { id: string; name: string }[]; floor_height_m: number };
type Opts = { layer: string; opacity: number; names: boolean; links: boolean; ends: boolean; range: Range };

const OPTS_KEY = "zs.floors";
const FLOOR_KEY = "zs.floor";
const aspectOf = (f: Floor) => (f.size_m ? f.size_m[1] / f.size_m[0] : f.img_w && f.img_h ? f.img_h / f.img_w : 0.6);
const planUrl = (f: Floor) => `sniffer/floor/${encodeURIComponent(f.id)}/plan?v=${encodeURIComponent(f.image || "")}`;

function remembered(): string {
  try { return localStorage.getItem(FLOOR_KEY) || ""; } catch { return ""; }
}

async function mapChange(action: string, args: Record<string, any>, okText?: string): Promise<any> {
  return write("map", { action, args }, okText);
}

async function uploadPlan(fid: string, file: File): Promise<Floor> {
  const url = URL.createObjectURL(file);
  const [w, h] = await new Promise<[number, number]>((res) => {
    const im = new Image();
    im.onload = () => res([im.naturalWidth || 1000, im.naturalHeight || 700]);
    im.onerror = () => res([1000, 700]);
    im.src = url;
  });
  URL.revokeObjectURL(url);
  const r = await fetch(`sniffer/floor/${encodeURIComponent(fid)}/plan?w=${w}&h=${h}`, {
    method: "POST", headers: { "Content-Type": file.type || "image/png", "X-Studio": "1" }, body: file,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.e || `The plan wasn't saved (HTTP ${r.status})`);
  return d;
}

export function FloorMaps({ fid }: { fid?: string }) {
  const [opts, setOptsState] = useState<Opts>(() => loadOpts<Opts>(OPTS_KEY, { layer: "coverage", opacity: 0.6, names: true, links: false, ends: true, range: "24h" }));
  const setOpts = (o: Partial<Opts>) => { const n = { ...opts, ...o }; setOptsState(n); saveOpts(OPTS_KEY, n); };
  const meta = useSniffer<Meta>("/api/map", {}, 60);
  const cov = useSniffer<Cov>("/api/map/coverage", { range: opts.range }, 60);
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  const reload = () => { meta.reload(); cov.reload(); };
  const floors = meta.data?.floors || [];
  const floor = floors.find((f) => f.id === fid) || floors.find((f) => f.id === remembered()) || floors[0];
  useEffect(() => {
    if (floor) try { localStorage.setItem(FLOOR_KEY, floor.id); } catch { /* fine */ }
  }, [floor?.id]);
  const err = meta.err || cov.err;

  if (!meta.data) return err ? <p class="note warn"><Icon name="alert" size={16} /> {err}</p> : <Card><Empty>Loading the floor maps…</Empty></Card>;
  const layers = [{ v: "coverage", label: "Coverage (best router)" }, { v: "backup", label: "Backup coverage (second-best router)" },
    ...(cov.data?.sniffers || []).map((s) => ({ v: `heard:${s.id}`, label: `Heard by ${s.name} (measured)` })), { v: "none", label: "No heat map" }];
  const layer = layers.some((l) => l.v === opts.layer) ? opts.layer : "coverage";
  return (
    <div class="page-sub">
      {err && <p class="note warn"><Icon name="alert" size={16} /> {err}</p>}
      {floors.length > 0 && (
        <div class="toolbar">
          <Seg label="Floor" value={floor?.id || ""} onChange={(id) => go("map", "floors", id)} options={floors.map((f) => ({ v: f.id, label: f.name }))} />
          <button type="button" class="btn small" disabled={!control.value} title={control.value ? "Add a floor" : "Read-only: turn on Allow control in the add-on's configuration"}
            onClick={() => setAdding(!adding)}><Icon name="plus" size={14} /> Floor</button>
          <span class="spacer" />
          <button type="button" class={`btn small ${edit ? "primary" : ""}`} disabled={!control.value} aria-pressed={edit}
            title={control.value ? "Place devices, set the scale, rename or delete this floor" : "Read-only: turn on Allow control in the add-on's configuration"}
            onClick={() => setEdit(!edit)}><Icon name={edit ? "check" : "pencil"} size={14} /> {edit ? "Done" : "Edit layout"}</button>
        </div>
      )}
      {(adding || !floors.length) && <NewFloor first={!floors.length} meta={meta.data} onCancel={() => setAdding(false)}
        onAdded={(f) => { setAdding(false); setEdit(true); reload(); go("map", "floors", f.id); }} />}
      {floor && (
        <>
          {!edit && (
            <div class="toolbar">
              <label class="select-wrap">
                <span class="sr-only">Heat map</span>
                <select class="select" value={layer} onChange={(e) => setOpts({ layer: (e.target as HTMLSelectElement).value })}>
                  {layers.map((l) => <option value={l.v}>{l.label}</option>)}
                </select>
              </label>
              <label class="opacity">Heat map
                <input type="range" min="0" max="0.9" step="0.05" value={opts.opacity} aria-label="Heat map opacity"
                  onInput={(e) => setOpts({ opacity: +(e.target as HTMLInputElement).value })} />
              </label>
              <button type="button" class="btn small" aria-pressed={opts.names} onClick={() => setOpts({ names: !opts.names })}>Names</button>
              <button type="button" class="btn small" aria-pressed={opts.links} onClick={() => setOpts({ links: !opts.links })}>Mesh links</button>
              <button type="button" class="btn small" aria-pressed={opts.ends} onClick={() => setOpts({ ends: !opts.ends })}>End devices</button>
              <span class="spacer" />
              <Seg label="Range" value={opts.range} onChange={(v) => setOpts({ range: v })} options={RANGES} />
            </div>
          )}
          <FloorView key={floor.id} floor={floor} meta={meta.data} cov={cov.data} opts={{ ...opts, layer }} edit={edit} onChanged={reload} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- one floor

function FloorView({ floor, meta, cov, opts, edit, onChanged }: { floor: Floor; meta: Meta; cov: Cov | null; opts: Opts; edit: boolean; onChanged: () => void }) {
  const [ref, W] = useWidth();
  const H = Math.round(W * aspectOf(floor));
  const canvas = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; body: preact.ComponentChildren } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [scaling, setScaling] = useState<[number, number][] | null>(null);
  const [moving, setMoving] = useState<{ key: string; u: number; v: number } | null>(null);
  const drag = useRef<{ key: string; id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const model = cov?.model;
  const covFloor = cov?.floors.find((f) => f.id === floor.id) || floor;
  const heightM = cov?.floor_height_m ?? meta.floor_height_m;

  // placed routers with a strength, in metres (any floor: a router upstairs reaches down)
  const routers: [CovItem, number, number, number][] = [];
  if (cov && model?.ok) {
    for (const it of cov.items) {
      if (it.kind !== "device" || it.strength == null || !(it.type === "Router" || it.type === "Coordinator")) continue;
      const f = cov.floors.find((x) => x.id === it.floor);
      if (f?.size_m) routers.push([it, it.x * f.size_m[0], it.y * f.size_m[1], f.level || 0]);
    }
  }
  const estimate = (u: number, v: number): [number, CovItem][] => {
    if (!model?.ok || !covFloor.size_m) return [];
    const px = u * covFloor.size_m[0], py = v * covFloor.size_m[1], lvl = covFloor.level || 0;
    return routers.map(([it, x, y, l]): [number, CovItem] => {
      const fl = Math.abs(l - lvl);
      const d = Math.max(0.5, Math.hypot(x - px, y - py, fl * heightM));
      return [it.strength! - model.n10 * Math.log10(d) - model.floor_loss * fl, it];
    }).sort((a, b) => b[0] - a[0]);
  };
  const heardAt = (u: number, v: number, sid: string): { v: number; near: number } | null => {
    let ws = 0, vs = 0, near = 1e9;
    const aspect = aspectOf(floor);
    for (const it of cov?.items || []) {
      if (it.kind !== "device" || it.floor !== floor.id || !it.signal?.[sid]) continue;
      const d2 = (it.x - u) ** 2 + ((it.y - v) * aspect) ** 2;
      near = Math.min(near, d2);
      const w = 1 / (d2 + 0.0004);
      ws += w;
      vs += w * it.signal[sid].rssi;
    }
    return ws ? { v: vs / ws, near: Math.sqrt(near) } : null;
  };

  let note = "";
  if (!edit && opts.layer !== "none") {
    if (opts.layer === "coverage" || opts.layer === "backup") {
      if (!covFloor.size_m) note = "Set this floor's scale (Edit layout) to estimate coverage.";
      else if (!model?.ok) note = model?.why ? `Coverage can't be estimated yet: it ${model.why}.` : "Coverage can't be estimated yet.";
    }
  }

  // the heat map: a coarse grid, smoothed by the browser; its opacity is the canvas's
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const gw = 160, gh = Math.max(20, Math.round(gw * aspectOf(floor)));
    cv.width = gw;
    cv.height = gh;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, gw, gh);
    if (edit || opts.layer === "none" || note) return;
    const cols = heatColours(cv);
    const img = ctx.createImageData(gw, gh);
    const sid = opts.layer.startsWith("heard:") ? opts.layer.slice(6) : null;
    const k = opts.layer === "backup" ? 1 : 0;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const u = (i + 0.5) / gw, v = (j + 0.5) / gh, o = (j * gw + i) * 4;
      let val: number | null = null, alpha = 255;
      if (sid) {
        const h = heardAt(u, v, sid);
        if (h) { val = h.v; alpha = Math.round(255 * Math.max(0, 1 - Math.max(0, h.near - 0.12) / 0.25)); }
      } else {
        const e = estimate(u, v);
        if (e[k]) val = e[k][0];
      }
      if (val === null) continue;
      const c = heatRGB(val, cols);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = alpha;
    }
    ctx.putImageData(img, 0, 0);
  }, [floor, cov, opts.layer, edit, note]);

  // what's on this floor
  const itemByKey = new Map(meta.items.map((i) => [i.key, i]));
  const covByKey = new Map((cov?.items || []).map((i) => [i.key, i]));
  const placed: CovItem[] = Object.entries(meta.positions).filter(([, p]) => p.floor === floor.id).map(([key, p]) => {
    const c = covByKey.get(key);
    const it = itemByKey.get(key) || { key, kind: key.startsWith("sniffer:") ? "sniffer" : "device", name: key, type: key.startsWith("sniffer:") ? "Sniffer" : "" } as Item;
    return { ...(c || {}), ...it, ...p, sev: c?.sev, floor: floor.id } as CovItem;
  }).filter((it) => edit || opts.ends || it.type !== "EndDevice");
  const pos = (it: CovItem): [number, number] => (moving && moving.key === it.key ? [moving.u * W, moving.v * H] : [it.x * W, it.y * H]);
  const byAddr = new Map(placed.filter((i) => i.addr).map((i) => [i.addr!, i]));
  const links = opts.links && !edit ? (cov?.links || []).filter((l) => byAddr.has(l.a) && byAddr.has(l.b)) : [];

  const local = (e: PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const save = async (key: string, u: number, v: number) => {
    try {
      await mapChange("positions", { set: { [key]: { floor: floor.id, x: u, y: v } } });
      onChanged();
    } catch { /* toasted */ }
  };
  const markerTip = (it: CovItem, e: PointerEvent) => {
    const [u, v] = local(e);
    const names = Object.fromEntries((cov?.sniffers || []).map((s) => [s.id, s.name]));
    setTip({ x: u * W, y: v * H, body: (
      <>
        <div class="tip-head">{typeWord(it.kind === "sniffer" ? "Sniffer" : it.type)}{it.model ? ` · ${it.model}` : ""}</div>
        <div class="tip-title">{it.name.replace(/^Sniffer: /, "")}</div>
        {Object.entries(it.signal || {}).map(([sid, s]) => <div class="tip-row"><b>{Math.round(s.rssi)} dBm</b> at {names[sid] || sid}</div>)}
        {it.strength != null && (it.type === "Router" || it.type === "Coordinator") && <div class="tip-row"><b>{it.strength} dBm</b> at 1 m ({it.strength_from})</div>}
        {(it.flags || []).map((f) => <div class="muted small">{f}</div>)}
        {edit && <div class="muted small">Drag to move</div>}
      </>
    ) });
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) {
      if (d.id !== e.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.moved = true;
      const [u, v] = local(e);
      setMoving({ key: d.key, u, v });
      return;
    }
    if (e.pointerType === "touch" || edit) return;
    if ((e.target as Element).closest?.(".marker")) return;
    const [u, v] = local(e);
    if (opts.layer === "coverage" || opts.layer === "backup") {
      const p = estimate(u, v);
      if (!p.length) { setTip(null); return; }
      setTip({ x: u * W, y: v * H, body: (
        <>
          <div class="tip-head">Estimated here</div>
          <div class="tip-row"><b>{Math.round(p[0][0])} dBm</b> {signalWord(p[0][0])}, from {p[0][1].name}</div>
          {p[1] && <div class="tip-row"><b>{Math.round(p[1][0])} dBm</b> backup, from {p[1][1].name}</div>}
        </>
      ) });
    } else if (opts.layer.startsWith("heard:")) {
      const h = heardAt(u, v, opts.layer.slice(6));
      setTip(h ? { x: u * W, y: v * H, body: (
        <><div class="tip-head">From nearby devices</div><div class="tip-row"><b>{Math.round(h.v)} dBm</b> {signalWord(h.v)}</div></>
      ) } : null);
    }
  };
  const onDown = (it: CovItem) => (e: PointerEvent) => {
    if (!edit || armed || scaling) return;
    e.preventDefault();
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { key: it.key, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    setTip(null);
  };
  const onUp = async (e: PointerEvent) => {
    const d = drag.current;
    if (d) {
      drag.current = null;
      if (d.moved) {
        const [u, v] = local(e);
        await save(d.key, u, v);
        setMoving(null);
      }
      return;
    }
    const [u, v] = local(e);
    if (edit && scaling) {
      setScaling(scaling.length >= 2 ? [[u, v]] : [...scaling, [u, v]]);
      return;
    }
    if (edit && armed) {
      const key = armed;
      setArmed(null);
      await save(key, u, v);
      return;
    }
    const m = (e.target as Element).closest?.(".marker") as SVGGElement | null;
    if (m && !edit) {
      const dev = devByKey.value.get(m.dataset.key || "");
      if (dev && dev.type !== "Coordinator") go("device", dev.ieee, "sniffer");
    }
  };

  const gridPx = floor.size_m ? W / floor.size_m[0] : 40;
  const markR = (it: CovItem) => (it.kind === "sniffer" ? 7 : it.type === "Coordinator" ? 8 : it.type === "EndDevice" ? 4.5 : 6.5);
  const markName = (it: CovItem) => it.name.replace(/^Sniffer: /, "");
  const sides = opts.names ? placeLabels(placed.map((it) => {
    const [x, y] = pos(it);
    return { key: it.key, x, y, r: markR(it), text: markName(it), rank: it.kind === "sniffer" ? 0 : it.type === "EndDevice" ? 2 : 1 };
  }), W) : new Map<string, "r" | "l">();
  return (
    <div class={edit ? "floor-layout editing" : "floor-layout"}>
      <Card class="floor-card">
        <div class="floor-box" ref={ref} style={{ height: `${H}px` }}>
          {floor.image ? <img class="floor-plan" src={planUrl(floor)} alt={`Plan of ${floor.name}`} draggable={false} />
            : <div class="floor-grid" style={{ backgroundSize: `${gridPx}px ${gridPx}px` }} />}
          <canvas ref={canvas} class="floor-heat" style={{ opacity: opts.opacity }} />
          <svg ref={svgRef} class={`floor-svg ${edit ? "edit" : ""} ${armed || scaling ? "aiming" : ""}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
            onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setTip(null)}
            onPointerCancel={() => { drag.current = null; setMoving(null); }}>
            {links.map((l) => {
              const a = byAddr.get(l.a)!, b = byAddr.get(l.b)!;
              const [x1, y1] = pos(a), [x2, y2] = pos(b);
              return <line class={`link cost-line-${costClass(l.cost)}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
            {scaling && scaling.map(([u, v]) => <circle cx={u * W} cy={v * H} r={5} class="scale-pt" />)}
            {scaling && scaling.length === 2 && <line class="scale-line" x1={scaling[0][0] * W} y1={scaling[0][1] * H} x2={scaling[1][0] * W} y2={scaling[1][1] * H} />}
            {placed.map((it) => {
              const [x, y] = pos(it);
              const sniffer = it.kind === "sniffer";
              const r = markR(it), side = sides.get(it.key);
              const cls = sniffer ? "n-sniffer" : it.type === "Coordinator" ? "n-coord" : (it.sev ?? 0) >= 3 ? "n-bad" : (it.sev ?? 0) >= 2 ? "n-warn" : it.type === "EndDevice" ? "n-end" : "n-router";
              return (
                <g class={`marker ${edit ? "drag" : ""}`} data-key={it.key} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
                  onPointerDown={onDown(it) as any} onPointerMove={(e) => !drag.current && !armed && !scaling && markerTip(it, e as PointerEvent)}
                  onPointerLeave={() => setTip(null)}>
                  <circle r={13} class="hit" />
                  {sniffer ? <rect x={-7} y={-7} width={14} height={14} rx={3} class={`dot ${cls}`} /> : <circle r={r} class={`dot ${cls}`} />}
                  {side && <text x={side === "r" ? r + 4 : -r - 4} y={4} text-anchor={side === "r" ? "start" : "end"} class="node-name">{markName(it)}</text>}
                </g>
              );
            })}
          </svg>
          {note && <div class="floor-note">{note}</div>}
          {tip && <MapTip x={tip.x} y={tip.y} w={W}>{tip.body}</MapTip>}
        </div>
        <div class="map-foot">
          {!edit && opts.layer !== "none" && <HeatLegend />}
          <span class="chart-legend map-legend">
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="dot n-router" /></svg>Router</span>
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="3.5" class="dot n-end" /></svg>End device</span>
            <span><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" class="dot n-coord" /></svg>Coordinator</span>
            <span><svg width="14" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="3" class="dot n-sniffer" /></svg>Sniffer</span>
            <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" class="dot n-warn" /></svg>Needs attention</span>
          </span>
          {links.length > 0 && <CostLegend />}
          {!edit && <ModelNote model={model} sniffers={cov?.sniffers.length || 0} />}
        </div>
      </Card>
      {edit && <EditPanel floor={floor} meta={meta} cov={cov} armed={armed} setArmed={setArmed} scaling={scaling} setScaling={setScaling} onChanged={onChanged} />}
    </div>
  );
}

function ModelNote({ model, sniffers }: { model: Model | undefined; sniffers: number }) {
  if (!model) return null;
  if (!model.ok) {
    return <p class="muted small">To estimate coverage, place your sniffer{sniffers > 1 ? "s" : ""} and the devices on floors with a scale (the Sniffer {model.why}).</p>;
  }
  const others = (model.gains || []).filter((g) => !g.ref), ref = (model.gains || []).find((g) => g.ref);
  return (
    <p class="muted small">
      Estimated from {model.samples} measurements of {model.devices} devices at your placed sniffers: signal falls
      about {Math.round(model.n10)} dB per tenfold distance{model.n_fixed ? " (assumed)" : ""} and {model.floor_loss} dB per
      floor{model.floor_loss_fitted ? "" : " (assumed)"}, typically within ±{model.rmse} dB. Walls only count on average, so treat it
      as a guide.{" "}
      {model.devices_with_strength ? `${model.devices_with_strength} devices' own strength is known (heard by two sniffers); the others use their model's or the house's. ` : ""}
      {others.length > 0 && `Antennas: ${others.map((g) => `${g.name || g.sniffer} hears ${Math.abs(g.db)} dB ${g.db >= 0 ? "louder" : "quieter"}`).join(", ")} than ${ref?.name || ref?.sniffer || "the first sniffer"}.`}
    </p>
  );
}

// ---------------------------------------------------------------------- editing

function EditPanel({ floor, meta, cov, armed, setArmed, scaling, setScaling, onChanged }: {
  floor: Floor; meta: Meta; cov: Cov | null; armed: string | null; setArmed: (k: string | null) => void;
  scaling: [number, number][] | null; setScaling: (p: [number, number][] | null) => void; onChanged: () => void;
}) {
  const [name, setName] = useState(floor.name);
  const [level, setLevel] = useState(String(floor.level ?? 0));
  const [dist, setDist] = useState("");
  const [unit, setUnit] = useState("1");
  const [wm, setWm] = useState(String(floor.width_m ?? ""));
  const [hm, setHm] = useState(String(floor.height_m ?? ""));
  const [fh, setFh] = useState(String(cov?.floor_height_m ?? meta.floor_height_m));
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<any>) => {
    setBusy(true);
    try { await f(); onChanged(); } catch { /* toasted */ } finally { setBusy(false); }
  };
  const del = async () => {
    const n = Object.values(meta.positions).filter((p) => p.floor === floor.id).length;
    if (!await confirmIt({ title: `Delete ${floor.name}?`, danger: true, confirm: "Delete floor",
      body: <p>{n
        ? `${n === 1 ? "The one device or sniffer placed on it loses its place" : `The ${n} devices and sniffers placed on it lose their places`}${floor.image ? ", and its plan is deleted" : ""}. The devices themselves are not touched.`
        : `Nothing is placed on it${floor.image ? "; its plan is deleted" : ""}.`}</p> })) return;
    await run(() => mapChange("delete_floor", { floor: floor.id }, `Deleted ${floor.name}`));
    go("map", "floors");
  };
  const saveScale = () => {
    const metres = parseFloat(dist) * parseFloat(unit);
    if (!(metres > 0) || !scaling || scaling.length < 2) { toast("warn", "Click two points, then give the distance between them"); return; }
    const [a, b] = scaling;
    const px = Math.hypot((a[0] - b[0]) * (floor.img_w || 1000), (a[1] - b[1]) * (floor.img_h || 700));
    if (!(px > 0)) { toast("warn", "Click two different points"); return; }
    run(async () => { await mapChange("update_floor", { floor: floor.id, scale: px / metres }, "Scale saved"); setScaling(null); });
  };

  // what's left to place: sniffers first, then by room, rooms on this floor first
  const r = rooms.value;
  const haFloorOf = (it: Item) => (it.kind === "device" ? areaOf(it.key)?.floor : undefined);
  const haHere = r?.floors.find((f) => f.name.toLowerCase() === floor.name.toLowerCase()) ||
    r?.floors.find((f) => f.level !== null && f.level === floor.level);
  const ql = q.trim().toLowerCase();
  const unplaced = meta.items.filter((it) => !meta.positions[it.key] && (!ql || it.name.toLowerCase().includes(ql) || (it.addr || "").includes(ql) || (areaOf(it.key)?.name || "").toLowerCase().includes(ql)));
  const groups = new Map<string, Item[]>();
  for (const it of unplaced) {
    const g = it.kind === "sniffer" ? "Sniffers" : areaOf(it.key)?.name || "No room";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(it);
  }
  const rank = (g: string, items: Item[]) => (g === "Sniffers" ? 0 : haHere && items.some((i) => haFloorOf(i) === haHere.id) ? 1 : g === "No room" ? 3 : 2);
  const ordered = [...groups.entries()].sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]) || a[0].localeCompare(b[0]));
  const here = Object.entries(meta.positions).filter(([, p]) => p.floor === floor.id).map(([k]) => meta.items.find((i) => i.key === k) || { key: k, name: k, kind: "device", type: "" } as Item);

  return (
    <Card class="floor-side" title="Edit layout">
      <div class="form-grid one">
        <label>Name<input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        <label>Level <span class="muted small">0 = ground floor, 1 = above, −1 = basement</span>
          <input type="number" value={level} onInput={(e) => setLevel((e.target as HTMLInputElement).value)} /></label>
      </div>
      <div class="toolbar">
        <button type="button" class="btn small" disabled={busy} onClick={() => run(() => mapChange("update_floor", { floor: floor.id, name, level: parseInt(level) || 0 }, "Floor saved"))}>Save</button>
        <label class="btn small file-btn"><Icon name="upload" size={14} /> {floor.image ? "Replace plan" : "Upload plan"}
          <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" class="sr-only"
            onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) run(async () => {
                try {
                  await uploadPlan(floor.id, file);
                } catch (err: any) {
                  toast("error", err?.message || String(err));
                  throw err;
                }
                toast("ok", "Plan uploaded", 3000);
              });
            }} />
        </label>
        <button type="button" class="btn small danger" disabled={busy} onClick={del}><Icon name="trash" size={14} /> Delete floor</button>
      </div>

      <h3>Scale</h3>
      {floor.image ? (
        <>
          <p class="muted small">{floor.size_m ? `${floor.size_m[0].toFixed(1)} × ${floor.size_m[1].toFixed(1)} m.` : "Not set: coverage needs it."} Mark two points on the plan a known distance apart.</p>
          {!scaling ? <button type="button" class="btn small" onClick={() => { setArmed(null); setScaling([]); }}>Set scale</button> : (
            <div class="note info">
              {scaling.length < 2 ? <>Click two points on the plan ({scaling.length} of 2).</> : (
                <div class="toolbar">
                  <span>Distance</span>
                  <input class="small-input" type="number" step="0.1" value={dist} aria-label="Distance between the points" onInput={(e) => setDist((e.target as HTMLInputElement).value)} />
                  <select class="select small" value={unit} aria-label="Unit" onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}><option value="1">m</option><option value="0.3048">ft</option></select>
                  <button type="button" class="btn small primary" disabled={busy} onClick={saveScale}>Save scale</button>
                </div>
              )}
              <button type="button" class="link-btn" onClick={() => setScaling(null)}>Cancel</button>
            </div>
          )}
        </>
      ) : (
        <div class="toolbar">
          <input class="small-input" type="number" step="0.1" value={wm} aria-label="Width in metres" onInput={(e) => setWm((e.target as HTMLInputElement).value)} />
          <span>×</span>
          <input class="small-input" type="number" step="0.1" value={hm} aria-label="Depth in metres" onInput={(e) => setHm((e.target as HTMLInputElement).value)} />
          <span>m</span>
          <button type="button" class="btn small" disabled={busy} onClick={() => run(() => mapChange("update_floor", { floor: floor.id, width_m: parseFloat(wm), height_m: parseFloat(hm) }, "Size saved"))}>Save size</button>
        </div>
      )}
      <p class="muted small">Plans of different floors are taken as drawn on the same grid (same corner, same scale), so the same spot lines up across levels.</p>
      <div class="toolbar">
        <span class="small">Height between floors</span>
        <input class="small-input" type="number" step="0.1" value={fh} aria-label="Height between floors in metres" onInput={(e) => setFh((e.target as HTMLInputElement).value)} />
        <span>m</span>
        <button type="button" class="btn small" disabled={busy} onClick={() => run(() => mapChange("update_floor", { floor: floor.id, floor_height_m: parseFloat(fh) }, "Saved"))}>Save</button>
      </div>

      <h3>Place</h3>
      <p class="muted small">Pick a device or sniffer, then click the plan. Drag placed ones to move them.</p>
      <Search value={q} onInput={setQ} placeholder="Device, room or address" />
      <div class="place-list">
        {!ordered.length && <p class="muted small">{ql ? "Nothing matches." : "Everything is placed."}</p>}
        {ordered.map(([g, items]) => (
          <div class="place-group">
            <div class="place-head">{g}</div>
            {items.map((it) => (
              <button type="button" class={`place ${armed === it.key ? "armed" : ""}`} aria-pressed={armed === it.key}
                onClick={() => { setScaling(null); setArmed(armed === it.key ? null : it.key); }}>
                <span class="tag">{typeWord(it.kind === "sniffer" ? "Sniffer" : it.type) || "?"}</span>{it.name.replace(/^Sniffer: /, "")}
              </button>
            ))}
          </div>
        ))}
        {here.length > 0 && (
          <div class="place-group">
            <div class="place-head">On this floor</div>
            {here.map((it) => (
              <div class="placed">
                <span>{it.name.replace(/^Sniffer: /, "")}</span>
                <button type="button" class="link-btn" disabled={busy} onClick={() => run(() => mapChange("positions", { clear: [it.key] }))}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function NewFloor({ first, meta, onAdded, onCancel }: { first: boolean; meta: Meta; onAdded: (f: Floor) => void; onCancel: () => void }) {
  const r = rooms.value;
  const taken = new Set(meta.floors.map((f) => f.name.toLowerCase()));
  const suggestions = (r?.floors || []).filter((f) => !taken.has(f.name.toLowerCase())).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const [name, setName] = useState(suggestions[0]?.name || "");
  const [level, setLevel] = useState(String(suggestions[0]?.level ?? meta.floors.length));
  const [file, setFile] = useState<File | null>(null);
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const add = async () => {
    const wm = parseFloat(w), hm = parseFloat(h);
    if (!name.trim()) { setMsg("Give the floor a name."); return; }
    if (!file && !(wm > 0 && hm > 0)) { setMsg("Choose a plan image, or give a width and depth."); return; }
    setBusy(true);
    setMsg("");
    try {
      const f: Floor = await mapChange("add_floor", { name: name.trim(), level: parseInt(level) || 0, ...(file ? {} : { width_m: wm, height_m: hm }) });
      if (file) await uploadPlan(f.id, file);
      toast("ok", `Added ${f.name}`, 3000);
      onAdded(f);
    } catch (e: any) {
      setMsg(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!control.value) {
    return (
      <Card title="Floor maps">
        <Empty>No floors yet. Setting them up changes the Zigbee Sniffer's map, so it needs Allow control on in this add-on's configuration (or use the Sniffer's own Map page).</Empty>
      </Card>
    );
  }
  return (
    <Card title={first ? "Add your first floor" : "Add a floor"}>
      <p class="muted small">
        Upload a floor plan (PNG, JPG, SVG) and set its scale by marking two points a known distance apart, or start from a blank grid of a
        given size. Then place your sniffers and devices: the Sniffer estimates coverage from what its sniffers hear of them.
      </p>
      {suggestions.length > 0 && (
        <div class="checks">
          <span class="muted small">Your floors in Home Assistant:</span>
          {suggestions.map((f) => (
            <button type="button" class="btn small" aria-pressed={name === f.name} onClick={() => { setName(f.name); setLevel(String(f.level ?? 0)); }}>
              {f.name}{f.level !== null ? ` · level ${f.level}` : ""}
            </button>
          ))}
        </div>
      )}
      <div class="form-grid">
        <label>Name<input type="text" value={name} placeholder="Main floor" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        <label>Level<input type="number" value={level} onInput={(e) => setLevel((e.target as HTMLInputElement).value)} /></label>
        <label>Plan image<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] || null)} /></label>
        <label>or a blank grid, width × depth (m)
          <span class="pair">
            <input type="number" step="0.1" value={w} placeholder="20" aria-label="Width in metres" disabled={!!file} onInput={(e) => setW((e.target as HTMLInputElement).value)} />
            <input type="number" step="0.1" value={h} placeholder="12" aria-label="Depth in metres" disabled={!!file} onInput={(e) => setH((e.target as HTMLInputElement).value)} />
          </span>
        </label>
      </div>
      <div class="toolbar">
        <button type="button" class="btn primary" disabled={busy} onClick={add}>{busy ? "Adding…" : "Add floor"}</button>
        {!first && <button type="button" class="btn" onClick={onCancel}>Cancel</button>}
        {msg && <span class="warn-text small" role="status">{msg}</span>}
      </div>
    </Card>
  );
}
