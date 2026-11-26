// Live frames from the Zigbee Sniffer, decoded: who sent what to whom, at what signal, resent or
// not, heard by which sniffer. Polls the add-on every 2 s while the page is open and visible.

import { useEffect, useRef, useState } from "preact/hooks";
import { call } from "../conn";
import { matches } from "../format";
import { Icon } from "../icons";
import { snifferPanel } from "../store";
import { Card, Empty, Ext, Search, Seg } from "../ui";
import { Frames } from "./DeviceSniffer";

const KEEP = 500;

export function Traffic() {
  const [frames, setFrames] = useState<any[]>([]);
  const [paused, setPaused] = useState(false);
  const [scope, setScope] = useState<"ours" | "all">("ours");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const last = useRef(0);
  const seen = useRef<[number, number][]>([]); // (time, frames) for the rate

  useEffect(() => {
    last.current = 0;
    setFrames([]);
  }, [scope]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const d = await call("sniffer", {
            path: "/api/live", q: { after: String(last.current), decode: "1", ...(scope === "all" ? { others: "1" } : {}) },
          }, 30000);
          if (!alive) return;
          const fresh: any[] = d.frames || [];
          if (fresh.length) setFrames((prev) => [...[...fresh].reverse(), ...prev].slice(0, KEEP));
          const now = Date.now() / 1000;
          if (last.current) seen.current.push([now, d.last_id - last.current]);
          seen.current = seen.current.filter(([t]) => now - t < 15);
          const span = seen.current.length > 1 ? now - seen.current[0][0] : 0;
          setRate(span > 3 ? seen.current.slice(1).reduce((a, [, n]) => a + n, 0) / span : null);
          last.current = d.last_id || last.current;
          setErr(null);
        } catch (e: any) {
          if (alive) setErr(e?.message || String(e));
        }
      }
      if (alive) timer = window.setTimeout(poll, 2000);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [paused, scope]);

  const shown = q ? frames.filter((f) => matches(q, f.src_name, f.dst_name, f.nwk_src_name, f.nwk_dst_name, f.info, f.kind, f.src, f.dst, f.nwk_src, f.nwk_dst)) : frames;
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Traffic</h1>
          <p class="lede">Live frames from the Zigbee Sniffer, decoded{rate !== null ? ` · about ${Math.round(rate)} frames/s` : ""}</p>
        </div>
        {snifferPanel.value && <Ext href={snifferPanel.value}>Zigbee Sniffer</Ext>}
      </div>
      <div class="toolbar">
        <Search value={q} onInput={setQ} placeholder="Device, command or address" />
        <Seg label="Networks" value={scope} onChange={setScope} options={[{ v: "ours", label: "Ours" }, { v: "all", label: "All networks" }]} />
        <button type="button" class={`btn small ${paused ? "primary" : ""}`} onClick={() => setPaused(!paused)}>
          <Icon name={paused ? "play" : "pause"} size={14} /> {paused ? "Resume" : "Pause"}
        </button>
      </div>
      {err && <p class="note warn"><Icon name="alert" size={16} /> {err}</p>}
      <Card>
        {shown.length === 0 ? <Empty>{frames.length ? "No frame matches." : err ? "Nothing yet." : "Waiting for frames…"}</Empty>
          : <Frames frames={shown.slice(0, 300)} />}
        {shown.length > 300 && <p class="muted small">Showing the newest 300 of {shown.length}.</p>}
      </Card>
    </div>
  );
}
