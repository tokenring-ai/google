import { randomUUID } from "node:crypto";
import type TokenRingApp from "@tokenring-ai/app";
import type { TokenRingService } from "@tokenring-ai/app/types";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import VaultService from "@tokenring-ai/vault/VaultService";
import { type Auth, type calendar_v3, type drive_v3, type gmail_v1, google, type oauth2_v2 } from "googleapis";
import type { z } from "zod";
import { type GoogleAccountSchema, type GoogleConfigSchema, GoogleStoredTokenSchema } from "./schema.ts";

type GoogleApiErrorResponse = {
  error?: {
    code?: number | undefined;
    message?: string | undefined;
    status?: string | undefined;
    errors?: Array<{
      domain?: string | undefined;
      message?: string | undefined;
      reason?: string | undefined;
    }>;
    details?: Array<{
      "@type"?: string | undefined;
      domain?: string | undefined;
      reason?: string | undefined;
      metadata?: Record<string, string> | undefined;
    }>;
  };
};

type GoogleOAuthCredentials = {
  access_token?: string;
  expiry_date?: number;
  refresh_token?: string;
  scope?: string;
};

type GoogleOAuthTokenUpdate = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
};

type GoogleRequestOptions = {
  context: string;
  method?: string;
  requiredScopes?: string[] | undefined;
  url?: string;
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
const DEFAULT_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];
const DEFAULT_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

export const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";

export default class GoogleService implements TokenRingService {
  readonly name = "GoogleService";
  description = "Google OAuth account and API access service";

  private readonly accounts = new KeyedRegistry<RuntimeGoogleAccount>();
  private readonly authData = new Map<string, StoredGoogleToken>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

  getAvailableAccounts = this.accounts.keysArray;
  requireAccount = this.accounts.require;

  private vaultService: VaultService | null = null;

  constructor(
    readonly app: TokenRingApp,
    readonly options: z.output<typeof GoogleConfigSchema>,
  ) {
    this.accounts.setAll(options.accounts);

    app.waitForService(VaultService, async vaultService => {
      this.vaultService = vaultService;

      for (const accountName of this.accounts.keysArray()) {
        try {
          const stored = this.vaultService.requireJsonItem(GOOGLE_VAULT_CATEGORY, accountName, GoogleStoredTokenSchema);
          this.authData.set(accountName, stored);

          await this.syncAccountProfile(accountName);
        } catch (err) {
          this.app.serviceError(
            this,
            `Couldn't load auth token for google account ${accountName} from the vault. Re-authenticate with /google account auth ${accountName} to re-authorize.`,
            err,
          );
        }
      }
    });
  }

  getAccountStatus(accountName: string) {
    const account = this.requireAccount(accountName);
    const auth = this.authData.get(accountName);

    return {
      isAuthenticated: Boolean(auth?.refreshToken && auth?.accessToken),
      profile: auth?.profile,
      account,
    };
  }

  requireAuthorizedAccount(accountName: string) {
    const authStatus = this.getAccountStatus(accountName);
    if (!authStatus.isAuthenticated) {
      throw new Error(`Google account ${accountName} is not authenticated. Please authenticate with /google account auth ${accountName}`);
    }
    return authStatus;
  }

  createAuthorizationUrl(
    accountName: string,
    redirectUri: string,
    options: {
      state?: string;
      scopes?: string[] | undefined;
      accessType?: "offline" | "online";
      prompt?: "consent" | "none" | "select_account";
      loginHint?: string;
    } = {},
  ): string {
    const account = this.requireAccount(accountName);
    const oauthClient = this.createOAuthClient(accountName, redirectUri);
    return oauthClient.generateAuthUrl(
      stripUndefinedKeys({
        access_type: options.accessType ?? "offline",
        prompt: options.prompt ?? "consent",
        scope: options.scopes ?? this.getDefaultScopes(account),
        state: options.state,
        login_hint: options.loginHint ?? account.email,
      }),
    );
  }

  beginAuthorization(
    accountName: string,
    redirectUri: string,
  ): {
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
      authorizationUrl: this.createAuthorizationUrl(accountName, redirectUri, {
        state,
      }),
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

  async exchangeAuthorizationCode(name: string, code: string, redirectUri: string) {
    const oauthClient = this.createOAuthClient(name, redirectUri);

    try {
      const { tokens } = await oauthClient.getToken(code);
      await this.storeOAuthCredentials(name, tokens);
      oauthClient.setCredentials(this.getOAuthCredentials(name));
    } catch (error: unknown) {
      throw this.createRequestFailure(`exchange Google auth code for ${name}`, error);
    }

    await this.syncAccountProfile(name);
    await this.tryStoreAuthDataInVault(name);
    return this.getAccountStatus(name);
  }

  async withGmail<T>(accountName: string, request: GoogleRequestOptions, operation: (gmail: gmail_v1.Gmail) => Promise<T>): Promise<T> {
    return await this.runGoogleRequest(accountName, request, async auth => await operation(google.gmail({ version: "v1", auth })));
  }

  async withCalendar<T>(accountName: string, request: GoogleRequestOptions, operation: (calendar: calendar_v3.Calendar) => Promise<T>): Promise<T> {
    return await this.runGoogleRequest(accountName, request, async auth => await operation(google.calendar({ version: "v3", auth })));
  }

  async withDrive<T>(accountName: string, request: GoogleRequestOptions, operation: (drive: drive_v3.Drive) => Promise<T>): Promise<T> {
    return await this.runGoogleRequest(accountName, request, async auth => await operation(google.drive({ version: "v3", auth })));
  }

  private async withOAuth2Api<T>(accountName: string, request: GoogleRequestOptions, operation: (oauth2: oauth2_v2.Oauth2) => Promise<T>): Promise<T> {
    return await this.runGoogleRequest(accountName, request, async auth => await operation(google.oauth2({ version: "v2", auth })));
  }

  private async runGoogleRequest<T>(accountName: string, request: GoogleRequestOptions, operation: (auth: Auth.OAuth2Client) => Promise<T>): Promise<T> {
    const auth = this.createOAuthClient(accountName);

    try {
      return await operation(auth);
    } catch (error: unknown) {
      throw this.normalizeGoogleRequestError(accountName, request, error);
    }
  }

  private createOAuthClient(accountName: string, redirectUri?: string): Auth.OAuth2Client {
    const oauthClient = new google.auth.OAuth2(this.options.clientId, this.options.clientSecret, redirectUri);
    oauthClient.setCredentials(this.getOAuthCredentials(accountName));
    oauthClient.on("tokens", tokens => {
      void this.storeOAuthCredentials(accountName, tokens);
    });
    return oauthClient;
  }

  private getOAuthCredentials(accountName: string): GoogleOAuthCredentials {
    const auth = this.authData.get(accountName);
    return stripUndefinedKeys({
      access_token: auth?.accessToken,
      expiry_date: auth?.expiryDate,
      refresh_token: auth?.refreshToken,
      scope: auth?.grantedScopes?.join(" "),
    });
  }

  private async storeOAuthCredentials(accountName: string, tokens: GoogleOAuthTokenUpdate) {
    const newAuth = { ...this.authData.get(accountName) };

    if (tokens.access_token) newAuth.accessToken = tokens.access_token;
    if (typeof tokens.expiry_date === "number") {
      newAuth.expiryDate = tokens.expiry_date;
    }
    if (tokens.refresh_token) newAuth.refreshToken = tokens.refresh_token;
    if (tokens.scope) {
      newAuth.grantedScopes = tokens.scope.split(/\s+/).filter(Boolean);
    }

    this.authData.set(accountName, newAuth);
    await this.tryStoreAuthDataInVault(accountName);
  }

  private async tryStoreAuthDataInVault(accountName: string) {
    if (!this.vaultService) return;
    const authData = this.authData.get(accountName);
    await this.vaultService.setJsonItem(GOOGLE_VAULT_CATEGORY, accountName, authData);
  }

  private getDefaultScopes(account: RuntimeGoogleAccount): string[] {
    const scopes = new Set<string>([GOOGLE_USERINFO_SCOPE]);

    if (account.email) {
      for (const scope of DEFAULT_GMAIL_SCOPES) scopes.add(scope);
    }
    if (account.calendar) {
      for (const scope of DEFAULT_CALENDAR_SCOPES) scopes.add(scope);
    }
    if (account.drive) {
      for (const scope of DEFAULT_DRIVE_SCOPES) scopes.add(scope);
    }

    return Array.from(scopes);
  }

  private createRequestFailure(context: string, error: unknown): Error {
    const message = error instanceof Error && error.message ? `${context} failed: ${error.message}` : `${context} failed`;
    const requestError = new Error(message);
    (requestError as Error & { cause?: unknown }).cause = error;
    return requestError;
  }

  private normalizeGoogleRequestError(accountName: string, request: GoogleRequestOptions, error: unknown): Error {
    const failure = this.extractGoogleRequestFailure(error);
    if (!failure) return this.createRequestFailure(request.context, error);

    return this.createGoogleApiError(
      accountName,
      request.url ?? failure.url ?? "",
      request.method ?? failure.method,
      request.context,
      failure.status,
      failure.details,
      request.requiredScopes,
    );
  }

  private extractGoogleRequestFailure(error: unknown):
    | {
        details: unknown;
        method?: string;
        status: number;
        url?: string;
      }
    | undefined {
    if (!error || typeof error !== "object") return undefined;

    const response =
      "response" in error && error.response && typeof error.response === "object"
        ? (error.response as {
            data?: unknown;
            status?: number;
          })
        : undefined;
    if (typeof response?.status !== "number") return undefined;

    const config =
      "config" in error && error.config && typeof error.config === "object" ? (error.config as { method?: string; url?: string | undefined }) : undefined;

    return stripUndefinedKeys({
      details: response.data,
      method: config?.method?.toUpperCase(),
      status: response.status,
      url: config?.url,
    });
  }

  private createGoogleApiError(
    accountName: string,
    url: string,
    method: string | undefined,
    context: string,
    status: number,
    details: unknown,
    requiredScopes?: string[],
  ): Error {
    const googleMessage = this.getGoogleApiErrorMessage(details);
    const missingScopes = this.getMissingGrantedScopes(accountName, url, method, requiredScopes);

    let message = `${context} failed (${status})`;
    if (status === 403 && (this.isInsufficientScopeError(details) || missingScopes.length > 0)) {
      const scopeMessage = missingScopes.length ? ` Missing scope${missingScopes.length === 1 ? "" : "s"}: ${missingScopes.join(", ")}.` : "";
      message = `${context} failed (${status}): Google account "${accountName}" is authenticated, but it is missing permission for this request.${scopeMessage} Re-run /google account auth ${accountName} to grant access.`;
    } else if (googleMessage) {
      message = `${context} failed (${status}): ${googleMessage}`;
    }

    const requestError = new Error(message);
    (requestError as Error & { details?: unknown }).details = details;
    return requestError;
  }

  private getGoogleApiErrorMessage(details: unknown): string | undefined {
    if (!details || typeof details !== "object") {
      return typeof details === "string" ? details : undefined;
    }
    const googleError = (details as GoogleApiErrorResponse).error;
    if (!googleError) return undefined;
    if (googleError.message) return googleError.message;
    return googleError.errors?.find(entry => entry.message)?.message;
  }

  private isInsufficientScopeError(details: unknown): boolean {
    if (!details || typeof details !== "object") return false;
    const googleError = (details as GoogleApiErrorResponse).error;
    if (!googleError) return false;
    if (googleError.status === "PERMISSION_DENIED" && googleError.message?.toLowerCase().includes("scope")) {
      return true;
    }

    return [...(googleError.errors ?? []).map(entry => entry.reason), ...(googleError.details ?? []).map(entry => entry.reason)].some(
      reason => reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    );
  }

  private getMissingGrantedScopes(accountName: string, url: string, method?: string, requiredScopes?: string[]): string[] {
    const grantedScopes = new Set(this.authData.get(accountName)?.grantedScopes ?? []);

    if (grantedScopes.size === 0) return [];

    const neededScopes = requiredScopes ?? this.getRequiredScopesForRequest(url, method);
    return neededScopes.filter(scope => !grantedScopes.has(scope));
  }

  private getRequiredScopesForRequest(url: string, method?: string): string[] {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }

    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.startsWith("/calendar/")) {
      return DEFAULT_CALENDAR_SCOPES;
    }
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.startsWith("/drive/")) {
      return DEFAULT_DRIVE_SCOPES;
    }
    if (parsed.hostname !== "gmail.googleapis.com") {
      return [];
    }

    const normalizedMethod = (method ?? "GET").toUpperCase();
    if (normalizedMethod === "GET") {
      return ["https://www.googleapis.com/auth/gmail.readonly"];
    }
    if (parsed.pathname.endsWith("/drafts/send")) {
      return ["https://www.googleapis.com/auth/gmail.send"];
    }
    return ["https://www.googleapis.com/auth/gmail.compose"];
  }

  private async syncAccountProfile(accountName: string): Promise<void> {
    void this.requireAccount(accountName);
    const authData = this.authData.get(accountName);
    if (authData?.profile) return;

    const profile = await this.withOAuth2Api(
      accountName,
      {
        context: `fetch Google profile for ${accountName}`,
        requiredScopes: [GOOGLE_USERINFO_SCOPE],
      },
      async oauth2 => {
        const { data } = await oauth2.userinfo.get();
        return data;
      },
    );
    console.log(`Fetched profile for ${accountName}:`, profile);

    this.authData.set(accountName, {
      ...this.authData.get(accountName),
      profile,
    });
  }
}
