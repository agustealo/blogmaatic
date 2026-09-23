import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureOperatorToken, readOperatorToken } from "../dist/credentials.js";

test("operator credential is generated once and survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-credential-"));
  const path = join(root, "secrets", "operator.token");
  const first = await ensureOperatorToken(path);
  const second = await ensureOperatorToken(path);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.token, second.token);
  assert.equal(await readOperatorToken(path), first.token);
  assert.equal((await readFile(path, "utf8")).trim(), first.token);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});
