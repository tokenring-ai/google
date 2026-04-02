import createTestingAgent from "@tokenring-ai/agent/test/createTestingAgent";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp";
import {mkdtemp, rm} from "node:fs/promises";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {AgentEventState} from "../../agent/state/agentEventState.ts";
import {WebHostService} from "../../web-host/index.ts";
import VaultService from "../../vault/VaultService.ts";
import googleAuthCommand from "../commands/google/account/auth.ts";
import GoogleService from "../GoogleService.ts";
import {GoogleConfigSchema} from "../schema.ts";

describe("GoogleService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join("/tmp", "google-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(tempDir, {recursive: true, force: true});
  });

  it("includes Drive OAuth scope when Drive is configured", () => {
    const service = new GoogleService(GoogleConfigSchema.parse({
      accounts: {
        primary: {
          clientId: "client-id",
          clientSecret: "client-secret",
          drive: {
            description: "Drive",
            rootFolderId: "root",
          },
        },
      },
    }));

    const url = new URL(service.createAuthorizationUrl("primary", "http://localhost:3000/oauth/google/callback"));
    const scopes = new Set((url.searchParams.get("scope") ?? "").split(" "));

    expect(scopes.has("https://www.googleapis.com/auth/drive")).toBe(true);
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
      resources: {},
    });
    const service = new GoogleService(GoogleConfigSchema.parse({
      accounts: {
        primary: {
          clientId: "client-id",
          clientSecret: "client-secret",
          email: {
            description: "Gmail",
          },
        },
      },
    }), vault);

    vi.stubGlobal("Bun", {
      serve: vi.fn(() => ({
        hostname: "127.0.0.1",
        port: 3000,
        stop: vi.fn(),
      })),
      file: vi.fn(),
    });

    app.addServices(vault, webHost, service);
    await webHost.start(new AbortController().signal);
    vi.spyOn(agent, "chatOutput").mockImplementation(() => {});

    agent.mutateState(AgentEventState, (state) => {
      state.currentlyExecutingInputItem = {
        request: {
          type: "input.received",
          requestId: "test-request",
          timestamp: Date.now(),
          input: {from: "test", message: "/google account auth primary"},
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

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
        ].join(" "),
        token_type: "Bearer",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: "me@example.com",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })));

    const beginAuthorization = vi.spyOn(service, "beginAuthorization").mockReturnValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
      waitForCallback: Promise.resolve("http://127.0.0.1:3000/oauth/google/callback?state=test-state&code=auth-code"),
    });

    const result = await googleAuthCommand.execute({
      agent,
      positionals: {
        name: "primary",
      },
    });
    const stored = await vault.getJsonItem<{userEmail?: string; refreshToken?: string; accessToken?: string; expiryDate?: number}>("google", "primary");

    expect(beginAuthorization).toHaveBeenCalledWith("primary", "http://127.0.0.1:3000/oauth/google/callback");
    expect(result).toContain('tokens were saved to the vault');
    expect(result).toContain("me@example.com");
    expect(stored).toMatchObject({
      userEmail: "me@example.com",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      grantedScopes: [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
    });
    expect(typeof stored?.expiryDate).toBe("number");
  });

  it("explains when Calendar access fails because the token is missing the Calendar scope", async () => {
    const service = new GoogleService(GoogleConfigSchema.parse({
      accounts: {
        primary: {
          clientId: "client-id",
          clientSecret: "client-secret",
          accessToken: "access-token",
          expiryDate: Date.now() + 60_000,
          grantedScopes: [
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/gmail.readonly",
          ],
          email: {
            description: "Gmail",
          },
          calendar: {
            description: "Calendar",
            calendarId: "primary",
          },
        },
      },
    }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
      },
    }), {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    })));

    await expect(service.fetchGoogleRaw(
      "primary",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {method: "GET"},
      "list Google Calendar events",
    )).rejects.toThrow(
      'list Google Calendar events failed (403): Google account "primary" is authenticated, but it is missing permission for this request. Missing scope: https://www.googleapis.com/auth/calendar. Re-run /google account auth primary to grant access.',
    );
  });
});
