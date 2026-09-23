import assert from "node:assert/strict";
import test from "node:test";

import { auditedMutation } from "../dist/index.js";

const principal = {
  id: "operator-audit",
  kind: "operator",
  permissions: ["*"],
  roles: [],
};

function storeThatFailsOn(phase) {
  const calls = [];
  return {
    calls,
    async appendAudit(entry) {
      calls.push(entry.phase);
      if (entry.phase === phase) throw new Error(`ledger ${phase} unavailable`);
      return { id: `audit-${calls.length}`, ...entry };
    },
  };
}

test("success-ledger failure never creates a false failed business outcome", async () => {
  const store = storeThatFailsOn("succeeded");
  let executions = 0;
  await assert.rejects(
    auditedMutation({
      store,
      principal,
      requestId: "request-1",
      action: "test.success",
      resource: { type: "test", id: "one" },
      now: () => "2026-09-22T23:00:00.000Z",
      execute: async () => {
        executions += 1;
        return { ok: true };
      },
    }),
    /ledger succeeded unavailable/,
  );
  assert.equal(executions, 1);
  assert.deepEqual(store.calls, ["intent", "succeeded"]);
});

test("failure-ledger outage preserves the original business failure", async () => {
  const store = storeThatFailsOn("failed");
  const businessError = new Error("business rejected");
  await assert.rejects(
    auditedMutation({
      store,
      principal,
      requestId: "request-2",
      action: "test.failure",
      resource: { type: "test", id: "two" },
      now: () => "2026-09-22T23:00:00.000Z",
      execute: async () => {
        throw businessError;
      },
    }),
    (error) => error === businessError,
  );
  assert.deepEqual(store.calls, ["intent", "failed"]);
});
