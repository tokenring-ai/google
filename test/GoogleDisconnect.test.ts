import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import { CalendarService } from "@tokenring-ai/calendar";
import { EmailService } from "@tokenring-ai/email";
import { RemoteStoreService } from "@tokenring-ai/filesystem";
import VaultService from "../../vault/VaultService.ts";
import GoogleService from "../GoogleService.ts";
import { GOOGLE_SERVICE_SCOPES, GOOGLE_USERINFO_SCOPE, scopesForServices } from "../scopes.ts";

const REFRESH = "1//refresh-token-value";
const ACCESS = "ya29.access-token-value";

/** A vault that keeps entries in memory. */
class FakeVaultService {
  entries: Record<string, Record<string, string>> = {};
  deleted: string[] = [];
  fail = false;
  getItemsByCategory(category: string) {
    return this.entries[category] ?? {};
  }
  requireJsonItem(category: string, key: string, schema: { parse(value: unknown): unknown }) {
    const raw = this.entries[category]?.[key];
    if (raw === undefined) throw new Error("missing");
    return schema.parse(JSON.parse(raw));
  }
  async setJsonItem(category: string, key: string, value: unknown) {
    (this.entries[category] ??= {})[key] = JSON.stringify(value);
  }
  async deleteItem(category: string, key: string) {
    if (this.fail) throw new Error("Vault is uninitialized or locked");
    delete this.entries[category]?.[key];
    this.deleted.push(`${category}/${key}`);
  }
}

const storedToken = JSON.stringify({ refreshToken: REFRESH, accessToken: ACCESS, profile: { email: "a@example.com" } });

function setup() {
  const app = createTestingApp();
  const email = new EmailService();
  const calendar = new CalendarService();
  app.addService(EmailService, email);
  app.addService(CalendarService, calendar);
  const mountsChanged: number[] = [];
  app.addService(RemoteStoreService, { mountsChanged: () => mountsChanged.push(1) } as never);
  const service = new GoogleService(app);
  service.reconfigure({
    clientId: "id",
    clientSecret: "client-secret-value",
    accounts: {
      a: { email: "a@example.com", gmail: { description: "Gmail" }, calendar: { description: "Cal", calendarId: "primary" } },
      b: {
        email: "b@example.com",
        gmail: { description: "Gmail" },
        drive: { description: "Drive", rootFolderId: "root", writable: false, contextualSearch: false },
      },
    },
    agentDefaults: {},
  });
  const vault = new FakeVaultService();
  vault.entries.google = {
    a: storedToken,
    b: storedToken.replace("a@", "b@").replace(REFRESH, "1//other-refresh"),
    "oauth-client.secret": "client-secret-value",
  };
  app.addService(VaultService, vault as never);
  return { app, service, vault, email, calendar, mountsChanged };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("scopes per service", () => {
  const gmail = GOOGLE_SERVICE_SCOPES.gmail;
  const calendar = GOOGLE_SERVICE_SCOPES.calendar;
  const drive = GOOGLE_SERVICE_SCOPES.drive;

  it("always asks for the identity scope and nothing for a service that was not chosen", () => {
    expect(scopesForServices(["gmail"])).toEqual([GOOGLE_USERINFO_SCOPE, ...gmail]);
    expect(scopesForServices(["calendar"])).toEqual([GOOGLE_USERINFO_SCOPE, ...calendar]);
    expect(scopesForServices(["drive"])).toEqual([GOOGLE_USERINFO_SCOPE, ...drive]);
    expect(scopesForServices(["gmail", "calendar"])).toEqual([GOOGLE_USERINFO_SCOPE, ...gmail, ...calendar]);
    expect(scopesForServices(["calendar", "drive"])).toEqual([GOOGLE_USERINFO_SCOPE, ...calendar, ...drive]);
    expect(scopesForServices(["gmail", "calendar", "drive"])).toHaveLength(1 + gmail.length + calendar.length + drive.length);
    expect(scopesForServices([])).toEqual([GOOGLE_USERINFO_SCOPE]);
  });

  it("never includes Drive unless Drive was chosen", () => {
    for (const services of [["gmail"], ["calendar"], ["gmail", "calendar"]] as const) {
      expect(scopesForServices(services)).not.toContain("https://www.googleapis.com/auth/drive");
    }
  });

  it("asks Google for the chosen services when a sign-in begins, whatever the account has configured", () => {
    const { service } = setup();
    const url = (services?: ("gmail" | "calendar" | "drive")[]) => {
      const { authorizationUrl, waitForCallback } = service.beginAuthorization("a", "http://127.0.0.1:1/oauth/google/callback", services ? { services } : {});
      waitForCallback.catch(() => {});
      service.cancelPendingAuthorizations("a", "test");
      return new Set((new URL(authorizationUrl).searchParams.get("scope") ?? "").split(" "));
    };
    // Re-authorizing without a choice asks for exactly the account's configured services (Gmail and Calendar).
    expect(url()).toEqual(new Set(scopesForServices(["gmail", "calendar"])));
    expect(url(["gmail", "calendar", "drive"]).has("https://www.googleapis.com/auth/drive")).toBe(true);
    expect(url(["calendar"])).toEqual(new Set(scopesForServices(["calendar"])));
  });
});

describe("GoogleService.disconnectAccount", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let output: string[];
  const spies: { mockRestore(): void }[] = [];

  beforeEach(() => {
    output = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" "))));
    }
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const spy of spies.splice(0)) spy.mockRestore();
    expect(output.join("\n")).not.toContain(REFRESH);
    expect(output.join("\n")).not.toContain(ACCESS);
  });

  it("revokes the refresh token at Google, deletes the vault entry and unregisters the providers", async () => {
    const { service, vault, email, calendar, mountsChanged } = setup();
    await settle();
    expect(service.getAccountStatus("a").isAuthenticated).toBe(true);
    expect(email.getAvailableProviders()).toContain("a");
    expect(calendar.getAvailableProviders()).toContain("a");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    const outcome = await service.disconnectAccount("a");

    expect(outcome.result).toBe("confirmed");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect((init.body as URLSearchParams).toString()).toBe(`token=${encodeURIComponent(REFRESH)}`);
    expect(vault.entries.google?.a).toBeUndefined();
    expect(vault.deleted).toEqual(["google/a"]);
    expect(email.getAvailableProviders()).not.toContain("a");
    expect(calendar.getAvailableProviders()).not.toContain("a");
    expect(service.getAccountStatus("a").isAuthenticated).toBe(false);
    expect(mountsChanged.length).toBeGreaterThan(0);
    expect(JSON.stringify(outcome)).not.toContain(REFRESH);
  });

  it("leaves the other accounts, and the shared client credentials, alone", async () => {
    const { service, vault, email } = setup();
    await settle();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await service.disconnectAccount("a");

    expect(vault.entries.google?.b).toBeDefined();
    expect(vault.entries.google?.["oauth-client.secret"]).toBe("client-secret-value");
    expect(email.getAvailableProviders()).toContain("b");
    expect(service.getAccountStatus("b").isAuthenticated).toBe(true);
    expect(service.hasClientCredentials()).toBe(true);
  });

  it("still disconnects when Google cannot be reached, and says Google did not confirm", async () => {
    const { service, vault, email } = setup();
    await settle();
    fetchSpy.mockRejectedValue(new Error(`network down while sending ${REFRESH}`));

    const outcome = await service.disconnectAccount("a");

    expect(outcome.result).toBe("notConfirmed");
    expect(outcome.message).toContain("did not confirm");
    expect(outcome.message).toContain("myaccount.google.com/permissions");
    expect(outcome.message).not.toContain(REFRESH);
    expect(vault.entries.google?.a).toBeUndefined();
    expect(email.getAvailableProviders()).not.toContain("a");
  });

  it("still disconnects when Google answers with an error", async () => {
    const { service, vault } = setup();
    await settle();
    fetchSpy.mockResolvedValue(new Response('{"error":"invalid_token"}', { status: 400 }));

    const outcome = await service.disconnectAccount("a");
    expect(outcome.result).toBe("notConfirmed");
    expect(outcome.message).toContain("400");
    expect(vault.entries.google?.a).toBeUndefined();
  });

  it("does not call Google when there is no saved access", async () => {
    const { service, vault } = setup();
    await settle();
    delete vault.entries.google?.a;
    // A fresh service that never loaded a token for "a".
    const { service: fresh } = setup();
    fresh.reconfigure({ clientId: "id", clientSecret: "s", accounts: { c: { email: "c@example.com", gmail: { description: "Gmail" } } }, agentDefaults: {} });
    const outcome = await fresh.disconnectAccount("c");
    expect(outcome.result).toBe("nothingToRevoke");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service).toBeDefined();
  });

  it("ends a sign-in that is waiting for the account", async () => {
    const { service } = setup();
    await settle();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const pending = service.beginAuthorization("a", "http://127.0.0.1:1/oauth/google/callback");
    const ended = pending.waitForCallback.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await service.disconnectAccount("a");
    expect(await ended).toContain("disconnected");
  });

  it("reports a vault that cannot be written instead of pretending the entry is gone", async () => {
    const { service, vault } = setup();
    await settle();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    vault.fail = true;
    await expect(service.disconnectAccount("a")).rejects.toThrow("locked");
  });
  it("a disconnect that lands while the code exchange is in flight leaves nothing saved and takes the new grant back", async () => {
    const { service, vault } = setup();
    await settle();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    let release: (tokens: object) => void = () => {};
    const getToken = () =>
      new Promise(resolve => {
        release = tokens => resolve({ tokens });
      });
    spyOn(service as never, "createOAuthClient").mockReturnValue({ getToken, setCredentials() {} } as never);

    const outcome = service.exchangeAuthorizationCode("a", "code", "http://127.0.0.1:1/cb").then(
      () => "saved",
      (error: Error) => error.message,
    );
    await settle();
    await service.disconnectAccount("a"); // runs to the end while Google has not answered yet
    release({ refresh_token: "1//new-refresh", access_token: "ya29.new" });

    expect(await outcome).toContain("disconnected while signing in");
    expect(vault.entries.google?.a).toBeUndefined();
    const sent = (fetchSpy.mock.calls as [string, RequestInit][]).map(call => String(call[1].body)).join(" ");
    expect(sent).toContain(encodeURIComponent("1//new-refresh")); // the grant that arrived late was revoked
  });
});
