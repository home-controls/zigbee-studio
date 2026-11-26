// The kit's building blocks, plus Studio's Sniffer health dot. Toggles and sliders follow the kit's
// readOnly, which App keeps in step with "Allow control".

import type { Sniffer } from "./types";

export * from "./kit/ui";

export const HEALTH_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  ok: "ok",
  note: "info",
  warning: "warn",
  problem: "bad",
  "not heard": "muted",
};

export function HealthDot({ s }: { s: Sniffer | undefined }) {
  if (!s) return null;
  return <span class={`dot ${HEALTH_TONE[s.s] || "muted"}`} title={`Zigbee Sniffer: ${s.s}${s.findings.length ? " — " + s.findings.join("; ") : ""}`} />;
}

