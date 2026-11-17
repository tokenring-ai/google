import { describe, expect, it } from "bun:test";
import { ConfigurationService } from "@tokenring-ai/app";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import { RpcService } from "@tokenring-ai/rpc";
import SecretService from "@tokenring-ai/secrets/SecretService";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import { FakeVault } from "../../secrets/test/connectHarness.ts";
import GoogleConnectService from "../GoogleConnectService.ts";
import GoogleService from "../GoogleService.ts";
import plugin from "../plugin.ts";
import googleRPC from "../rpc/google.ts";
import GoogleRpcSchema from "../rpc/schema.ts";

const SECRET = "GOCSPX-rpc-secret-value";
const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";

/** A running app's worth of services, with Google itself stubbed (no network). */
function appWithStubs() {
  const vault = new FakeVault();
  const secrets = new SecretService();
  secrets.setStore(vault);
  let global: Record<string, unknown> = {};
  const accounts = () =>
    ((global.google as { accounts?: Record<string, Record<string, any>> } | undefined)?.accounts ?? {}) as Record<string, Record<string, any>>;
  const google = {
    hasClientCredentials: () => Boolean((global.google as { clientId?: unknown } | undefined)?.clientId),
    getAvailableAccounts: () => Object.keys(accounts()),
    requireAccount: (name: string) => accounts()[name],
    getAccountServices: (name: string) => (["gmail", "calendar", "drive"] as const).filter(service => accounts()[name]?.[service]),
    getAccountStatus: (name: string) => ({ isAuthenticated: true, account: accounts()[name] }),
    disconnectAccount: async () => ({ result: "confirmed" as const, message: "Google confirmed that the access was taken back." }),
    redactSecrets: (text: string) => text.split(SECRET).join("[hidden]"),
    cancelPendingAuthorizations: () => {},
    beginAuthorization: () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1", waitForCallback: new Promise<string>(() => {}) }),
  };
  const configuration = {
    getOverrides: (scope: string) => (scope === "global" ? structuredClone(global) : {}),
    update: async (_scope: string, mutate: (layer: Record<string, unknown>) => void) => {
      const next = structuredClone(global);
      mutate(next);
      global = next;
      return { ok: true as const };
    },
    getEffectiveConfig: () => ({ google: global.google }),
  };
  const services = new Map<unknown, unknown>([
    [SecretService, secrets],
    [ConfigurationService, configuration],
    [GoogleService, google],
    [WebHostService, { getURL: () => new URL("http://127.0.0.1:14008/") }],
  ]);
  const app = {
    requireService(type: unknown) {
      if (!services.has(type)) throw new Error("no such service");
      return services.get(type);
    },
  };
  services.set(GoogleConnectService, new GoogleConnectService(app as never));
  return { app: app as never, vault, getSettings: () => global };
}

type Methods = typeof googleRPC.methods;

async function call<K extends keyof Methods>(app: never, method: K, input: unknown) {
  const definition = GoogleRpcSchema.methods[method];
  const parsed = definition.input.parse(input);
  const result = await (googleRPC.methods[method].execute as (args: unknown, app: never) => unknown)(parsed, app);
  // What goes over the wire must satisfy the schema the browser decodes with.
  return definition.result.parse(result) as Record<string, any>;
}

describe("Google RPC", () => {
  it("is registered on the shared RPC service, which authenticates every method", () => {
    const app = createTestingApp();
    const rpc = new RpcService();
    app.addService(RpcService, rpc);
    plugin.install(app);

    expect(rpc.getEndpoint("Google RPC")?.path).toBe("/rpc/google");
    for (const method of Object.keys(GoogleRpcSchema.methods)) expect(rpc.getMethod(`/rpc/google.${method}`)).toBeDefined();
  });

  it("has no method that returns or reads back a credential", () => {
    for (const [name, definition] of Object.entries(GoogleRpcSchema.methods)) {
      const shape = JSON.stringify(definition.result.toJSONSchema());
      expect(shape).not.toMatch(/secret"\s*:/i);
      if (name !== "saveCredentials") expect(JSON.stringify(definition.input.toJSONSchema())).not.toMatch(/secret/i);
    }
  });

  it("walks setup, saving credentials, and starting the sign-in", async () => {
    const { app, vault, getSettings } = appWithStubs();

    const before = await call(app, "getSetup", {});
    expect(before).toMatchObject({ credentialsReady: false, canSaveCredentials: true, redirectUris: ["http://127.0.0.1:14008/oauth/google/callback"] });

    const saved = await call(app, "saveCredentials", { clientId: CLIENT_ID, clientSecret: SECRET });
    expect(saved.status).toBe("success");
    expect(vault.entries.google?.["oauth-client.secret"]).toBe(SECRET);
    expect(JSON.stringify(getSettings())).not.toContain(SECRET);

    const after = await call(app, "getSetup", {});
    expect(after).toMatchObject({ clientIdSource: "vault", clientSecretSource: "vault", clientId: CLIENT_ID });

    const started = await call(app, "startConnect", { email: "elena@example.com", services: ["gmail", "calendar"] });
    expect(started.status).toBe("started");
    expect((await call(app, "getConnectStatus", {})).attempt).toMatchObject({ state: "waiting", email: "elena@example.com" });

    await call(app, "cancelConnect", {});
    expect((await call(app, "getConnectStatus", {})).attempt?.state).toBe("cancelled");

    // Nothing the browser was sent contains the secret.
    expect(JSON.stringify([before, saved, after, started])).not.toContain(SECRET);
  });

  it("reports a locked vault from both saving and connecting", async () => {
    const { app, vault } = appWithStubs();
    vault.writable = false;
    expect((await call(app, "saveCredentials", { clientId: CLIENT_ID, clientSecret: SECRET })).status).toBe("vaultLocked");
    expect((await call(app, "startConnect", { email: "elena@example.com", services: ["gmail", "calendar"] })).status).toBe("vaultLocked");
    expect(vault.entries).toEqual({});
  });

  it("needs at least one service for connecting or changing an account", () => {
    expect(() => GoogleRpcSchema.methods.startConnect.input.parse({ email: "a@example.com", services: [] })).toThrow();
    expect(() => GoogleRpcSchema.methods.startConnect.input.parse({ email: "a@example.com" })).toThrow();
    expect(() => GoogleRpcSchema.methods.updateAccountServices.input.parse({ name: "a", services: [] })).toThrow();
    expect(() => GoogleRpcSchema.methods.startConnect.input.parse({ email: "a@example.com", services: ["gmail", "gmail"] })).toThrow();
    expect(() => GoogleRpcSchema.methods.startConnect.input.parse({ email: "a@example.com", services: ["photos"] })).toThrow();
  });

  it("lists, changes and disconnects accounts, with nothing secret in any answer", async () => {
    const { app, getSettings } = appWithStubs();
    await call(app, "saveCredentials", { clientId: CLIENT_ID, clientSecret: SECRET });
    // An account that finished connecting earlier.
    (getSettings().google as { accounts?: unknown }).accounts = { "elena@example.com": { email: "elena@example.com", gmail: {}, drive: {} } };

    const listed = await call(app, "listAccounts", {});
    expect(listed.accounts).toEqual([{ name: "elena@example.com", email: "elena@example.com", gmail: true, calendar: false, drive: true, connected: true }]);

    const reduced = await call(app, "updateAccountServices", { name: "elena@example.com", services: ["gmail"] });
    expect(reduced).toMatchObject({ status: "saved" });
    expect(reduced.accounts[0]).toMatchObject({ gmail: true, drive: false });

    const added = await call(app, "updateAccountServices", { name: "elena@example.com", services: ["gmail", "calendar"] });
    expect(added.status).toBe("needsConsent");
    expect(added.attempt.services).toEqual(["gmail", "calendar"]);

    const removed = await call(app, "disconnectAccount", { name: "elena@example.com" });
    expect(removed).toMatchObject({ status: "disconnected", revoke: "confirmed", accounts: [] });
    expect((getSettings().google as { accounts?: unknown }).accounts).toBeUndefined();
    expect(JSON.stringify([listed, reduced, added, removed])).not.toContain(SECRET);
  });
});
