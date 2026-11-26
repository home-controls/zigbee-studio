import { test } from "node:test";
import assert from "node:assert/strict";
import { getPath, setPath, withRemovals } from "../src/settingsdiff.ts";

test("a key removed from an object goes as null (Zigbee2MQTT would keep it otherwise)", () => {
  const before = { log_namespaced_levels: { "z2m:mqtt": "warning", "zh:ember": "info" }, log_level: "info" };
  const after = { log_namespaced_levels: { "z2m:mqtt": "warning" }, log_level: "info" };
  assert.deepEqual(withRemovals(before, after), { log_namespaced_levels: { "z2m:mqtt": "warning", "zh:ember": null }, log_level: "info" });
});

test("lists and plain values go as they are", () => {
  assert.deepEqual(withRemovals(["a", "b"], ["a"]), ["a"]);
  assert.equal(withRemovals({ a: 1 }, 5), 5);
  assert.equal(withRemovals(undefined, "x"), "x");
});

test("setPath builds the nested change; getPath reads it", () => {
  const o: any = {};
  setPath(o, ["advanced", "log_level"], "debug");
  setPath(o, ["advanced", "last_seen"], "ISO_8601");
  assert.deepEqual(o, { advanced: { log_level: "debug", last_seen: "ISO_8601" } });
  assert.equal(getPath(o, ["advanced", "log_level"]), "debug");
  assert.equal(getPath(o, ["mqtt", "server"]), undefined);
});
