import assert from "node:assert/strict";
import test from "node:test";

import { defaultRuntimeConfig, parseRuntimeConfig, runtimePaths } from "../dist/config.js";

test("default runtime is loopback-only and owns distinct local ports", () => {
  const config = parseRuntimeConfig(defaultRuntimeConfig());
  assert.equal(config.operator.host, "127.0.0.1");
  assert.equal(config.operator.port, 4317);
  assert.equal(config.controlRoom.port, 4320);
  assert.equal(config.restate.workflowPort, 9080);
  assert.equal(new Set([config.operator.port, config.controlRoom.port, config.restate.workflowPort]).size, 3);
});

test("runtime config rejects non-loopback local surfaces", () => {
  const config = structuredClone(defaultRuntimeConfig());
  config.operator.host = "0.0.0.0";
  assert.throws(() => parseRuntimeConfig(config), /loopback/);
});

test("runtime paths keep state authorities separate", () => {
  const paths = runtimePaths("/tmp/blogmaatic-runtime-proof");
  assert.notEqual(paths.controlPlanePath, paths.projectionStatePath);
  assert.match(paths.operatorTokenPath, /secrets/);
  assert.match(paths.restateDataDir, /restate$/);
});
