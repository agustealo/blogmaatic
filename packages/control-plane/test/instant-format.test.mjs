import assert from "node:assert/strict";
import test from "node:test";

import { canonicalInstant } from "../dist/index.js";

test("canonical instants are fixed-width UTC strings with chronological lexical order", () => {
  const exact = canonicalInstant("2026-09-22T23:00:00Z");
  const tenth = canonicalInstant("2026-09-22T23:00:00.1Z");
  const hundredTwenty = canonicalInstant("2026-09-22T23:00:00.12Z");

  assert.equal(exact, "2026-09-22T23:00:00.000Z");
  assert.equal(tenth, "2026-09-22T23:00:00.100Z");
  assert.equal(hundredTwenty, "2026-09-22T23:00:00.120Z");
  assert.deepEqual([hundredTwenty, exact, tenth].sort(), [exact, tenth, hundredTwenty]);
});
