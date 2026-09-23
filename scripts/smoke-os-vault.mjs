import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  LinuxSecretServiceBackend,
  MacOsKeychainBackend,
  OsCredentialSecretProvider,
  SecretAuthority,
} from "../packages/secrets/dist/index.js";

const exec = promisify(execFile);
const locator = `ci/${process.platform}/${process.arch}/${randomBytes(12).toString("hex")}`;
const secret = `vault-smoke-${randomBytes(24).toString("base64url")}`;

async function roundTrip(provider) {
  const authority = new SecretAuthority([provider]);
  const reference = `vault:${locator}`;
  await authority.storeUtf8(reference, secret);
  const actual = await authority.withUtf8(reference, (value) => value);
  assert.equal(actual, secret);
  assert.equal(await authority.delete(reference), true);
  await assert.rejects(authority.withUtf8(reference, () => undefined), /vault:\[redacted\]/);
}

if (process.platform === "darwin") {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-vault-smoke-"));
  const keychain = join(root, "blogmaatic-ci.keychain-db");
  const password = randomBytes(24).toString("base64url");
  try {
    await exec("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    await exec("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    await exec("/usr/bin/security", ["set-keychain-settings", "-lut", "3600", keychain]);
    await roundTrip(new OsCredentialSecretProvider(new MacOsKeychainBackend({ keychain })));
  } finally {
    await exec("/usr/bin/security", ["delete-keychain", keychain]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
} else if (process.platform === "linux") {
  await roundTrip(new OsCredentialSecretProvider(new LinuxSecretServiceBackend()));
} else {
  throw new Error(`Credential vault smoke is unsupported on ${process.platform}`);
}

console.log(`OS credential vault smoke passed on ${process.platform}/${process.arch}`);
