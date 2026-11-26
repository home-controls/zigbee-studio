// A device's Settings tab: the settings the device itself exposes, and Zigbee2MQTT's options for
// it (the model's own, e.g. transition or color_sync, and the generic ones from Zigbee2MQTT's
// schema: debounce, retain, filtered attributes, ...). Options go through device/options.

import { useEffect, useState } from "preact/hooks";
import { call, req } from "../conn";
import { control } from "../store";
import { Field } from "../controls";
import { label as exLabel } from "../exposes";
import { title } from "../format";
import { Card, Chip, Empty } from "../ui";
import type { Dev, Expose } from "../types";

let schemaCache: any = null;
export async function z2mSchema(): Promise<any> {
  if (!schemaCache) schemaCache = await call("schema");
  return schemaCache;
}

const SKIP_GENERIC = new Set(["friendly_name", "icon", "disabled"]);

export function OptionsCard({ dev, detail }: { dev: Dev; detail: any }) {
  const [schema, setSchema] = useState<any>(null);
  useEffect(() => { z2mSchema().then(setSchema, () => setSchema({})); }, []);
  if (!detail) return <Card title="Zigbee2MQTT options"><Empty>Loading…</Empty></Card>;
  const own: Record<string, any> = detail.config || {};
  const global: Record<string, any> = detail.global || {};
  const setOpt = (name: string, v: any) =>
    req("device/options", { id: dev.ieee, options: { [name]: v } }, v === null ? `${title(name)} back to default` : `${title(name)} saved`).catch(() => undefined);
  const model: Expose[] = detail.options || [];
  const generic = Object.entries(schema?.definitions?.device?.properties || {}).filter(([k]) => !SKIP_GENERIC.has(k)) as [string, any][];
  return (
    <Card title="Zigbee2MQTT options" actions={!control.value ? <Chip tone="muted" icon="lock">read-only</Chip> : undefined}>
      <p class="muted small">How Zigbee2MQTT handles this device. A value set here overrides the one for all devices
        {Object.keys(global).length ? <> ({Object.entries(global).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})</> : null}.</p>
      {model.length > 0 && (
        <>
          <h4>For this model</h4>
          <div class="fields">
            {model.map((e) => {
              const name = e.property || e.name || "";
              const set = name in own;
              return (
                <div class="opt">
                  <Field k={dev.ieee} dev={dev} e={{ ...e, access: 3 }} value={set ? own[name] : global[name]} empty="Default"
                    onSet={(v) => setOpt(name, v)} />
                  {set && control.value && <button type="button" class="link-btn small" onClick={() => setOpt(name, null)}>Reset {exLabel(e).toLowerCase()}</button>}
                </div>
              );
            })}
          </div>
        </>
      )}
      <h4>General</h4>
      {!schema ? <Empty>Loading…</Empty> : (
        <div class="fields">
          {generic.map(([name, p]) => <SchemaField name={name} prop={p} value={own[name]} fallback={global[name]} onSet={(v) => setOpt(name, v)} />)}
        </div>
      )}
    </Card>
  );
}

/** One option from Zigbee2MQTT's JSON schema: boolean, number, string, enum, list of strings, or an
 * object of those (Home Assistant's name). */
export function SchemaField({ name, prop, value, fallback, onSet }: { name: string; prop: any; value: any; fallback?: any; onSet: (v: any) => void }) {
  const types: string[] = Array.isArray(prop.type) ? prop.type : [prop.type];
  const set = value !== undefined;
  const shown = set ? value : fallback ?? prop.default;
  const ro = !control.value || prop.readOnly;
  const label = prop.title || title(name);
  let input;
  if (prop.enum) {
    input = (
      <select value={set ? String(value) : ""} disabled={ro} onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        onSet(raw === "" ? null : prop.enum.find((x: any) => String(x) === raw));
      }}>
        <option value="">Default{(fallback ?? prop.default) !== undefined ? ` (${fallback ?? prop.default})` : ""}</option>
        {prop.enum.map((x: any) => <option value={String(x)}>{String(x)}</option>)}
      </select>
    );
  } else if (types.includes("boolean")) {
    input = (
      <select value={set ? String(value) : ""} disabled={ro} onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        onSet(raw === "" ? null : raw === "true");
      }}>
        <option value="">Default{(fallback ?? prop.default) !== undefined ? ` (${(fallback ?? prop.default) ? "on" : "off"})` : ""}</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  } else if (types.includes("number") || types.includes("integer")) {
    const dflt = fallback ?? prop.default;
    input = <Commit value={set ? value : ""} placeholder={dflt !== undefined && dflt !== null ? `default ${dflt}` : "default"} type="number" disabled={ro}
      onCommit={(raw) => onSet(raw === "" ? null : Number(raw))} />;
  } else if (types.includes("array")) {
    input = <Commit value={set && Array.isArray(value) ? value.join(", ") : ""} disabled={ro} placeholder="comma-separated"
      onCommit={(raw) => onSet(raw.trim() === "" ? null : raw.split(",").map((x) => x.trim()).filter(Boolean))} />;
  } else if (types.includes("object") && prop.properties) {
    return (
      <>
        {Object.entries(prop.properties).map(([k, sub]: [string, any]) => (
          <SchemaField name={`${name}.${k}`} prop={{ ...sub, title: `${prop.title || title(name)}: ${sub.title || title(k)}` }}
            value={value?.[k]} fallback={fallback?.[k]} onSet={(v) => onSet(v === null ? null : { ...(value || {}), [k]: v })} />
        ))}
      </>
    );
  } else {
    input = <Commit value={set ? value : ""} placeholder={shown !== undefined && shown !== null && shown !== "" ? String(shown) : "default"} disabled={ro}
      onCommit={(raw) => onSet(raw === "" ? null : raw)} />;
  }
  return (
    <div class="field" title={prop.description}>
      <div class="field-label">
        {label}
        {set && <span class="ep">set</span>}
        {prop.requiresRestart && <span class="ep" title="Takes effect when Zigbee2MQTT restarts">restart</span>}
      </div>
      <div class="field-value">{ro ? <span>{shown === undefined || shown === null ? "Default" : Array.isArray(shown) ? shown.join(", ") || "—" : String(shown)}</span> : input}</div>
    </div>
  );
}

function Commit({ value, onCommit, type = "text", disabled, placeholder }: { value: any; onCommit: (raw: string) => void; type?: string; disabled?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== String(value ?? "")) onCommit(draft);
    setDraft(null);
  };
  return (
    <input type={type} value={draft ?? value ?? ""} disabled={disabled} placeholder={placeholder}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)} onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}
