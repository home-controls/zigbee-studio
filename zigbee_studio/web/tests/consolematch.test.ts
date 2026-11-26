import { test } from "node:test";
import assert from "node:assert/strict";
import { type Entry, SAME_S, WAIT_S, resolve } from "../src/consolematch.ts";
import type { LogEntry } from "../src/types.ts";

const AT = 1000;
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 1, at: AT, mode: "read", cluster: "genBasic", what: "modelId, swBuildId", ep: "11", status: "waiting",
  attrs: ["modelId", "swBuildId"], ...over,
});
const line = (msg: string, ts = AT + 0.5, level = "info", ns = "zhc:tz"): LogEntry => ({ ts, level, ns, msg });
const READ = `Read result of 'genBasic': {"modelId":"LTA010","swBuildId":"1.163.5"}`;

test("a read is answered by the first matching line after it was sent", () => {
  const [e] = resolve([entry()], [line("Something else"), line(READ)], "Desk Lamp", AT + 1);
  assert.equal(e.status, "ok");
  assert.equal(e.result, READ);
  assert.equal(e.same, undefined);
});

test("a line from before the request doesn't answer it", () => {
  const [e] = resolve([entry()], [line(READ, AT - 5)], "Desk Lamp", AT + 1);
  assert.equal(e.status, "waiting");
});

test("a failure names the device; another device's failure doesn't count", () => {
  const fail = line("Publish 'set' 'read' to 'Desk Lamp' failed: 'Error: Timeout'", AT + 10, "error", "z2m");
  const other = line("Publish 'set' 'read' to 'Fan 1' failed: 'Error: Timeout'", AT + 9, "error", "z2m");
  const [e] = resolve([entry()], [other, fail], "Desk Lamp", AT + 11);
  assert.equal(e.status, "error");
  assert.equal(e.result, fail.msg);
});

test("a repeated answer Zigbee2MQTT didn't send again is taken from the last line before", () => {
  const prev = { level: "info", msg: READ };
  const waiting = resolve([entry({ prev })], [], "Desk Lamp", AT + SAME_S - 1);
  assert.equal(waiting[0].status, "waiting");
  const [e] = resolve([entry({ prev })], [], "Desk Lamp", AT + SAME_S + 1);
  assert.equal(e.status, "ok");
  assert.equal(e.same, true);
  assert.equal(e.result, READ);
});

test("the line before only stands in with exactly the attributes asked for", () => {
  const prev = { level: "info", msg: `Read result of 'genBasic': {"modelId":"LTA010"}` };
  const [e] = resolve([entry({ prev })], [], "Desk Lamp", AT + SAME_S + 1);
  assert.equal(e.status, "waiting");
  const [late] = resolve([entry({ prev })], [], "Desk Lamp", AT + WAIT_S + 1);
  assert.equal(late.status, "silent");
});

test("write and command lines match their own shapes", () => {
  const w = entry({ mode: "write", cluster: "genLevelCtrl", what: "onOffTransitionTime = 5", attrs: undefined });
  const [ew] = resolve([w], [line(`Wrote '{"onOffTransitionTime":5}' to 'genLevelCtrl'`)], "Desk Lamp", AT + 1);
  assert.equal(ew.status, "ok");
  const c = entry({ mode: "command", cluster: "genIdentify", what: "identify", attrs: undefined });
  const [ec] = resolve([c], [line(`Invoked 'genIdentify.identify' with payload '{"identifytime":5}'`)], "Desk Lamp", AT + 1);
  assert.equal(ec.status, "ok");
  const [miss] = resolve([c], [line(`Invoked 'genIdentify.triggerEffect' with payload '{}'`)], "Desk Lamp", AT + 1);
  assert.equal(miss.status, "waiting");
});

test("nothing to change keeps the same list (no re-render)", () => {
  const list = [entry({ status: "ok", result: READ })];
  assert.equal(resolve(list, [line(READ)], "Desk Lamp", AT + 100), list);
});
