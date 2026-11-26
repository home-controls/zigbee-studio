// Live log: Zigbee2MQTT's log as it happens, with the last 1000 lines kept by the add-on (so a
// reload, or a restart of the add-on, doesn't lose them). The page opens with the last 300 and
// asks for the rest here.

import { useEffect, useRef, useState } from "preact/hooks";
import { call } from "../conn";
import { logs } from "../store";
import { clock, matches } from "../format";
import { Icon } from "../icons";
import { Search, Seg, Empty } from "../ui";
import type { LogEntry } from "../types";

type Level = "all" | "info" | "warning" | "error";
const RANK: Record<string, number> = { debug: 0, info: 1, warning: 2, warn: 2, error: 3 };

export function Logs({ initial }: { initial?: string }) {
  const [q, setQ] = useState(initial || "");
  const [level, setLevel] = useState<Level>("all");
  const [paused, setPaused] = useState<LogEntry[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    call("logs").then((all: LogEntry[]) => {
      if (!Array.isArray(all) || all.length <= logs.value.length) return;
      const last = all.length ? all[all.length - 1].ts : 0;
      logs.value = [...all, ...logs.value.filter((l) => l.ts > last)];
    }).catch(() => undefined);
  }, []);
  const source = paused ?? logs.value;
  const min = level === "all" ? 0 : RANK[level];
  const shown = source.filter((l) => (RANK[l.level] ?? 1) >= min && (!q || matches(q, l.msg, l.ns)));
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, shown[shown.length - 1]]);
  return (
    <div class="page logs-page">
      <div class="page-head">
        <div>
          <h1>Log</h1>
          <p class="lede">{shown.length} of {source.length} lines{paused ? " · paused" : " · live"}</p>
        </div>
        <div class="toolbar">
          <Search value={q} onInput={setQ} placeholder="Filter lines" />
          <Seg label="Level" value={level} onChange={setLevel} options={[
            { v: "all", label: "All" }, { v: "info", label: "Info+" }, { v: "warning", label: "Warnings+" }, { v: "error", label: "Errors" },
          ]} />
          <button type="button" class="btn" onClick={() => setPaused(paused ? null : logs.value)} aria-pressed={!!paused}>
            <Icon name={paused ? "play" : "pause"} size={15} /> {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      <div class="log card" ref={box} onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {shown.length === 0 && <Empty>Nothing yet. Lines appear here as Zigbee2MQTT logs them.</Empty>}
        {shown.map((l) => (
          <div class={`log-line lv-${l.level}`}>
            <span class="log-ts">{clock(l.ts)}</span>
            <span class="log-lv">{l.level}</span>
            {l.ns && <span class="log-ns">{l.ns}</span>}
            <span class="log-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
