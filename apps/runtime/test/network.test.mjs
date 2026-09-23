import assert from "node:assert/strict";
import test from "node:test";

import { httpOrigin, socketAddress } from "../dist/network.js";
import { managedRestateConfig } from "../dist/processes.js";

test("runtime address formatting brackets IPv6 loopback hosts", () => {
  assert.equal(socketAddress("::1", 4320), "[::1]:4320");
  assert.equal(httpOrigin("::1", 4320), "http://[::1]:4320");
  assert.equal(httpOrigin("127.0.0.1", 4320), "http://127.0.0.1:4320");
});

test("managed Restate config is TCP-only and loopback-bound", () => {
  const ipv4 = managedRestateConfig({
    ingressHost: "127.0.0.1",
    ingressPort: 8080,
    adminHost: "127.0.0.1",
    adminPort: 9070,
    queryHost: "127.0.0.1",
    queryPort: 9071,
  });
  assert.match(ipv4, /^listen-mode = "tcp"$/m);
  assert.match(ipv4, /bind-address = "127\.0\.0\.1:9070"/);
  assert.match(ipv4, /pgsql-bind-address = "127\.0\.0\.1:9071"/);
  assert.match(ipv4, /bind-address = "127\.0\.0\.1:8080"/);
  assert.doesNotMatch(ipv4, /0\.0\.0\.0/);

  const ipv6 = managedRestateConfig({
    ingressHost: "::1",
    ingressPort: 8080,
    adminHost: "::1",
    adminPort: 9070,
    queryHost: "::1",
    queryPort: 9071,
  });
  assert.match(ipv6, /^listen-mode = "tcp"$/m);
  assert.match(ipv6, /bind-address = "\[::1\]:9070"/);
  assert.match(ipv6, /pgsql-bind-address = "\[::1\]:9071"/);
  assert.match(ipv6, /bind-address = "\[::1\]:8080"/);
});
