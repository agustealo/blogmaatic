import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionAuthority } from "@blogmaatic/extension-sdk";
import { inspectConfiguredConnections } from "../dist/runtime.js";

function connection(id, status = "active") {
  return {
    id,
    extensionId: `test.${id}`,
    displayName: id,
    status,
    settings: {},
    secretRefs: {},
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

test("connection health problems are diagnostic and do not block runtime startup", async () => {
  const connections = new ConnectionAuthority([
    connection("invalid"),
    connection("unhealthy"),
    connection("degraded"),
    connection("missing-extension"),
    connection("disabled", "disabled"),
  ]);
  const errors = [];
  const infos = [];
  const extensions = {
    async validateConnection(id) {
      if (id === "missing-extension") throw new Error("publisher is not registered");
      if (id === "invalid") return { valid: false, errors: ["bad settings"] };
      return { valid: true, errors: [] };
    },
    async checkHealth(id) {
      if (id === "unhealthy") return { state: "unhealthy", checkedAt: "now", detail: "credential rejected" };
      if (id === "degraded") return { state: "degraded", checkedAt: "now", detail: "remote slow" };
      throw new Error(`unexpected health check: ${id}`);
    },
  };

  await inspectConfiguredConnections(extensions, connections, {
    error(message) { errors.push(String(message)); },
    info(message) { infos.push(String(message)); },
  });

  assert.ok(errors.some((message) => message.includes("invalid") && message.includes("bad settings")));
  assert.ok(errors.some((message) => message.includes("unhealthy") && message.includes("credential rejected")));
  assert.ok(errors.some((message) => message.includes("missing-extension") && message.includes("not registered")));
  assert.ok(infos.some((message) => message.includes("degraded") && message.includes("remote slow")));
  assert.equal(errors.some((message) => message.includes("disabled")), false);
});
