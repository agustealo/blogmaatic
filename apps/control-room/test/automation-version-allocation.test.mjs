import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/pages/automations.tsx", import.meta.url), "utf8");

test("Automation edit allocates the next version above newest registered history", () => {
  assert.match(source, /listAutomationVersions\(entry\.definition\.id, \{ limit: 1 \}\)/);
  assert.match(source, /const latestVersion = versions\.items\[0\]\?\.definition\.version \?\? entry\.definition\.version/);
  assert.match(source, /version: Math\.max\(entry\.definition\.version, latestVersion\)/);
  assert.match(source, /const nextVersion = initial \? initial\.version \+ 1 : 1/);
});
