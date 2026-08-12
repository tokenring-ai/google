import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AgentEventState } from "@tokenring-ai/agent/state/agentEventState";
import createTestingAgent from "@tokenring-ai/agent/test/createTestingAgent.test";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import VaultService from "../../vault/VaultService.ts";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import googleAuthCommand from "../commands/google/account/auth.ts";
import GoogleService from "../GoogleService.ts";
import { GoogleStoredTokenSchema } from "../schema.ts";

describe("GoogleService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join("/tmp", "google-test-"));
  });

  afterEach(async () => {
    try {
      delete (global as any).fetch;
    } catch {
      // fetch may be non-configurable in this runtime
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes Drive OAuth scope when Drive is configured", () => {
    const app = createTestingApp();
    const service = new GoogleService(app);
    service.reconfigure({
      clientId: "client-id",
      clientSecret: "client-secret",
      accounts: {
        primary: {
          email: "me@example.com",
          drive: {
            description: "Drive",
            rootFolderId: "root",
          },
        },
      },
      agentDefaults: {},
    });

    const url = new URL(service.createAuthorizationUrl("primary", "http://localhost:3000/oauth/google/callback"));
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));

    expect(scopes.has("https://www.googleapis.com/auth/drive")).toBe(true);
    expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(true);
    // Gmail is not configured, so gmail scopes should not be requested
    expect(scopes.has("https://www.googleapis.com/auth/gmail.readonly")).toBe(false);
  });

  it("includes Gmail OAuth scope when Gmail is configured", () => {
    const app = createTestingApp();
    const service = new GoogleService(app);
    service.reconfigure({
      clientId: "client-id",
      clientSecret: "client-secret",
      accounts: {
        primary: {
          email: "me@example.com",
          gmail: {
            description: "Gmail",
          },
        },
      },
      agentDefaults: {},
    });

    const url = new URL(service.createAuthorizationUrl("primary", "http://localhost:3000/oauth/google/callback"));
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));

    expect(scopes.has("https://www.googleapis.com/auth/gmail.readonly")).toBe(true);
    expect(scopes.has("https://www.googleapis.com/auth/userinfo.email")).toBe(true);
  });

  it("authenticates an account through the web host callback and stores tokens in the vault", async () => {
    const app = createTestingApp();
    const agent = createTestingAgent(app);
    const vault = new VaultService({
      vaultFile: path.join(tempDir, "test.vault"),
      relockTime: 300_000,
    });
    vault.setPassword("test-password");
    const webHost = new WebHostService(app, {
      host: "127.0.0.1",
      port: 3000,
      auth: {
        users: {
          testuser: { password: "testpass" },
        },
      },
    });
    const service = new GoogleService(app);
    service.reconfigure({
      clientId: "client-id",
      clientSecret: "client-secret",
      accounts: {
        primary: {
          email: "me@example.com",
          gmail: {
            description: "Gmail",
          },
        },
      },
      agentDefaults: {},
    });

    spyOn(Bun, "serve").mockReturnValue({
      hostname: "127.0.0.1",
      port: 3000,
      stop: mock(),
    } as any);

    app.addServices([vault, webHost, service]);
    await webHost.listen();
    spyOn(agent, "chatOutput").mockImplementation(() => {});

    agent.mutateState(AgentEventState, state => {
      state.currentlyExecutingInputItem = {
        request: {
          type: "input.received",
          requestId: "test-request",
          timestamp: Date.now(),
          input: { from: "test", message: "/google account auth primary" },
        },
        executionState: {
          status: "running",
          currentActivity: "testing",
          availableInteractions: [],
        },
        interactionCallbacks: new Map(),
        abortController: new AbortController(),
      };
    });

    const beginAuthorization = spyOn(service, "beginAuthorization").mockReturnValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
      waitForCallback: Promise.resolve("http://127.0.0.1:3000/oauth/google/callback?state=test-state&code=auth-code"),
    });

    spyOn(service, "exchangeAuthorizationCode").mockImplementation(async accountName => {
      await vault.setJsonItem("google", accountName, {
        refreshToken: "refresh-token",
        accessToken: "access-token",
        expiryDate: Date.now() + 3600_000,
        grantedScopes: ["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.readonly"],
        profile: {
          email: "me@example.com",
        },
      });
      return {
        isAuthenticated: true,
        account: service.requireAccount(accountName),
        profile: { email: "me@example.com" },
      };
    });

    const result = await googleAuthCommand.execute({
      agent,
      args: { name: "primary" },
    });
    const stored = vault.requireJsonItem("google", "primary", GoogleStoredTokenSchema);

    expect(beginAuthorization).toHaveBeenCalledWith("primary", "http://127.0.0.1:3000/oauth/google/callback");
    expect(result).toContain("authenticated with email me@example.com");
    expect(stored).toMatchObject({
      refreshToken: "refresh-token",
      accessToken: "access-token",
      grantedScopes: ["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.readonly"],
      profile: { email: "me@example.com" },
    });
    expect(typeof stored?.expiryDate).toBe("number");
  });
});
