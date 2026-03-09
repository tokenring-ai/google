import {TokenRingService} from "@tokenring-ai/app/types";
import {doFetchWithRetry} from "@tokenring-ai/utility/http/doFetchWithRetry";
import {z} from "zod";
import {GoogleAccountSchema, GoogleConfigSchema} from "./schema.ts";

type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type RuntimeGoogleAccount = z.output<typeof GoogleAccountSchema>;

export default class GoogleService implements TokenRingService {
  readonly name = "GoogleService";
  description = "Google OAuth account and API access service";

  private readonly accounts = new Map<string, RuntimeGoogleAccount>();
  private readonly defaultAccount?: string;

  constructor(readonly options: z.output<typeof GoogleConfigSchema>) {
    this.defaultAccount = options.defaultAccount;
    for (const [name, account] of Object.entries(options.accounts)) {
      this.accounts.set(name, {...account});
    }
  }

  getAvailableAccounts(): string[] {
    return [...this.accounts.keys()];
  }

  getDefaultAccountName(): string | undefined {
    return this.defaultAccount;
  }

  getAccount(name?: string): RuntimeGoogleAccount {
    const accountName = name ?? this.defaultAccount;
    if (!accountName) throw new Error("No Google account specified and no default account configured");
    const account = this.accounts.get(accountName);
    if (!account) throw new Error(`Google account "${accountName}" is not configured`);
    return account;
  }

  getUserEmail(name?: string): string {
    return this.getAccount(name).userEmail;
  }

  createAuthorizationUrl(
    name?: string,
    options: {
      state?: string;
      scopes?: string[];
      accessType?: "offline" | "online";
      prompt?: "consent" | "none" | "select_account";
      loginHint?: string;
    } = {},
  ): string {
    const account = this.getAccount(name);
    const params = new URLSearchParams({
      client_id: account.clientId,
      redirect_uri: account.redirectUri,
      response_type: "code",
      scope: (options.scopes ?? account.scopes).join(" "),
      access_type: options.accessType ?? "offline",
      prompt: options.prompt ?? "consent",
    });

    if (options.state) params.set("state", options.state);
    if (options.loginHint ?? account.userEmail) params.set("login_hint", options.loginHint ?? account.userEmail);

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeAuthorizationCode(name: string, code: string): Promise<RuntimeGoogleAccount> {
    const account = this.getAccount(name);
    const body = new URLSearchParams({
      code,
      client_id: account.clientId,
      client_secret: account.clientSecret,
      redirect_uri: account.redirectUri,
      grant_type: "authorization_code",
    });

    const tokens = await this.fetchTokenResponse(body, `exchange Google auth code for ${name}`);
    this.storeTokenResponse(name, tokens);
    return this.getAccount(name);
  }

  async refreshAccessToken(name?: string): Promise<string> {
    const accountName = name ?? this.defaultAccount;
    if (!accountName) throw new Error("No Google account specified and no default account configured");

    const account = this.getAccount(accountName);
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
    return this.getAccount(accountName).accessToken!;
  }

  async getAccessToken(name?: string): Promise<string> {
    const accountName = name ?? this.defaultAccount;
    if (!accountName) throw new Error("No Google account specified and no default account configured");

    const account = this.getAccount(accountName);
    const now = Date.now();
    const hasValidAccessToken = !!account.accessToken && (!account.expiryDate || account.expiryDate > now + 30_000);
    if (hasValidAccessToken) return account.accessToken!;
    return await this.refreshAccessToken(accountName);
  }

  async fetchGoogleJson<T>(name: string | undefined, url: string, init: RequestInit, context: string): Promise<T> {
    const res = await this.fetchGoogleRaw(name, url, init, context);
    const text = await res.text().catch(() => "");
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }

    return json as T;
  }

  async fetchGoogleRaw(name: string | undefined, url: string, init: RequestInit, context: string): Promise<Response> {
    const accessToken = await this.getAccessToken(name);
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

  private storeTokenResponse(name: string, tokens: GoogleTokenResponse): void {
    const account = this.getAccount(name);
    account.accessToken = tokens.access_token;
    if (typeof tokens.expires_in === "number") {
      account.expiryDate = Date.now() + (tokens.expires_in * 1000);
    }
    if (tokens.refresh_token) {
      account.refreshToken = tokens.refresh_token;
    }
    this.accounts.set(name, account);
  }
}
