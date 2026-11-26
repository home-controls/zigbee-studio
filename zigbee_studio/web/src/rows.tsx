// A device as one row: icon, name, live summary, quick toggle. Each row reads only its own
// device's signals, so a state message re-renders one row.

import { setState } from "./conn";
import { exposesOf, stateOf, availOf, snifferOf, control } from "./store";
import { battery, feature, isOn, kindOf, primaries, prop, summary } from "./exposes";
import { lightColor, sensitive } from "./controls";
import { Icon, KIND_ICON } from "./icons";
import { href } from "./route";
import { HealthDot, Toggle } from "./ui";
import type { Dev } from "./types";

export function DeviceRow({ dev, sub }: { dev: Dev; sub?: string }) {
  const ex = exposesOf(dev);
  const kind = kindOf(dev, ex);
  const st = stateOf(dev.ieee).value;
  const av = availOf(dev.ieee).value;
  const sn = snifferOf(dev.ieee).value;
  const main = primaries(ex).find((e) => e.type === "light" || e.type === "switch");
  const sf = main && feature(main, "state");
  const quick = control.value && sf && ((sf.access ?? 0) & 2) && primaries(ex).length === 1 && !sensitive(dev, main);
  const on = isOn(st, sf);
  const color = main?.type === "light" ? lightColor(main, st) : undefined;
  const bat = battery(st);
  const offline = av === "offline";
  return (
    <div class={`row ${offline ? "offline" : ""} ${on ? "on" : ""}`}>
      <span class={`row-icon k-${kind}`} style={color ? ({ "--glow": color } as any) : undefined}>
        <Icon name={KIND_ICON[kind]} size={20} />
      </span>
      <div class="row-main">
        <a class="row-link" href={href("device", dev.ieee)}>{dev.name}</a>
        <div class="row-sub">
          {offline ? <span class="bad-text">Offline</span> : <span>{summary(kind, ex, st) || sub || dev.desc}</span>}
          {sub && !offline && <span class="muted"> · {sub}</span>}
        </div>
      </div>
      <div class="row-end">
        {bat !== undefined && (
          <span class={`bat ${bat < 20 ? "bad-text" : "muted"}`} title={`Battery ${bat}%`}>
            <Icon name="battery" size={15} /> {bat}%
          </span>
        )}
        {sn && (sn.s === "warning" || sn.s === "problem") && <HealthDot s={sn} />}
        {quick && sf && (
          <Toggle on={on} label={`Turn ${dev.name} ${on ? "off" : "on"}`} disabled={offline}
            onChange={(v) => setState(dev.ieee, { [prop(sf)!]: v ? sf.value_on ?? "ON" : sf.value_off ?? "OFF" })} />
        )}
      </div>
    </div>
  );
}
