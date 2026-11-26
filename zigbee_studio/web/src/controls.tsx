// Controls for Zigbee2MQTT exposes. Every value is live (the device's own state signal); writes go
// through setState (refused, with a note, in read-only mode).

import { useState } from "preact/hooks";
import type { Signal } from "@preact/signals";
import { setState, write } from "./conn";
import { confirmIt } from "./dialog";
import { control } from "./store";
import { canGet, canSet, feature, label, prop } from "./exposes";
import { kelvin, miredToCss, num, title, xyToCss } from "./format";
import { Icon } from "./icons";
import { Seg, Slider, Toggle } from "./ui";
import type { Dev, Expose, State } from "./types";

/** Devices that move things or guard the house: ask before sending anything. */
export function sensitive(dev: Dev | undefined, e?: Expose): boolean {
  if (e && ["lock", "cover", "climate"].includes(e.type)) return true;
  return !!dev && /garage door|gate|lock|alarm/i.test(dev.name);
}

async function send(key: string, dev: Dev | undefined, payload: Record<string, any>, e?: Expose): Promise<void> {
  if (control.value && sensitive(dev, e) && !(await confirmIt({ title: `Send to ${dev?.name ?? key}?`, body: <code>{JSON.stringify(payload)}</code>, confirm: "Send" }))) return;
  await setState(key, payload);
}

/** Ask the device for a value. A composite's part is asked for under the composite (Zigbee2MQTT
 *  only has converters for the composite's own property, e.g. level_config). */
function refresh(key: string, property: string, parent?: string) {
  const payload = parent ? { [parent]: { [property]: "" } } : { [property]: "" };
  write("get", { key, payload }, "Asked the device").catch(() => undefined);
}

/** A light's colour lives under its colour feature's property ("color", or "color_l2" on a
 *  light with several endpoints), and its colour mode beside it ("color_mode_l2"). */
function colourKeys(e: Expose): { cp: string; cm: string } {
  const cp = prop(feature(e, "color_hs") || feature(e, "color_xy")) || "color";
  return { cp, cm: `color_mode${cp.startsWith("color") ? cp.slice(5) : ""}` };
}

// ------------------------------------------------------------------ dispatch

export function ExposeControl({ k, dev, e, st, compact }: { k: string; dev?: Dev; e: Expose; st: Signal<State>; compact?: boolean }) {
  switch (e.type) {
    case "light":
      return <LightControl k={k} dev={dev} e={e} st={st} compact={compact} />;
    case "switch":
      return <SwitchControl k={k} dev={dev} e={e} st={st} />;
    case "cover":
    case "lock":
    case "climate":
    case "fan":
      return <SpecificControl k={k} dev={dev} e={e} st={st} />;
    case "composite":
      return <CompositeControl k={k} dev={dev} e={e} st={st} />;
    default:
      return <Field k={k} dev={dev} e={e} value={st.value[prop(e)!]} onSet={(v) => send(k, dev, { [prop(e)!]: v }, e)} />;
  }
}

// ------------------------------------------------------------------ one generic value

export function Field({ k, dev, e, value, onSet, empty, parent }: { k: string; dev?: Dev; e: Expose; value: any; onSet: (v: any) => void; empty?: string; parent?: string }) {
  const settable = canSet(e) && control.value;
  const gettable = canGet(e) && !!prop(e);
  return (
    <div class={`field ${settable ? "settable" : ""}`} title={e.description}>
      <div class="field-label">
        {label(e)}
        {e.endpoint && <span class="ep">{e.endpoint}</span>}
        {gettable && control.value && (
          <button type="button" class="icon-btn tiny" title="Read from the device" aria-label={`Read ${label(e)} from the device`}
            onClick={() => refresh(k, prop(e)!, parent)}>
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>
      <div class="field-value">
        <Value e={e} value={value} settable={settable} onSet={onSet} name={dev?.name} empty={empty} />
      </div>
    </div>
  );
}

function Value({ e, value, settable, onSet, name, empty }: { e: Expose; value: any; settable: boolean; onSet: (v: any) => void; name?: string; empty?: string }) {
  if (e.type === "binary") {
    const on = value === undefined ? undefined : value === (e.value_on ?? true);
    if (!settable) return <span class={`bool ${on ? "on" : ""}`}>{value === undefined ? "—" : on ? title(String(e.value_on ?? "on")) : title(String(e.value_off ?? "off"))}</span>;
    return <Toggle on={on} label={`${label(e)} of ${name}`} onChange={(v) => onSet(v ? e.value_on ?? true : e.value_off ?? false)} />;
  }
  if (e.type === "enum") {
    const values = e.values || [];
    if (!settable) return <span>{value === undefined || value === null ? "—" : title(String(value))}</span>;
    if (values.length <= 4 && values.every((v) => String(v).length <= 12)) {
      return <Seg label={label(e)} value={String(value)} options={values.map((v) => ({ v: String(v), label: title(String(v)) }))}
        onChange={(v) => control.value && onSet(values.find((x) => String(x) === v))} />;
    }
    return (
      <select value={value ?? ""} disabled={!control.value} aria-label={label(e)} onChange={(ev) => onSet((ev.target as HTMLSelectElement).value)}>
        {value === undefined && <option value="">{empty ?? "—"}</option>}
        {values.map((v) => <option value={String(v)}>{title(String(v))}</option>)}
      </select>
    );
  }
  if (e.type === "numeric") {
    if (!settable) return <span class="num">{num(value, e.unit)}</span>;
    return <NumericInput e={e} value={value} onSet={onSet} empty={empty} />;
  }
  if (e.type === "text") {
    if (!settable) return <span class="text">{value ?? "—"}</span>;
    return <TextInput value={value} onSet={onSet} label={label(e)} />;
  }
  if (e.type === "list" && settable) return <ListInput e={e} value={value} onSet={onSet} />;
  return <code class="json">{value === undefined ? "—" : JSON.stringify(value)}</code>;
}

/** A list (a Hue gradient's colours, a thermostat schedule...): simple items as a comma-separated
 *  line, anything else as JSON, checked before it is sent whole. */
function ListInput({ e, value, onSet }: { e: Expose; value: any; onSet: (v: any[]) => void }) {
  const it = e.item_type?.type;
  const simple = it === "numeric" || it === "text" || it === "enum" || it === "binary";
  const shown = Array.isArray(value) ? (simple ? value.join(", ") : JSON.stringify(value, null, 1)) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const parse = (raw: string): any[] | null => {
    if (simple) {
      const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
      return it === "numeric" ? (parts.every((x) => !Number.isNaN(Number(x))) ? parts.map(Number) : null) : parts;
    }
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const n = (e.length_min ?? 0), m = e.length_max;
  const apply = () => {
    if (draft === null) return;
    const v = parse(draft);
    if (!v) { setBad(simple ? (it === "numeric" ? "Numbers only, separated by commas" : "Separate the items with commas") : "That isn't a JSON list"); return; }
    if (v.length < n || (m !== undefined && v.length > m)) { setBad(`Between ${n} and ${m ?? "any number of"} items`); return; }
    setBad(null);
    setDraft(null);
    onSet(v);
  };
  return (
    <div class="json-edit">
      {simple
        ? <input type="text" value={draft ?? shown} aria-label={label(e)} onInput={(ev) => setDraft((ev.target as HTMLInputElement).value)} onKeyDown={(ev) => ev.key === "Enter" && apply()} />
        : <textarea class={`set-area mono ${bad ? "bad" : ""}`} rows={4} value={draft ?? shown} aria-label={label(e)} onInput={(ev) => setDraft((ev.target as HTMLTextAreaElement).value)} />}
      {draft !== null && (
        <div class="row-btns">
          <button type="button" class="btn small primary" onClick={apply}>Apply</button>
          <button type="button" class="link-btn small" onClick={() => { setDraft(null); setBad(null); }}>Undo</button>
        </div>
      )}
      {bad && <span class="bad-text small">{bad}</span>}
    </div>
  );
}

function NumericInput({ e, value, onSet, empty }: { e: Expose; value: any; onSet: (v: number) => void; empty?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const hasRange = e.value_min !== undefined && e.value_max !== undefined && e.value_max - e.value_min <= 1000;
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (!Number.isNaN(v) && v !== value) onSet(v);
  };
  return (
    <div class="numeric">
      {hasRange && (
        <Slider value={value} min={e.value_min!} max={e.value_max!} step={e.value_step || 1} label="" onSend={onSet}
          format={(v) => num(v, e.unit)} empty={empty} />
      )}
      {!hasRange && (
        <span class="num-input">
          <input type="number" value={draft ?? value ?? ""} min={e.value_min} max={e.value_max} step={e.value_step || "any"}
            disabled={!control.value} aria-label={label(e)} placeholder={empty?.toLowerCase()}
            onInput={(ev) => setDraft((ev.target as HTMLInputElement).value)}
            onBlur={commit} onKeyDown={(ev) => ev.key === "Enter" && commit()} />
          {e.unit && <span class="unit">{e.unit}</span>}
        </span>
      )}
      {e.presets && e.presets.length > 0 && control.value && (
        <div class="presets">
          {e.presets.map((p) => (
            <button type="button" class={`preset ${p.value === value ? "active" : ""}`} title={p.description} disabled={!control.value}
              onClick={() => onSet(p.value as number)}>{title(p.name)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextInput({ value, onSet, label: lbl }: { value: any; onSet: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onSet(draft);
    setDraft(null);
  };
  return (
    <input type="text" value={draft ?? value ?? ""} disabled={!control.value} aria-label={lbl}
      onInput={(ev) => setDraft((ev.target as HTMLInputElement).value)} onBlur={commit} onKeyDown={(ev) => ev.key === "Enter" && commit()} />
  );
}

// ------------------------------------------------------------------ specific exposes

function SwitchControl({ k, dev, e, st }: { k: string; dev?: Dev; e: Expose; st: Signal<State> }) {
  const sf = feature(e, "state");
  const p = prop(sf);
  if (!sf || !p) return null;
  const v = st.value[p];
  const on = v === undefined ? undefined : v === (sf.value_on ?? "ON");
  return (
    <div class="ctl switch-ctl">
      <div class="ctl-title">
        <Icon name="power" size={18} />
        <span>{e.endpoint ? `Switch ${e.endpoint}` : "Power"}</span>
        <span class={`state-word ${on ? "on" : ""}`}>{on === undefined ? "—" : on ? "On" : "Off"}</span>
      </div>
      {control.value && (
        <Toggle on={on} label={`Power of ${dev?.name}${e.endpoint ? " " + e.endpoint : ""}`}
          onChange={(nv) => send(k, dev, { [p]: nv ? sf.value_on ?? "ON" : sf.value_off ?? "OFF" }, e)} />
      )}
    </div>
  );
}

function rgbToHs(css: string): { hue: number; saturation: number } | undefined {
  const m = css.match(/\d+/g);
  if (!m) return undefined;
  const [r, g, b] = m.map((x) => Number(x) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { hue: Math.round((h * 60 + 360) % 360), saturation: Math.round(max ? (d / max) * 100 : 0) };
}

export function lightColor(e: Expose, st: State): string | undefined {
  const on = st[prop(feature(e, "state")) || "state"] === "ON";
  if (!on) return undefined;
  const bri = st[prop(feature(e, "brightness")) || "brightness"] ?? 254;
  const { cp, cm } = colourKeys(e);
  const mode = st[cm];
  const c = st[cp];
  if (c && mode !== "color_temp") {
    if (typeof c.x === "number" && typeof c.y === "number") return xyToCss(c.x, c.y, bri);
    if (typeof c.hue === "number") return `hsl(${c.hue} ${c.saturation ?? 100}% ${30 + (bri / 254) * 30}%)`;
  }
  const ct = st[prop(feature(e, "color_temp")) || "color_temp"];
  if (typeof ct === "number") return miredToCss(ct);
  return "rgb(255, 196, 120)";
}

function LightControl({ k, dev, e, st, compact }: { k: string; dev?: Dev; e: Expose; st: Signal<State>; compact?: boolean }) {
  const s = st.value;
  const sf = feature(e, "state");
  const bf = feature(e, "brightness");
  const ctf = feature(e, "color_temp");
  const colf = feature(e, "color_hs") || feature(e, "color_xy");
  const others = (e.features || []).filter((f) => !["state", "brightness", "color_temp", "color_hs", "color_xy"].includes(f.name || ""));
  const [more, setMore] = useState(false);
  const p = prop(sf) || "state";
  const v = s[p];
  const on = v === undefined ? undefined : v === (sf?.value_on ?? "ON");
  const color = lightColor(e, s);
  const { cp } = colourKeys(e);
  const sc = s[cp];
  const hs = sc && typeof sc.hue === "number" ? { hue: sc.hue, saturation: sc.saturation ?? 100 }
    : sc && typeof sc.x === "number" ? rgbToHs(xyToCss(sc.x, sc.y)) : undefined;
  const bri = bf ? s[prop(bf)!] : undefined;
  return (
    <div class={`ctl light-ctl ${on ? "is-on" : ""}`} style={color ? ({ "--glow": color } as any) : undefined}>
      <div class="ctl-title">
        <span class="swatch" style={{ background: color || "var(--off)" }} />
        <span>{e.label ?? (e.endpoint ? `Light ${e.endpoint}` : "Light")}</span>
        <span class={`state-word ${on ? "on" : ""}`}>
          {on === undefined ? "—" : on ? (bri !== undefined ? `${Math.round((bri / (bf?.value_max ?? 254)) * 100)}%` : "On") : "Off"}
        </span>
        {control.value && <Toggle on={on} label={`Power of ${dev?.name}`} onChange={(nv) => send(k, dev, { [p]: nv ? sf?.value_on ?? "ON" : sf?.value_off ?? "OFF" }, e)} />}
      </div>
      {bf && (
        <Slider label="Brightness" value={bri} min={bf.value_min ?? 0} max={bf.value_max ?? 254}
          format={(x) => `${Math.round((x / (bf.value_max ?? 254)) * 100)}%`}
          onSend={(x) => send(k, dev, { [prop(bf)!]: x }, e)} />
      )}
      {!compact && ctf && (
        <>
          <Slider label="White" value={s[prop(ctf)!]} min={ctf.value_min ?? 153} max={ctf.value_max ?? 500} format={(x) => kelvin(x)}
            track={`linear-gradient(90deg, ${miredToCss(ctf.value_min ?? 153)}, ${miredToCss(ctf.value_max ?? 500)})`}
            onSend={(x) => send(k, dev, { [prop(ctf)!]: x }, e)} />
          {ctf.presets && control.value && (
            <div class="presets">
              {ctf.presets.filter((pr) => typeof pr.value === "number").map((pr) => (
                <button type="button" class="preset" disabled={!control.value} onClick={() => send(k, dev, { [prop(ctf)!]: pr.value }, e)}>
                  <span class="mini-swatch" style={{ background: miredToCss(pr.value as number) }} />
                  {title(pr.name)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {!compact && colf && (
        <>
          <Slider label="Hue" value={hs?.hue} min={0} max={359} format={(x) => `${x}°`}
            track="linear-gradient(90deg, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(359 100% 50%))"
            onSend={(x) => send(k, dev, { [cp]: { hue: x, saturation: hs?.saturation ?? 100 } }, e)} />
          <Slider label="Saturation" value={hs?.saturation} min={0} max={100} format={(x) => `${x}%`}
            track={`linear-gradient(90deg, #fff, hsl(${hs?.hue ?? 0} 100% 50%))`}
            onSend={(x) => send(k, dev, { [cp]: { hue: hs?.hue ?? 0, saturation: x } }, e)} />
        </>
      )}
      {!compact && others.length > 0 && (
        <div class="more">
          <button type="button" class="link-btn" onClick={() => setMore(!more)} aria-expanded={more}>
            {more ? "Fewer" : "More"} light settings
          </button>
          {more && others.map((f) => <ExposeControl k={k} dev={dev} e={f} st={st} />)}
        </div>
      )}
    </div>
  );
}

function SpecificControl({ k, dev, e, st }: { k: string; dev?: Dev; e: Expose; st: Signal<State> }) {
  return (
    <div class="ctl">
      <div class="ctl-title">
        <Icon name={e.type === "lock" ? "lock" : e.type === "cover" ? "cover" : e.type === "fan" ? "fan" : "thermo"} size={18} />
        <span>{title(e.type)}{e.endpoint ? ` ${e.endpoint}` : ""}</span>
      </div>
      {(e.features || []).map((f) => (
        <Field k={k} dev={dev} e={f} value={st.value[prop(f)!]} onSet={(v) => send(k, dev, { [prop(f)!]: v }, e)} />
      ))}
    </div>
  );
}

/** A composite (level_config, a schedule...) is one value to Zigbee2MQTT: its parts are changed
 *  here first, then sent together, with the parts left alone as they are now. */
function CompositeControl({ k, dev, e, st }: { k: string; dev?: Dev; e: Expose; st: Signal<State> }) {
  const p = prop(e)!;
  const cur = (st.value[p] as Record<string, any>) || {};
  const [draft, setDraft] = useState<Record<string, any>>({});
  const changed = Object.keys(draft).length;
  const apply = async () => {
    const payload = { [p]: { ...cur, ...draft } };
    setDraft({});
    await send(k, dev, payload, e);
  };
  return (
    <div class={`composite ${changed ? "changed" : ""}`}>
      <div class="field-label">{label(e)}</div>
      {(e.features || []).map((f) => {
        const fp = prop(f)!;
        return <Field k={k} dev={dev} e={f} parent={p} value={fp in draft ? draft[fp] : cur[fp]} onSet={(v) => setDraft((d) => ({ ...d, [fp]: v }))} />;
      })}
      {changed > 0 && control.value && (
        <div class="composite-actions">
          <button type="button" class="btn small primary" onClick={apply}>Apply</button>
          <button type="button" class="link-btn small" onClick={() => setDraft({})}>Undo</button>
          <span class="muted small">{changed} change{changed === 1 ? "" : "s"}, sent together as {label(e)}</span>
        </div>
      )}
    </div>
  );
}
