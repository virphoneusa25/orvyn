import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrowserUrl } from "./BrowserProvider";

test("SSRF Protection: Blocks loopback and local hostnames", () => {
  const loopbackTargets = [
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "https://0.0.0.0/",
    "http://[::1]/",
    "http://test.localhost",
    "http://internal.invalid",
  ];

  for (const url of loopbackTargets) {
    const result = validateBrowserUrl(url);
    assert.equal(result.ok, false, `Expected loopback to be blocked: ${url}`);
    assert.match(result.error ?? "", /restricted|loopback/i);
  }
});

test("SSRF Protection: Blocks Cloud Metadata Endpoints (AWS / GCP / Azure)", () => {
  const metadataTargets = [
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ];

  for (const url of metadataTargets) {
    const result = validateBrowserUrl(url);
    assert.equal(result.ok, false, `Expected cloud metadata endpoint to be blocked: ${url}`);
    assert.match(result.error ?? "", /forbidden|metadata/i);
  }
});

test("SSRF Protection: Blocks RFC 1918 Private Subnets", () => {
  const privateSubnets = [
    "http://10.0.0.1/admin",
    "http://10.254.1.10:8000",
    "http://192.168.1.1/router",
    "http://192.168.0.100",
    "http://172.16.0.1/internal",
    "http://172.31.255.254",
  ];

  for (const url of privateSubnets) {
    const result = validateBrowserUrl(url);
    assert.equal(result.ok, false, `Expected private RFC 1918 subnet to be blocked: ${url}`);
    assert.match(result.error ?? "", /private network address/i);
  }
});

test("SSRF Protection: Blocks unsupported/dangerous protocols", () => {
  const dangerousProtocols = [
    "file:///etc/passwd",
    "gopher://example.com",
    "ftp://example.com/file",
    "javascript:alert(1)",
  ];

  for (const url of dangerousProtocols) {
    const result = validateBrowserUrl(url);
    assert.equal(result.ok, false, `Expected unsupported protocol to be blocked: ${url}`);
  }
});

test("URL Validation: Allows legitimate public web destinations", () => {
  const validTargets = [
    { input: "www.virphoneusa.com", expected: "https://www.virphoneusa.com" },
    { input: "https://kernelailabs.com", expected: "https://kernelailabs.com" },
    { input: "http://example.com/test?query=1", expected: "http://example.com/test?query=1" },
  ];

  for (const { input, expected } of validTargets) {
    const result = validateBrowserUrl(input);
    assert.equal(result.ok, true, `Expected valid destination to be accepted: ${input}`);
    assert.ok(result.normalizedUrl.startsWith("http"));
  }
});
