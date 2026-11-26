import { test } from "node:test";
import assert from "node:assert/strict";
import { feature, groupLight, sections } from "../src/exposes.ts";
import type { Expose } from "../src/types.ts";

const hueLight = (min: number, max: number, colour = false): Expose[] => [{
  type: "light", features: [
    { type: "binary", name: "state", property: "state", access: 7, value_on: "ON", value_off: "OFF" },
    { type: "numeric", name: "brightness", property: "brightness", access: 7, value_min: 0, value_max: 254 },
    { type: "numeric", name: "color_temp", property: "color_temp", access: 7, value_min: min, value_max: max,
      presets: [{ name: "coolest", value: 153 }, { name: "neutral", value: 250 }, { name: "warmest", value: 500 }] },
    ...(colour ? [{ type: "composite", name: "color_xy", property: "color", access: 7, features: [] }] : []),
  ],
} as Expose];

test("a group gets white only within the range every member reaches", () => {
  const g = groupLight([hueLight(153, 454), hueLight(200, 500)])!;
  const ct = feature(g, "color_temp")!;
  assert.equal(ct.value_min, 200);
  assert.equal(ct.value_max, 454);
  assert.deepEqual(ct.presets!.map((p) => p.name), ["neutral"]);
  assert.equal(feature(g, "color_xy"), undefined, "colour only when every member takes it");
});

test("a group gets colour when every member takes colour", () => {
  const g = groupLight([hueLight(153, 500, true), hueLight(153, 500, true)])!;
  assert.equal(feature(g, "color_xy")?.property, "color");
  assert.equal(feature(g, "brightness")?.property, "brightness");
});

test("no light controls for a group with a member that isn't a light", () => {
  const plug: Expose[] = [{ type: "switch", features: [{ type: "binary", name: "state", property: "state", access: 7 }] } as Expose];
  assert.equal(groupLight([hueLight(153, 500), plug]), null);
  assert.equal(groupLight([]), null);
});

test("sections sort exposes by what they are", () => {
  const ex: Expose[] = [
    ...hueLight(153, 500),
    { type: "numeric", name: "linkquality", property: "linkquality", access: 1 },
    { type: "enum", name: "power_on_behavior", property: "power_on_behavior", access: 7, category: "config", values: ["off", "on"] },
    { type: "numeric", name: "voltage", property: "voltage", access: 1, category: "diagnostic" },
    { type: "enum", name: "action", property: "action", access: 1, values: ["single"] },
    { type: "enum", name: "effect", property: "effect", access: 2, values: ["blink"] },
  ] as Expose[];
  const s = sections(ex);
  assert.deepEqual(s.controls.map((e) => e.type === "light" ? "light" : e.name), ["light", "effect"]);
  assert.deepEqual(s.readings.map((e) => e.name), ["action"]);
  assert.deepEqual(s.diagnostic.map((e) => e.name), ["voltage"]);
  assert.deepEqual(s.config.flatMap((c) => c.items.map((e) => e.name)), ["power_on_behavior"]);
  const ro = sections(ex, true);
  assert.ok(!ro.controls.some((e) => e.name === "effect"), "read-only leaves out write-only actions");
});
