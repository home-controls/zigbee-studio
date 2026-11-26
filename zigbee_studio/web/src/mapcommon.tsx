// Shared by the mesh map and the floor maps: link costs in words and colours, signal words, the
// coverage colour scale, and the little tooltip both maps use.

import type { ComponentChildren } from "preact";

/** A link's cost: the worse of its two directions (0 / null = not known yet). */
export function worstCost(ab: number | null | undefined, ba: number | null | undefined): number | null {
  const known = [ab, ba].filter((c): c is number => !!c);
  return known.length ? Math.max(...known) : null;
}

export type CostClass = "good" | "fair" | "poor" | "bad" | "unknown";

export function costClass(c: number | null | undefined): CostClass {
  if (!c) return "unknown";
  return c <= 2 ? "good" : c <= 4 ? "fair" : c <= 6 ? "poor" : "bad";
}

export const COST_WORD: Record<CostClass, string> = { good: "good", fair: "fair", poor: "poor", bad: "bad", unknown: "not known yet" };

export function CostChip({ c }: { c: number | null | undefined }) {
  const k = costClass(c);
  return <span class={`cost cost-${k}`} title={c ? `Link cost ${c} of 7: ${COST_WORD[k]}` : "Not known yet"}>{c || "–"}</span>;
}

export function CostLegend() {
  return (
    <span class="chart-legend map-legend">
      <span>Link cost</span>
      <span><i class="key line cost-line-good" />1–2 good</span>
      <span><i class="key line cost-line-fair" />3–4 fair</span>
      <span><i class="key line cost-line-poor" />5–6 poor</span>
      <span><i class="key line cost-line-bad" />7 bad</span>
    </span>
  );
}

export function signalWord(v: number | null | undefined): string {
  if (v == null) return "";
  return v >= -70 ? "strong" : v >= -80 ? "good" : v >= -88 ? "fair" : "weak";
}

// Coverage: one hue from light (weak) to dark (strong); dark mode has its own steps (more = lighter).
export const HEAT_AT = [-98, -88, -80, -70, -55];

export function heatColours(el: Element): [number, number, number][] {
  const cs = getComputedStyle(el);
  return HEAT_AT.map((_, i) => {
    const hex = cs.getPropertyValue(`--heat-${i}`).trim() || "#888888";
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as [number, number, number];
  });
}

export function heatRGB(v: number, cols: [number, number, number][]): [number, number, number] {
  if (v <= HEAT_AT[0]) return cols[0];
  for (let i = 1; i < HEAT_AT.length; i++) {
    if (v <= HEAT_AT[i]) {
      const t = (v - HEAT_AT[i - 1]) / (HEAT_AT[i] - HEAT_AT[i - 1]);
      const a = cols[i - 1], b = cols[i];
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as [number, number, number];
    }
  }
  return cols[cols.length - 1];
}

export function HeatLegend() {
  return (
    <div class="heat-legend">
      <span>weak</span>
      <i class="heat-bar" />
      <span>strong</span>
      <span class="muted">−98 · −88 · −80 · −70 · −55 dBm</span>
    </div>
  );
}

/** A tooltip at (x, y) inside a positioned box `w` wide: flips to the left past the middle. */
export function MapTip({ x, y, w, children }: { x: number; y: number; w: number; children: ComponentChildren }) {
  const flip = x > w / 2;
  return (
    <div class="chart-tip map-tip" style={{ top: `${y + 12}px`, ...(flip ? { right: `${w - x + 12}px` } : { left: `${x + 12}px` }) }}>
      {children}
    </div>
  );
}

const TYPE_WORD: Record<string, string> = { Coordinator: "Coordinator", Router: "Router", EndDevice: "End device", Sniffer: "Sniffer" };
export const typeWord = (t: string | undefined) => (t ? TYPE_WORD[t] || t : "");

export interface LabelIn { key: string; x: number; y: number; r: number; text: string; rank: number; force?: boolean }

/** Which side each name goes ("r" right, "l" left), lowest rank first; a name that would cover
 * another name or a dot is left out (it shows on hover) unless forced. */
export function placeLabels(items: LabelIn[], W: number): Map<string, "r" | "l"> {
  const dots = items.map((n) => [n.x - n.r, n.y - n.r, n.x + n.r, n.y + n.r]);
  const boxes: number[][] = [];
  const meets = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const hits = (b: number[], own: number) => b[0] < 0 || b[2] > W || dots.some((d, i) => i !== own && meets(d, b)) || boxes.some((d) => meets(d, b));
  const out = new Map<string, "r" | "l">();
  const order = items.map((n, i) => ({ n, i })).sort((a, b) => a.n.rank - b.n.rank);
  for (const { n, i } of order) {
    const w = n.text.length * 6.1 + 2;
    const right = [n.x + n.r + 3, n.y - 7, n.x + n.r + 3 + w, n.y + 6], left = [n.x - n.r - 3 - w, n.y - 7, n.x - n.r - 3, n.y + 6];
    if (!hits(right, i)) { boxes.push(right); out.set(n.key, "r"); }
    else if (!hits(left, i)) { boxes.push(left); out.set(n.key, "l"); }
    else if (n.force) { boxes.push(right); out.set(n.key, "r"); }
  }
  return out;
}

/** Stable jitter in [-0.5, 0.5) from a string (layouts come out the same each time). */
export function jitter(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000 - 0.5;
}

export function loadOpts<T extends object>(key: string, dflt: T): T {
  try {
    return { ...dflt, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return dflt;
  }
}

export function saveOpts(key: string, v: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* fine */
  }
}
