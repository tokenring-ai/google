import { describe, expect, it } from "bun:test";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import GoogleService from "../GoogleService.ts";

const config = (overrides: { clientId?: string; clientSecret?: string } = {}) => ({
  accounts: { "me@example.com": { email: "me@example.com", gmail: { description: "Gmail" } } },
  agentDefaults: {},
  ...overrides,
});

describe("GoogleService wizard support", () => {
  it("knows whether both client credentials have a value", () => {
    const service = new GoogleService(createTestingApp());
    service.reconfigure(config());
    expect(service.hasClientCredentials()).toBe(false);
    service.reconfigure(config({ clientId: "id" }));
    expect(service.hasClientCredentials()).toBe(false);
    service.reconfigure(config({ clientId: "id", clientSecret: "secret" }));
    expect(service.hasClientCredentials()).toBe(true);
  });

  it("removes the client secret from text", () => {
    const service = new GoogleService(createTestingApp());
    service.reconfigure(config({ clientId: "id", clientSecret: "GOCSPX-real-secret" }));
    expect(service.redactSecrets("failed with GOCSPX-real-secret in it, twice GOCSPX-real-secret")).toBe("failed with [hidden] in it, twice [hidden]");
  });

  it("ends only the pending sign-in of the named account", async () => {
    const service = new GoogleService(createTestingApp());
    service.reconfigure({
      ...config({ clientId: "id", clientSecret: "secret" }),
      accounts: { a: { email: "a@example.com", gmail: { description: "Gmail" } }, b: { email: "b@example.com", gmail: { description: "Gmail" } } },
    });
    const a = service.beginAuthorization("a", "http://127.0.0.1:1/oauth/google/callback");
    const b = service.beginAuthorization("b", "http://127.0.0.1:1/oauth/google/callback");
    const stillWaiting = Symbol("waiting");

    service.cancelPendingAuthorizations("a", "cancelled by test");
    await expect(a.waitForCallback).rejects.toThrow("cancelled by test");
    expect(await Promise.race([b.waitForCallback, Promise.resolve(stillWaiting)])).toBe(stillWaiting);
  });
});
