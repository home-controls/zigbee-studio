// Turning the Settings page's draft into an options change for Zigbee2MQTT, which merges it into
// its settings: objects deep, lists replaced, null back to the default.

export const getPath = (o: any, path: string[]) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);
export const isObj = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

export function setPath(o: any, path: string[], v: any) {
  let cur = o;
  for (const k of path.slice(0, -1)) cur = cur[k] = isObj(cur[k]) ? cur[k] : {};
  cur[path[path.length - 1]] = v;
}

/** Zigbee2MQTT merges objects: a key left out stays. Send null for the ones removed. */
export function withRemovals(before: any, after: any): any {
  if (!isObj(before) || !isObj(after)) return after;
  const out: any = {};
  for (const k of Object.keys(after)) out[k] = withRemovals(before[k], after[k]);
  for (const k of Object.keys(before)) if (!(k in after)) out[k] = null;
  return out;
}
