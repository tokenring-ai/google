import Agent from "@tokenring-ai/agent/Agent";
import {TokenRingService} from "@tokenring-ai/app/types";
import {doFetchWithRetry} from "@tokenring-ai/utility/http/doFetchWithRetry";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import VaultService from "../vault/VaultService.ts";
import {GoogleAccountSchema, GoogleConfigSchema, GoogleStoredTokenSchema} from "./schema.ts";

type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type GoogleUserInfoResponse = {
  email?: string;
};

type RuntimeGoogleAccount = z.output<typeof GoogleAccountSchema>;
type StoredGoogleToken = z.output<typeof GoogleStoredTokenSchema>;
type PendingAuthorization = {
  accountName: string;
  redirectUri: string;
  resolve: (callbackUrl: string) => void;
  reject: (error: Error) => void;
};

const GOOGLE_VAULT_CATEGORY = "google";
const GOOGLE_USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const DEFAULT_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];
const DEFAULT_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
];
const DEFAULT_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
];

export const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";

export default class GoogleService implements TokenRingService {
  readonly name = "GoogleService";
  description = "Google OAuth account and API access service";

  private readonly accounts = new KeyedRegistry<RuntimeGoogleAccount>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

  requireAccount = this.accounts.requireItemByName;
  private vaultService?: VaultService;

  constructor(readonly options: z.output<typeof GoogleConfigSchema>, vaultService?: VaultService) {
    this.accounts.registerAll(options.accounts);
    this.vaultService = vaultService;
  }

  setVaultService(vaultService: VaultService): void {
    this.vaultService = vaultService;
  }

  getAvailableAccounts(): string[] {
    return this.accounts.getAllItemNames();
  }

  async requireVault(agent: Agent): Promise<VaultService> {
    if (!this.vaultService) {
      throw new Error("Google auth requires VaultService so tokens can be stored securely.");
    }
    await this.vaultService.unlock(agent);
    return this.vaultService;
  }

  getUserEmail(accountName: string): string | undefined {
    return this.requireAccount(accountName).userEmail;
  }

  async requireUserEmail(accountName: string): Promise<string> {
    await this.loadStoredTokens(accountName);
    const userEmail = this.requireAccount(accountName).userEmail;
    if (userEmail) return userEmail;
    return await this.syncAccountProfile(accountName);
  }

  async isAccountAuthenticated(accountName: string): Promise<boolean> {
    await this.loadStoredTokens(accountName);
    const account = this.requireAccount(accountName);
    return !!account.refreshToken || !!account.accessToken;
  }

  createAuthorizationUrl(
    accountName: string,
    redirectUri: string,
    options: {
      state?: string;
      scopes?: string[];
      accessType?: "offline" | "online";
      prompt?: "consent" | "none" | "select_account";
      loginHint?: string;
    } = {},
  ): string {
    const account = this.requireAccount(accountName);
    const params = new URLSearchParams({
      client_id: account.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: (options.scopes ?? this.getDefaultScopes(account)).join(" "),
      access_type: options.accessType ?? "offline",
      prompt: options.prompt ?? "consent",
    });

    if (options.state) params.set("state", options.state);
    const loginHint = options.loginHint ?? account.userEmail;
    if (loginHint) params.set("login_hint", loginHint);

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  beginAuthorization(accountName: string, redirectUri: string): {
    authorizationUrl: string;
    waitForCallback: Promise<string>;
  } {
    this.requireAccount(accountName);

    const state = randomUUID();
    const waitForCallback = new Promise<string>((resolve, reject) => {
      const complete = (callback: () => void) => {
        this.pendingAuthorizations.delete(state);
        callback();
      };

      this.pendingAuthorizations.set(state, {
        accountName,
        redirectUri,
        resolve: callbackUrl => complete(() => resolve(callbackUrl)),
        reject: error => complete(() => reject(error)),
      });
    });

    return {
      authorizationUrl: this.createAuthorizationUrl(accountName, redirectUri, {state}),
      waitForCallback,
    };
  }

  completePendingAuthorization(callbackUrl: string): void {
    const callback = new URL(callbackUrl);
    const state = callback.searchParams.get("state");
    if (!state) {
      throw new Error("The Google OAuth callback is missing its state parameter.");
    }

    const pending = this.pendingAuthorizations.get(state);
    if (!pending) {
      throw new Error("No pending Google authorization was found for this callback.");
    }

    if (`${callback.origin}${callback.pathname}` !== pending.redirectUri) {
      pending.reject(new Error("The Google OAuth callback redirect URI did not match the pending authorization request."));
      return;
    }

    const authError = callback.searchParams.get("error");
    if (authError) {
      pending.reject(new Error(`Google authorization failed: ${authError}`));
      return;
    }

    if (!callback.searchParams.get("code")) {
      pending.reject(new Error("The Google OAuth callback did not include an authorization code."));
      return;
    }

    pending.resolve(callbackUrl);
  }

  async exchangeAuthorizationCode(name: string, code: string, redirectUri: string): Promise<RuntimeGoogleAccount> {
    const account = this.requireAccount(name);
    const body = new URLSearchParams({
      code,
      client_id: account.clientId,
      client_secret: account.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const tokens = await this.fetchTokenResponse(body, `exchange Google auth code for ${name}`);
    this.storeTokenResponse(name, tokens);
    await this.syncAccountProfile(name);
    await this.persistAccountTokens(name, true);
    return this.requireAccount(name);
  }

  async refreshAccessToken(accountName: string): Promise<string> {
    await this.loadStoredTokens(accountName);
    const account = this.requireAccount(accountName);
    if (!account.refreshToken) {
      throw new Error(`Google account "${accountName}" does not have a refresh token configured`);
    }

    const body = new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    });

    const tokens = await this.fetchTokenResponse(body, `refresh Google access token for ${accountName}`);
    this.storeTokenResponse(accountName, tokens);
    await this.persistAccountTokens(accountName, false);
    return this.requireAccount(accountName).accessToken!;
  }

  async getAccessToken(accountName: string): Promise<string> {
    await this.loadStoredTokens(accountName);
    const account = this.requireAccount(accountName);
    const now = Date.now();
    const hasValidAccessToken = !!account.accessToken && (!account.expiryDate || account.expiryDate > now + 30_000);
    if (hasValidAccessToken) return account.accessToken!;
    return await this.refreshAccessToken(accountName);
  }

  async fetchGoogleJson<T>(accountName: string, url: string, init: RequestInit, context: string): Promise<T> {
    const res = await this.fetchGoogleRaw(accountName, url, init, context);
    const text = await res.text().catch(() => "");
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }

    return json as T;
  }

  async fetchGoogleRaw(accountName: string, url: string, init: RequestInit, context: string): Promise<Response> {
    const accessToken = await this.getAccessToken(accountName);
    const res = await doFetchWithRetry(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      if (res.status === 401) {
        await this.refreshAccessToken(accountName);
        return this.fetchGoogleRawWithFreshToken(accountName, url, init, context);
      }
      const text = await res.text().catch(() => "");
      let json: unknown = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = text;
      }
      const error = new Error(`${context} failed (${res.status})`);
      (error as Error & {details?: unknown}).details = json;
      throw error;
    }
    return res;
  }

  private async fetchGoogleRawWithFreshToken(accountName: string, url: string, init: RequestInit, context: string): Promise<Response> {
    const accessToken = await this.getAccessToken(accountName);
    const res = await doFetchWithRetry(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let json: unknown = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = text;
      }
      const error = new Error(`${context} failed (${res.status})`);
      (error as Error & {details?: unknown}).details = json;
      throw error;
    }

    return res;
  }

  private async fetchTokenResponse(body: URLSearchParams, context: string): Promise<GoogleTokenResponse> {
    const res = await doFetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await res.text().catch(() => "");
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }

    if (!res.ok) {
      const error = new Error(`${context} failed (${res.status})`);
      (error as Error & {details?: unknown}).details = json;
      throw error;
    }

    return json as GoogleTokenResponse;
  }

  private storeTokenResponse(accountName: string, tokens: GoogleTokenResponse): void {
    const account = this.requireAccount(accountName);
    account.accessToken = tokens.access_token;
    if (typeof tokens.expires_in === "number") {
      account.expiryDate = Date.now() + (tokens.expires_in * 1000);
    }
    if (tokens.refresh_token) {
      account.refreshToken = tokens.refresh_token;
    }
  }

  private getDefaultScopes(account: RuntimeGoogleAccount): string[] {
    const scopes = new Set<string>([GOOGLE_USERINFO_SCOPE]);

    if (account.scopes?.length) {
      for (const scope of account.scopes) scopes.add(scope);
      return Array.from(scopes);
    }

    if (account.email) {
      for (const scope of DEFAULT_GMAIL_SCOPES) scopes.add(scope);
    }
    if (account.calendar) {
      for (const scope of DEFAULT_CALENDAR_SCOPES) scopes.add(scope);
    }
    if (account.drive) {
      for (const scope of DEFAULT_DRIVE_SCOPES) scopes.add(scope);
    }

    if (scopes.size === 1) {
      for (const scope of [...DEFAULT_GMAIL_SCOPES, ...DEFAULT_CALENDAR_SCOPES]) scopes.add(scope);
    }

    return Array.from(scopes);
  }

  private getStoredTokenPayload(accountName: string): StoredGoogleToken {
    const account = this.requireAccount(accountName);
    return GoogleStoredTokenSchema.parse({
      userEmail: account.userEmail,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      expiryDate: account.expiryDate,
    });
  }

  private applyStoredTokenPayload(accountName: string, tokens: StoredGoogleToken): void {
    const account = this.requireAccount(accountName);
    account.userEmail = tokens.userEmail;
    account.refreshToken = tokens.refreshToken;
    account.accessToken = tokens.accessToken;
    account.expiryDate = tokens.expiryDate;
  }

  private async syncAccountProfile(accountName: string): Promise<string> {
    const account = this.requireAccount(accountName);
    if (account.userEmail) return account.userEmail;

    const profile = await this.fetchGoogleJson<GoogleUserInfoResponse>(
      accountName,
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {method: "GET"},
      `fetch Google profile for ${accountName}`,
    );

    if (!profile.email) {
      throw new Error(`Google did not return an email address for account "${accountName}"`);
    }

    account.userEmail = profile.email;
    await this.persistAccountTokens(accountName, false);
    return account.userEmail;
  }

  private async loadStoredTokens(accountName: string): Promise<void> {
    if (!this.vaultService) return;
    const stored = await this.vaultService.getJsonItem<StoredGoogleToken>(GOOGLE_VAULT_CATEGORY, accountName).catch(() => undefined);
    if (!stored) return;
    this.applyStoredTokenPayload(accountName, GoogleStoredTokenSchema.parse(stored));
  }

  private async persistAccountTokens(accountName: string, required: boolean): Promise<void> {
    if (!this.vaultService) {
      if (required) {
        throw new Error("Google auth requires VaultService so tokens can be stored securely.");
      }
      return;
    }

    const payload = this.getStoredTokenPayload(accountName);
    try {
      await this.vaultService.setJsonItem(GOOGLE_VAULT_CATEGORY, accountName, payload);
    } catch (error) {
      if (required) throw error;
    }
  }
}
