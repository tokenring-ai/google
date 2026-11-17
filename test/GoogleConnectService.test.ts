import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConfigurationService } from "@tokenring-ai/app";
import SecretService from "@tokenring-ai/secrets/SecretService";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import { FakeVault } from "../../secrets/test/connectHarness.ts";
import GoogleConnectService from "../GoogleConnectService.ts";
import GoogleService from "../GoogleService.ts";
import type { GoogleConnectErrorCode } from "../rpc/schema.ts";

const SECRET = "GOCSPX-super-secret-value";
const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const AUTH_CODE = "4/0AX4XfWh-the-auth-code";
const EMAIL = "elena@example.com";

type Layer = { google?: { clientId?: unknown; clientSecret?: unknown; accounts?: Record<string, Record<string, unknown>> } };

/** Settings that keep both layers, as ConfigurationService.update does, and tell the fake Google service about the merged result. */
class FakeConfiguration {
  layers: Record<"global" | "workspace", Layer> = { global: {}, workspace: {} };
  reject: string | undefined;
  constructor(private readonly google: FakeGoogle) {}
  get global(): Layer {
    return this.layers.global;
  }
  getOverrides(scope: "global" | "workspace") {
    return structuredClone(this.layers[scope]);
  }
  async update(scope: "global" | "workspace", mutate: (layer: Layer) => void) {
    if (this.reject) return { ok: false as const, issues: [{ path: ["google"], message: this.reject }] };
    const next = structuredClone(this.layers[scope]);
    mutate(next);
    this.layers[scope] = next;
    this.google.sync(this.layers);
    return { ok: true as const };
  }
  getEffectiveConfig() {
    return { google: { clientId: this.global.google?.clientId, clientSecret: this.global.google?.clientSecret } };
  }
}

type FakeAccount = { email: string; gmail?: object; calendar?: object; drive?: object };

/** The Google service stubbed: no network. Records what the wizard asks of it. */
class FakeGoogle {
  accounts: Record<string, FakeAccount> = {};
  ready = false;
  authenticated = new Set<string>();
  disconnected: string[] = [];
  revokeOutcome: { result: "confirmed" | "notConfirmed" | "nothingToRevoke"; message: string } = {
    result: "confirmed",
    message: "Google confirmed that the access was taken back.",
  };
  pending: { name: string; resolve: (url: string) => void; reject: (error: Error) => void }[] = [];
  beginAuthorization = mock((name: string, redirectUri: string, _options?: { services?: readonly string[] }) => {
    const waitForCallback = new Promise<string>((resolve, reject) => this.pending.push({ name, resolve, reject }));
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      waitForCallback,
    };
  });
  exchangeAuthorizationCode = mock(
    async (
      name: string,
      _code: string,
      _redirectUri: string,
    ): Promise<{ isAuthenticated: boolean; profile: { email: string } | undefined; account: { email: string } }> => {
      this.authenticated.add(name);
      return { isAuthenticated: true, profile: { email: EMAIL }, account: this.accounts[name]! };
    },
  );
  sync(layers: Record<"global" | "workspace", Layer>) {
    const merged: Record<string, FakeAccount> = {};
    for (const layer of [layers.global, layers.workspace]) {
      for (const [name, account] of Object.entries(layer.google?.accounts ?? {})) merged[name] = { ...merged[name], ...account } as FakeAccount;
    }
    this.accounts = merged;
    this.ready = Boolean(layers.global.google?.clientId && layers.global.google?.clientSecret);
  }
  hasClientCredentials() {
    return this.ready;
  }
  getAvailableAccounts() {
    return Object.keys(this.accounts);
  }
  requireAccount(name: string) {
    return this.accounts[name]!;
  }
  getAccountServices(name: string) {
    const account = this.accounts[name]!;
    return (["gmail", "calendar", "drive"] as const).filter(service => account[service]);
  }
  getAccountStatus(name: string) {
    return { isAuthenticated: this.authenticated.has(name), profile: undefined, account: this.accounts[name]! };
  }
  redactSecrets(text: string) {
    return text.split(SECRET).join("[hidden]");
  }
  cancelPendingAuthorizations = mock((name: string, reason: string) => {
    for (const pending of this.pending.filter(item => item.name === name)) pending.reject(new Error(reason));
  });
  disconnectAccount = mock(async (name: string) => {
    this.disconnected.push(name);
    this.authenticated.delete(name);
    return this.revokeOutcome;
  });
}

function setup(options: { timeoutMs?: number } = {}) {
  const vault = new FakeVault();
  const secrets = new SecretService();
  secrets.setStore(vault);
  const google = new FakeGoogle();
  const configuration = new FakeConfiguration(google);
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
  const service = new GoogleConnectService(app as never, options);
  return { service, vault, google, configuration };
}

const DEFAULT_SERVICES = ["gmail", "calendar"] as const;
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function withCredentials(ctx: ReturnType<typeof setup>) {
  const result = await ctx.service.saveCredentials(CLIENT_ID, SECRET);
  expect(result.status).toBe("success");
}

describe("GoogleConnectService", () => {
  let output: string[];
  const spies: { mockRestore(): void }[] = [];

  beforeEach(() => {
    output = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" "))));
    }
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    // Nothing the wizard does may print the secret or the sign-in code.
    expect(output.join("\n")).not.toContain(SECRET);
    expect(output.join("\n")).not.toContain(AUTH_CODE);
  });

  describe("setup", () => {
    it("reports the redirect address from the running server and that nothing is saved yet", () => {
      const { service } = setup();
      expect(service.getSetup()).toEqual({
        redirectUris: ["http://127.0.0.1:14008/oauth/google/callback"],
        canSaveCredentials: true,
        clientIdSource: "none",
        clientSecretSource: "none",
        credentialsReady: false,
        accounts: [],
      });
    });

    it("says the vault is locked when credentials cannot be saved", () => {
      const ctx = setup();
      ctx.vault.writable = false;
      expect(ctx.service.getSetup().canSaveCredentials).toBe(false);
    });
  });

  describe("saveCredentials", () => {
    it("saves both values to the vault and only references to the settings", async () => {
      const ctx = setup();
      const result = await ctx.service.saveCredentials(`  ${CLIENT_ID} `, `${SECRET}\n`);

      expect(result.status).toBe("success");
      expect(ctx.vault.entries.google).toEqual({ "oauth-client.id": CLIENT_ID, "oauth-client.secret": SECRET });
      expect(ctx.configuration.global.google).toEqual({
        clientId: { source: "vault", category: "google", key: "oauth-client.id" },
        clientSecret: { source: "vault", category: "google", key: "oauth-client.secret" },
      });
      expect(JSON.stringify(ctx.configuration.global)).not.toContain(SECRET);
      // Not in the answer, and not in what the page asks for afterwards.
      expect(JSON.stringify(result)).not.toContain(SECRET);
      const after = ctx.service.getSetup();
      expect(JSON.stringify(after)).not.toContain(SECRET);
      expect(after).toMatchObject({ clientIdSource: "vault", clientSecretSource: "vault", clientId: CLIENT_ID, credentialsReady: true });
    });

    it("writes nothing and says so when the vault is locked", async () => {
      const ctx = setup();
      ctx.vault.writable = false;
      const result = await ctx.service.saveCredentials(CLIENT_ID, SECRET);

      expect(result.status).toBe("vaultLocked");
      expect(ctx.vault.entries).toEqual({});
      expect(ctx.configuration.global).toEqual({});
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("refuses values that cannot be right, without echoing the secret", async () => {
      const ctx = setup();
      expect((await ctx.service.saveCredentials("", SECRET)).status).toBe("invalid");
      expect((await ctx.service.saveCredentials("not-a-client-id", SECRET)).status).toBe("invalid");
      expect((await ctx.service.saveCredentials(CLIENT_ID, "")).status).toBe("invalid");
      const spaced = await ctx.service.saveCredentials(CLIENT_ID, "GOCSPX-has space");
      expect(spaced.status).toBe("invalid");
      expect(JSON.stringify(spaced)).not.toContain("GOCSPX-has");
      expect(ctx.vault.entries).toEqual({});
    });

    it("puts the vault back as it was when the settings refuse the change", async () => {
      const ctx = setup();
      ctx.configuration.reject = `bad value ${SECRET}`;
      const result = await ctx.service.saveCredentials(CLIENT_ID, SECRET);

      expect(result.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(ctx.vault.entries.google ?? {}).toEqual({});
    });
  });

  describe("connecting", () => {
    it("asks for a valid email address first", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      expect((await ctx.service.startSignIn("elena", DEFAULT_SERVICES)).status).toBe("invalid");
      expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
    });

    it("needs the vault unlocked, and credentials saved", async () => {
      const ctx = setup();
      expect((await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES)).status).toBe("needsCredentials");
      await withCredentials(ctx);
      ctx.vault.writable = false;
      expect((await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES)).status).toBe("vaultLocked");
      expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
    });

    it("starts the existing sign-in, adds a Gmail and Calendar account, and connects when Google calls back", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      const started = await ctx.service.startSignIn("Elena@Example.com ", DEFAULT_SERVICES);

      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      expect(started.attempt).toMatchObject({ name: EMAIL, email: EMAIL, state: "waiting" });
      expect(started.attempt.authorizationUrl).toContain("accounts.google.com");
      expect(ctx.google.beginAuthorization).toHaveBeenCalledWith(EMAIL, "http://127.0.0.1:14008/oauth/google/callback", { services: ["gmail", "calendar"] });
      expect(ctx.configuration.global.google?.accounts).toEqual({ [EMAIL]: { email: EMAIL, gmail: {}, calendar: {} } });

      ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?state=s&code=${AUTH_CODE}`);
      await settle();

      expect(ctx.google.exchangeAuthorizationCode).toHaveBeenCalledWith(EMAIL, AUTH_CODE, "http://127.0.0.1:14008/oauth/google/callback");
      expect(ctx.service.getAttempt()).toMatchObject({ state: "connected", connectedEmail: EMAIL });
      expect(ctx.service.getAttempt()?.authorizationUrl).toBeUndefined();
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toBeDefined();
    });

    it("shows the finishing state while the sign-in code is exchanged", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      let release: () => void = () => {};
      ctx.google.exchangeAuthorizationCode.mockImplementationOnce(async name => {
        await new Promise<void>(resolve => (release = resolve));
        return { isAuthenticated: true, profile: { email: EMAIL }, account: ctx.google.accounts[name]! };
      });
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
      await settle();

      expect(ctx.service.getAttempt()?.state).toBe("finishing");
      release();
      await settle();
      expect(ctx.service.getAttempt()?.state).toBe("connected");
    });

    const failures: [string, () => Promise<unknown>, GoogleConnectErrorCode][] = [
      ["Google sends the user back with access_denied", async () => Promise.reject(new Error("Google authorization failed: access_denied")), "accessDenied"],
      [
        "Google's return address check fails",
        async () => Promise.reject(new Error("The Google OAuth callback redirect URI did not match the pending authorization request.")),
        "redirectUriMismatch",
      ],
    ];
    for (const [name, fail, code] of failures) {
      it(`maps a failure when ${name} to ${code} and takes back the new account`, async () => {
        const ctx = setup();
        await withCredentials(ctx);
        await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
        void fail().catch((error: Error) => ctx.google.pending[0]!.reject(error));
        await settle();

        const attempt = ctx.service.getAttempt()!;
        expect(attempt.state).toBe("failed");
        expect(attempt.error?.code).toBe(code);
        expect(attempt.authorizationUrl).toBeUndefined();
        expect(ctx.configuration.global.google?.accounts).toBeUndefined();
      });
    }

    const exchangeFailures: [string, GoogleConnectErrorCode][] = [
      ["exchange Google auth code for elena@example.com failed: redirect_uri_mismatch", "redirectUriMismatch"],
      ["exchange Google auth code for elena@example.com failed: invalid_client", "wrongClient"],
      ["exchange Google auth code for elena@example.com failed: invalid_grant", "invalidGrant"],
      ["exchange Google auth code for elena@example.com failed: Vault is uninitialized or locked", "vaultLocked"],
      ["exchange Google auth code for elena@example.com failed: socket hang up", "exchangeFailed"],
      ["Totally unexpected", "unknown"],
    ];
    for (const [message, code] of exchangeFailures) {
      it(`maps the token exchange error "${message}" to ${code}`, async () => {
        const ctx = setup();
        await withCredentials(ctx);
        ctx.google.exchangeAuthorizationCode.mockImplementationOnce(async () => {
          throw new Error(message);
        });
        await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
        ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
        await settle();

        const attempt = ctx.service.getAttempt()!;
        expect(attempt.state).toBe("failed");
        expect(attempt.error?.code).toBe(code);
        expect(attempt.error?.details).toBe(message);
      });
    }

    it("never shows the secret or the sign-in code in an error", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      ctx.google.exchangeAuthorizationCode.mockImplementationOnce(async () => {
        throw new Error(`boom: client_secret=${SECRET} code=${AUTH_CODE}`);
      });
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
      await settle();

      const attempt = ctx.service.getAttempt()!;
      expect(attempt.error?.code).toBe("unknown");
      expect(JSON.stringify(attempt)).not.toContain(SECRET);
      expect(JSON.stringify(attempt)).not.toContain(AUTH_CODE);
      expect(attempt.error?.details).toContain("[hidden]");
    });

    it("explains that Google gave no lasting access", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      ctx.google.exchangeAuthorizationCode.mockImplementationOnce(async name => ({
        isAuthenticated: false,
        profile: undefined,
        account: ctx.google.accounts[name]!,
      }));
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
      await settle();

      expect(ctx.service.getAttempt()?.error?.code).toBe("noRefreshToken");
    });

    it("gives up when Google never calls back", async () => {
      const ctx = setup({ timeoutMs: 20 });
      await withCredentials(ctx);
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(ctx.service.getAttempt()?.state).toBe("failed");
      expect(ctx.service.getAttempt()?.error?.code).toBe("timedOut");
      expect(ctx.google.cancelPendingAuthorizations).toHaveBeenCalled();
    });

    it("cancels a sign-in that is waiting and takes back the account", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      ctx.service.cancel();
      await settle();

      expect(ctx.service.getAttempt()?.state).toBe("cancelled");
      expect(ctx.configuration.global.google?.accounts).toBeUndefined();
      expect(ctx.google.cancelPendingAuthorizations).toHaveBeenCalledWith(EMAIL, expect.any(String));
    });

    it("keeps an account that was already there when a new sign-in fails", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      ctx.google.accounts[EMAIL] = { email: EMAIL, gmail: {}, calendar: {} };
      await ctx.service.startSignIn(EMAIL, DEFAULT_SERVICES);
      ctx.google.pending[0]!.reject(new Error("Google authorization failed: access_denied"));
      await settle();

      expect(ctx.service.getAttempt()?.error?.code).toBe("accessDenied");
      expect(ctx.google.getAvailableAccounts()).toEqual([EMAIL]);
    });
  });
  describe("choosing services", () => {
    it("links only what was chosen: Drive is not added behind the user's back", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      await ctx.service.startSignIn(EMAIL, ["gmail", "calendar"]);
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
      expect(ctx.google.beginAuthorization).toHaveBeenCalledWith(EMAIL, expect.any(String), { services: ["gmail", "calendar"] });
    });

    it("can link Drive alone, or Drive with the others, when it is ticked", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      await ctx.service.startSignIn(EMAIL, ["drive"]);
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, drive: {} });
      expect(ctx.google.beginAuthorization).toHaveBeenLastCalledWith(EMAIL, expect.any(String), { services: ["drive"] });

      await ctx.service.startSignIn("other@example.com", ["gmail", "calendar", "drive"]);
      expect(ctx.configuration.global.google?.accounts?.["other@example.com"]).toEqual({ email: "other@example.com", gmail: {}, calendar: {}, drive: {} });
    });

    it("refuses to connect with no service chosen, and starts nothing", async () => {
      const ctx = setup();
      await withCredentials(ctx);
      const result = await ctx.service.startSignIn(EMAIL, []);
      expect(result.status).toBe("invalid");
      expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
      expect(ctx.configuration.global.google?.accounts).toBeUndefined();
    });
  });

  describe("connected accounts", () => {
    async function connected(ctx: ReturnType<typeof setup>, services: ("gmail" | "calendar" | "drive")[] = ["gmail", "calendar"]) {
      await withCredentials(ctx);
      await ctx.service.startSignIn(EMAIL, services);
      ctx.google.pending[0]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
      await settle();
      expect(ctx.service.getAttempt()?.state).toBe("connected");
      ctx.google.beginAuthorization.mockClear();
    }

    it("lists each account with its services and whether it is signed in, and never a token", async () => {
      const ctx = setup();
      await connected(ctx);
      expect(ctx.service.listAccounts()).toEqual([{ name: EMAIL, email: EMAIL, gmail: true, calendar: true, drive: false, connected: true }]);
      expect(JSON.stringify(ctx.service.getSetup())).not.toContain(SECRET);
    });

    it("removing a service only changes the settings: no sign-in, nothing asked of Google", async () => {
      const ctx = setup();
      await connected(ctx, ["gmail", "calendar", "drive"]);
      const result = await ctx.service.updateServices(EMAIL, ["gmail", "calendar"]);

      expect(result.status).toBe("saved");
      expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
      if (result.status === "saved") {
        expect(result.accounts[0]).toMatchObject({ gmail: true, calendar: true, drive: false });
        expect(result.message).toContain("Files (Google Drive)");
        expect(result.message).toContain("myaccount.google.com/permissions");
      }
    });

    it("changing nothing says so and writes nothing", async () => {
      const ctx = setup();
      await connected(ctx);
      const before = structuredClone(ctx.configuration.global);
      const result = await ctx.service.updateServices(EMAIL, ["calendar", "gmail"]);
      expect(result).toMatchObject({ status: "saved", message: "Nothing changed." });
      expect(ctx.configuration.global).toEqual(before);
    });

    it("refuses to leave an account with no service", async () => {
      const ctx = setup();
      await connected(ctx);
      expect((await ctx.service.updateServices(EMAIL, [])).status).toBe("invalid");
      expect(ctx.google.getAccountServices(EMAIL)).toEqual(["gmail", "calendar"]);
    });

    it("adding a service asks Google for consent again, and links it only once Google agrees", async () => {
      const ctx = setup();
      await connected(ctx);
      const result = await ctx.service.updateServices(EMAIL, ["gmail", "calendar", "drive"]);

      expect(result.status).toBe("needsConsent");
      expect(ctx.google.beginAuthorization).toHaveBeenCalledWith(EMAIL, expect.any(String), { services: ["gmail", "calendar", "drive"] });
      // Not linked yet: the provider would have no permission to work with.
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });

      ctx.google.pending[1]!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
      await settle();
      expect(ctx.service.getAttempt()).toMatchObject({ state: "connected", services: ["gmail", "calendar", "drive"] });
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {}, drive: {} });
    });

    it("keeps the old services when the new consent fails, and shows the same failure", async () => {
      const ctx = setup();
      await connected(ctx);
      await ctx.service.updateServices(EMAIL, ["gmail", "calendar", "drive"]);
      ctx.google.pending[1]!.reject(new Error("Google authorization failed: access_denied"));
      await settle();

      expect(ctx.service.getAttempt()).toMatchObject({ state: "failed", error: { code: "accessDenied" } });
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
    });

    it("keeps the old services when the consent is cancelled", async () => {
      const ctx = setup();
      await connected(ctx);
      await ctx.service.updateServices(EMAIL, ["gmail", "calendar", "drive"]);
      ctx.service.cancel();
      await settle();
      expect(ctx.service.getAttempt()?.state).toBe("cancelled");
      expect(ctx.configuration.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
    });

    it("changes an account that is defined in the workspace settings, not just the global ones", async () => {
      const ctx = setup();
      await connected(ctx, ["gmail", "calendar", "drive"]);
      ctx.configuration.layers.workspace = { google: { accounts: { [EMAIL]: { email: EMAIL, drive: {} } } } };
      ctx.google.sync(ctx.configuration.layers);
      const result = await ctx.service.updateServices(EMAIL, ["gmail", "calendar"]);
      expect(result.status).toBe("saved");
      expect(ctx.configuration.layers.workspace.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
      expect(ctx.configuration.layers.global.google?.accounts?.[EMAIL]).toEqual({ email: EMAIL, gmail: {}, calendar: {} });
      expect(ctx.google.getAccountServices(EMAIL)).toEqual(["gmail", "calendar"]);
    });

    it("says so when a service is set where it cannot be changed", async () => {
      const ctx = setup();
      await connected(ctx, ["gmail", "calendar", "drive"]);
      // Pin Drive in a place the settings editor does not write: the merged account keeps it.
      const original = ctx.configuration.update.bind(ctx.configuration);
      ctx.configuration.update = async (scope, mutate) => {
        const result = await original(scope, mutate);
        ctx.google.accounts[EMAIL] = { ...ctx.google.accounts[EMAIL]!, drive: {} };
        return result;
      };
      const result = await ctx.service.updateServices(EMAIL, ["gmail", "calendar"]);
      expect(result.status).toBe("invalid");
    });

    it("rejects an account that is not connected", async () => {
      const ctx = setup();
      expect((await ctx.service.updateServices("nobody@example.com", ["gmail"])).status).toBe("invalid");
      expect((await ctx.service.disconnect("nobody@example.com")).status).toBe("invalid");
    });
  });

  describe("disconnecting", () => {
    async function twoAccounts(ctx: ReturnType<typeof setup>) {
      await withCredentials(ctx);
      for (const email of [EMAIL, "mark@example.com"]) {
        await ctx.service.startSignIn(email, ["gmail", "calendar"]);
        ctx.google.pending.at(-1)!.resolve(`http://127.0.0.1:14008/oauth/google/callback?code=${AUTH_CODE}`);
        await settle();
      }
    }

    it("removes the account from the settings, tells Google, and leaves the other account and the client credentials", async () => {
      const ctx = setup();
      await twoAccounts(ctx);
      const result = await ctx.service.disconnect(EMAIL);

      expect(result).toMatchObject({ status: "disconnected", revoke: "confirmed" });
      expect(result.message).toContain("Google confirmed");
      expect(ctx.google.disconnectAccount).toHaveBeenCalledWith(EMAIL);
      expect(Object.keys(ctx.configuration.global.google?.accounts ?? {})).toEqual(["mark@example.com"]);
      if (result.status === "disconnected") expect(result.accounts.map(account => account.name)).toEqual(["mark@example.com"]);
      expect(ctx.configuration.global.google?.clientId).toBeDefined();
      expect(ctx.configuration.global.google?.clientSecret).toBeDefined();
      expect(ctx.vault.entries.google?.["oauth-client.secret"]).toBe(SECRET);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it("still disconnects when Google did not confirm, and says so honestly", async () => {
      const ctx = setup();
      await twoAccounts(ctx);
      ctx.google.revokeOutcome = { result: "notConfirmed", message: "Google did not confirm that the access was taken back (it answered with status 400)." };
      const result = await ctx.service.disconnect(EMAIL);

      expect(result).toMatchObject({ status: "disconnected", revoke: "notConfirmed" });
      expect(result.message).toContain("is disconnected");
      expect(result.message).toContain("did not confirm");
      expect(result.message).not.toContain("Google confirmed");
      expect(ctx.google.getAvailableAccounts()).toEqual(["mark@example.com"]);
    });

    it("ends a sign-in that is waiting for that account", async () => {
      const ctx = setup();
      await twoAccounts(ctx);
      await ctx.service.updateServices(EMAIL, ["gmail", "calendar", "drive"]);
      expect(ctx.service.getAttempt()?.state).toBe("waiting");
      await ctx.service.disconnect(EMAIL);
      expect(ctx.service.getAttempt()?.state).toBe("cancelled");
      expect(ctx.google.cancelPendingAuthorizations).toHaveBeenCalledWith(EMAIL, expect.any(String));
    });

    it("does nothing while the vault is locked, because the saved sign-in could not be deleted", async () => {
      const ctx = setup();
      await twoAccounts(ctx);
      ctx.vault.writable = false;
      const result = await ctx.service.disconnect(EMAIL);
      expect(result.status).toBe("vaultLocked");
      expect(ctx.google.disconnectAccount).not.toHaveBeenCalled();
      expect(ctx.google.getAvailableAccounts()).toContain(EMAIL);
    });

    it("reports an account that could not be fully removed instead of claiming success", async () => {
      const ctx = setup();
      await twoAccounts(ctx);
      ctx.google.disconnectAccount.mockImplementationOnce(async () => {
        throw new Error(`Vault is uninitialized or locked ${SECRET}`);
      });
      const result = await ctx.service.disconnect(EMAIL);
      expect(result.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(ctx.google.getAvailableAccounts()).toContain(EMAIL);
    });
  });
});
