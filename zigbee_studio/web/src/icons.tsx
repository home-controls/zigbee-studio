// The kit's icon set and logo, plus Studio's device kind -> icon.

import type { Kind } from "./exposes";
import type { IconName } from "./kit/icons";

export { Icon, Logo, type IconName } from "./kit/icons";

export const KIND_ICON: Record<Kind, IconName> = {
  coordinator: "coordinator",
  light: "bulb",
  switch: "toggle",
  outlet: "outlet",
  cover: "cover",
  lock: "lock",
  climate: "thermo",
  fan: "fan",
  keypad: "keypad",
  contact: "door",
  motion: "motion",
  climate_sensor: "thermo",
  air: "air",
  router: "router",
  sensor: "sensor",
};
