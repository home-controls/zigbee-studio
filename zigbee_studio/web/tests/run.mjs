// npm test: the page's logic that broke against real Zigbee2MQTT before (log matching, exposes,
// settings changes), with Node's own test runner and type stripping; no extra packages.
// Usage: node --import ./tests/run.mjs --test --test-force-exit "tests/*.test.ts"
// (--test-force-exit: the store keeps a clock ticking, which would keep Node running.)
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
