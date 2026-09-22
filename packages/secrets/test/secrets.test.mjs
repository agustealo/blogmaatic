import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentSecretProvider, SecretAuthority } from "../dist/index.js";

test("resolves environment references only inside the callback", async () => {
  const authority = new SecretAuthority([
    new EnvironmentSecretProvider({ BLOGMAATIC_TEST_SECRET: "private-value" }),
  ]);
  const length = await authority.withUtf8("env:BLOGMAATIC_TEST_SECRET", (value) => value.length);
  assert.equal(length, "private-value".length);
});

test("zeroes provider material after callback completion", async () => {
  let material;
  const authority = new SecretAuthority([
    {
      scheme: "test",
      async resolve() {
        material = new TextEncoder().encode("erase-me");
        return material;
      },
    },
  ]);
  await authority.withUtf8("test:item", (value) => assert.equal(value, "erase-me"));
  assert.deepEqual([...material], new Array(material.length).fill(0));
});

test("does not echo missing secret locators into unavailable errors", async () => {
  const authority = new SecretAuthority([new EnvironmentSecretProvider({})]);
  await assert.rejects(
    authority.withUtf8("env:SUPER_SENSITIVE_LOCATOR", () => undefined),
    (error) => {
      assert.match(error.message, /env:\[redacted\]/);
      assert.doesNotMatch(error.message, /SUPER_SENSITIVE_LOCATOR/);
      return true;
    },
  );
});
