// Formatting helpers: the kit's shared wording, plus Studio's own.

export { ago, isoToTs, clock, dayClock, duration, hex, title, matches } from "./kit/format";

export function num(v: any, unit?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    const s = Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
    return unit ? `${s} ${unit}` : s;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return unit ? `${v} ${unit}` : String(v);
}

export function kelvin(mired: number | undefined): string {
  return mired ? `${Math.round(1e6 / mired / 50) * 50} K` : "—";
}

/** CIE xy (+ brightness) to an sRGB CSS colour, for swatches. */
export function xyToCss(x: number, y: number, bri = 254): string {
  const z = 1 - x - y;
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  [r, g, b] = [r, g, b].map(gamma);
  const max = Math.max(r, g, b, 1e-6);
  const scale = (Math.max(bri, 40) / 254) / max;
  const to = (c: number) => Math.round(Math.max(0, Math.min(1, c * scale)) * 255);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

/** Mireds to an approximate CSS colour (warm amber to cool white). */
export function miredToCss(mired: number): string {
  const k = 1e6 / mired / 100;
  let r: number, g: number, b: number;
  if (k <= 66) {
    r = 255;
    g = 99.47 * Math.log(k) - 161.12;
    b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(k - 60, -0.1332);
    g = 288.12 * Math.pow(k - 60, -0.0755);
    b = 255;
  }
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/** Match words in any order, case-insensitive. */
