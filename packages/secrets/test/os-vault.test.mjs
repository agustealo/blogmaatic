import assert from "node:assert/strict";
import test from "node:test";

import {
  LinuxSecretServiceBackend,
  MacOsKeychainBackend,
  OsCredentialSecretProvider,
  SecretAuthority,
} from "../dist/index.js";

const decoder = new TextDecoder();

function queuedRunner(results, calls) {
  return async (executable, args, options = {}) => {
    calls.push({ executable, args: [...args], input: options.input ?? "" });
    const result = results.shift();
    if (!result) throw new Error("unexpected command invocation");
    return result;
  };
}

const ok = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr });

function stored(value) {
  return `blogmaatic:v1:${Buffer.from(value, "utf8").toString("base64")}`;
}

test("macOS writes vault secrets only through security interactive stdin", async () => {
  const calls = [];
  const run = queuedRunner([ok(), ok()], calls);
  const backend = new MacOsKeychainBackend({ run, keychain: "/tmp/blogmaatic-test.keychain-db" });
  const provider = new OsCredentialSecretProvider(backend);
  const authority = new SecretAuthority([provider]);
  const raw = "super-secret-value";

  await authority.storeUtf8("vault:wordpress/application-password", raw);

  assert.equal(calls[0].executable, "/usr/bin/security");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-q", "show-keychain-info"]);
  assert.equal(calls[1].executable, "/usr/bin/security");
  assert.deepEqual(calls[1].args, ["-q", "-i"]);
  assert.doesNotMatch(calls.flatMap((call) => call.args).join(" "), new RegExp(raw));
  assert.doesNotMatch(calls[1].input, new RegExp(raw));
  assert.match(calls[1].input, /add-generic-password/);
  assert.match(calls[1].input, /blogmaatic:v1:/);
});

test("macOS resolves and deletes encoded Keychain items without exposing the locator raw", async () => {
  const calls = [];
  const run = queuedRunner([
    ok(),
    ok(`${stored("read-secret")}\n`),
    ok(),
    ok(),
  ], calls);
  const backend = new MacOsKeychainBackend({ run });
  const provider = new OsCredentialSecretProvider(backend);
  const authority = new SecretAuthority([provider]);

  const value = await authority.withUtf8("vault:linkedin/access-token", (secret) => secret);
  assert.equal(value, "read-secret");
  assert.equal(await authority.delete("vault:linkedin/access-token"), true);
  const args = calls.flatMap((call) => call.args).join(" ");
  assert.doesNotMatch(args, /linkedin\/access-token/);
  assert.match(args, /blogmaatic:v1:/);
});

test("Linux writes secrets through secret-tool stdin and round-trips encoded material", async () => {
  const calls = [];
  const raw = "linux-secret";
  const run = queuedRunner([
    ok(),
    ok(`${stored(raw)}\n`),
    ok(),
  ], calls);
  const backend = new LinuxSecretServiceBackend({ run });
  const authority = new SecretAuthority([new OsCredentialSecretProvider(backend)]);

  await authority.storeUtf8("vault:facebook/page-token", raw);
  assert.equal(calls[0].executable, "/usr/bin/secret-tool");
  assert.equal(calls[0].args[0], "store");
  assert.doesNotMatch(calls[0].args.join(" "), new RegExp(raw));
  assert.doesNotMatch(calls[0].input, new RegExp(raw));
  assert.match(calls[0].input, /^blogmaatic:v1:/);

  const value = await authority.withUtf8("vault:facebook/page-token", (secret) => secret);
  assert.equal(value, raw);
  assert.equal(await authority.delete("vault:facebook/page-token"), true);
});

test("missing vault items resolve as unavailable without leaking locators", async () => {
  const calls = [];
  const run = queuedRunner([{ code: 1, stdout: "", stderr: "" }], calls);
  const authority = new SecretAuthority([
    new OsCredentialSecretProvider(new LinuxSecretServiceBackend({ run })),
  ]);
  await assert.rejects(
    authority.withUtf8("vault:private/path", () => undefined),
    (error) => {
      assert.match(error.message, /vault:\[redacted\]/);
      assert.doesNotMatch(error.message, /private\/path/);
      return true;
    },
  );
});

test("vault rejects empty and oversized material before invoking the OS helper", async () => {
  const calls = [];
  const backend = new LinuxSecretServiceBackend({ run: queuedRunner([], calls) });
  const provider = new OsCredentialSecretProvider(backend);
  await assert.rejects(provider.store("item", new Uint8Array()), /between 1 and 2560 bytes/);
  await assert.rejects(provider.store("item", new Uint8Array(2561)), /between 1 and 2560 bytes/);
  assert.equal(calls.length, 0);
});
