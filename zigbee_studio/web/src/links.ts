// Links into another add-on's own page at one device (Zigbee2MQTT's Windfront, the Zigbee Sniffer).
// Home Assistant can't open an add-on's panel at a page inside it (a path after the panel is a
// 404), so these open the add-on's page by its ingress address, in a new tab, at the device.
// The address comes from Home Assistant's own connection in the parent page (same origin, the
// signed-in admin), like the theme does; without it, the link is the add-on's panel as before.

import { useEffect, useState } from "preact/hooks";

import { panelHref, slugOf } from "./kit/family";

export { panelHref, slugOf };

const cache = new Map<string, Promise<string | null>>();

function ingressOf(slug: string): Promise<string | null> {
  let p = cache.get(slug);
  if (!p) {
    p = (async () => {
      try {
        const hass = (window.parent !== window ? (window.parent.document.querySelector("home-assistant") as any)?.hass : null);
        if (!hass?.callWS) return null;
        const info = await hass.callWS({ type: "supervisor/api", endpoint: `/addons/${slug}/info`, method: "get" });
        return typeof info?.ingress_url === "string" ? info.ingress_url : null;
      } catch {
        return null; // not an admin, or not inside Home Assistant
      }
    })();
    cache.set(slug, p);
  }
  return p;
}

/** { href, newTab }: the add-on's page at `hash` when its address is known, else its panel. */
export function useDeepLink(panel: string | null | undefined, hash: string): { href: string | null; newTab: boolean } {
  const [ingress, setIngress] = useState<string | null>(null);
  const slug = panel ? slugOf(panel) : "";
  useEffect(() => {
    let live = true;
    if (slug) ingressOf(slug).then((u) => live && setIngress(u));
    return () => { live = false; };
  }, [slug]);
  if (!panel) return { href: null, newTab: false };
  return ingress ? { href: `${ingress.replace(/\/?$/, "/")}${hash}`, newTab: true } : { href: panel, newTab: false };
}
