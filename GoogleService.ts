import { randomUUID } from "node:crypto";
import type TokenRingApp from "@tokenring-ai/app";
import type { TokenRingService } from "@tokenring-ai/app/types";
import { ConfigurationError } from "@tokenring-ai/app/types";
import { CalendarService } from "@tokenring-ai/calendar";
import { EmailService } from "@tokenring-ai/email";
import { RemoteStoreService } from "@tokenring-ai/filesystem";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import VaultService from "@tokenring-ai/vault/VaultService";
import { deepEquals } from "bun";
import { type calendar_v3, type drive_v3, type gmail_v1, google, type oauth2_v2 } from "googleapis";
import type { z } from "zod";
import GmailEmailProvider from "./GmailEmailProvider.ts";
import GoogleCalendarProvider from "./GoogleCalendarProvider.ts";
import type { GoogleRevoke, GoogleService as GoogleServiceName } from "./rpc/schema.ts";
import { type GoogleAccountSchema, GoogleStoredTokenSchema, type ResolvedGoogleConfig } from "./schema.ts";
import { GOOGLE_SERVICE_SCOPES, GOOGLE_USERINFO_SCOPE, scopesForServices } from "./scopes.ts";

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
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REVOKE_TIMEOUT_MS = 10_000;
const DEFAULT_CALENDAR_SCOPES = [...GOOGLE_SERVICE_SCOPES.calendar];
const DEFAULT_DRIVE_SCOPES = [...GOOGLE_SERVICE_SCOPES.drive];

/** What happened when Google was asked to take back an account's access. */
export type GoogleRevokeOutcome = { result: GoogleRevoke; message: string };

export const GOOGLE_OAUTH_CALLBACK_PATH = "/oauth/google/callback";

export default class GoogleService implements TokenRingService {
  readonly name = "GoogleService";
  description = "Google OAuth account and API access service";

  private readonly accounts = new KeyedRegistry<RuntimeGoogleAccount>();
  getAvailableAccounts = this.accounts.keysArray;

  /** Accounts with Drive configured: the mounts of the googledrive:// remote store. */
  getDriveAccounts(): { name: string; drive: NonNullable<RuntimeGoogleAccount["drive"]> }[] {
    return this.accounts.entriesArray().flatMap(([name, account]) => (account.drive ? [{ name, drive: account.drive }] : []));
  }
  requireAccount = this.accounts.require;
  private readonly authData = new Map<string, StoredGoogleToken>();
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();
  private vaultService: VaultService | null = null;
  private options: ResolvedGoogleConfig = { accounts: {}, agentDefaults: {} };

  constructor(readonly app: TokenRingApp) {
    app.waitForService(VaultService, async vaultService => {
      this.vaultService = vaultService;

      for (const accountName of this.accounts.keysArray()) {
        await this.loadAccountAuth(accountName);
      }
    });
  }

  reconfigure(options: ResolvedGoogleConfig): void {
    this.options = options;

    // `reconcileAgainst` invokes `creating` before the account is stored, so
    // `requireAccount` inside auth loading would fail if started from there.
    const added: string[] = [];
    this.accounts.reconcileAgainst(options.accounts, {
      creating: (name, account) => {
        this.registerAccountProviders(name, account);
        added.push(name);
        return account;
      },
      deleting: name => {
        this.unregisterAccountProviders(name);
        this.authData.delete(name);
      },
      updating: (name, existing, account) => {
        if (deepEquals(existing, account, true)) return existing;

        this.unregisterAccountProviders(name);
        this.registerAccountProviders(name, account);
        return account;
      },
    });

    for (const name of added) void this.loadAccountAuth(name);
    this.app.getService(RemoteStoreService)?.mountsChanged();
  }

  getAccountStatus(accountName: string) {
    const account = this.requireAccount(accountName);
    const auth = this.authData.get(accountName);

    return {
      // Offline-access grants only require a refresh token; access tokens expire ~hourly.
      isAuthenticated: Boolean(auth?.refreshToken),
      profile: auth?.profile,
      account,
    };
  }

  /** Whether both the OAuth client ID and client secret have a value (from the vault, the environment, or settings). */
  hasClientCredentials(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  /** Replaces the client secret, and every stored token, in `text` so it can be shown or logged. */
  redactSecrets(text: string): string {
    const secrets = [this.options.clientSecret];
    for (const auth of this.authData.values()) secrets.push(auth.refreshToken, auth.accessToken);
    let result = text;
    for (const secret of secrets) {
      if (secret && secret.length >= 4) result = result.split(secret).join("[hidden]");
    }
    return result;
  }

  /** Ends the sign-in that is waiting for Google's callback for `accountName`, if there is one. */
  cancelPendingAuthorizations(accountName: string, reason: string): void {
    for (const pending of this.pendingAuthorizations.values()) {
      if (pending.accountName === accountName) pending.reject(new Error(reason));
    }
  }

  /**
   * Takes an account's access away from TokenRing: ends a sign-in that is waiting, asks Google to revoke the
   * grant (best effort: a failure is reported, never thrown), deletes the vault entry, and forgets the tokens
   * and the account's Email, Calendar and Drive providers. The account's entry in the settings is the caller's
   * to remove. The OAuth client ID and secret are shared by every account and are left alone.
   */
  async disconnectAccount(accountName: string): Promise<GoogleRevokeOutcome> {
    this.requireAccount(accountName);
    this.disconnects.set(accountName, this.disconnectCount(accountName) + 1);
    this.cancelPendingAuthorizations(accountName, "The account was disconnected.");

    const auth = this.authData.get(accountName);
    const revoke = await this.revokeAtGoogle(auth?.refreshToken ?? auth?.accessToken);

    this.unregisterAccountProviders(accountName);
    this.authData.delete(accountName);
    if (this.vaultService && this.vaultService.getItemsByCategory(GOOGLE_VAULT_CATEGORY)[accountName] !== undefined) {
      await this.vaultService.deleteItem(GOOGLE_VAULT_CATEGORY, accountName);
    }
    this.app.getService(RemoteStoreService)?.mountsChanged();
    return revoke;
  }

  private async revokeAtGoogle(token: string | undefined): Promise<GoogleRevokeOutcome> {
    if (!token) return { result: "nothingToRevoke", message: "There was no saved access to take back at Google." };
    const notConfirmed = (why: string): GoogleRevokeOutcome => ({
      result: "notConfirmed",
      message: `Google did not confirm that the access was taken back (${why}). To be sure, remove TokenRing at myaccount.google.com/permissions.`,
    });
    try {
      const response = await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (response.ok) return { result: "confirmed", message: "Google confirmed that the access was taken back." };
      return notConfirmed(`it answered with status ${response.status}`);
    } catch (error) {
      return notConfirmed(this.redactSecrets(Error.isError(error) ? error.message : "could not reach Google"));
    }
  }

  requireAuthorizedAccount(accountName: string) {
    const authStatus = this.getAccountStatus(accountName);
    if (!authStatus.isAuthenticated) {
      throw new ConfigurationError(
        this.name,
        `Google account ${accountName} is not authenticated. Please authenticate with /google account auth ${accountName}`,
      );
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

  /** The Google services this account is set up to use. */
  getAccountServices(accountName: string): GoogleServiceName[] {
    const account = this.requireAccount(accountName);
    return [
      ...(account.gmail ? (["gmail"] as const) : []),
      ...(account.calendar ? (["calendar"] as const) : []),
      ...(account.drive ? (["drive"] as const) : []),
    ];
  }

  /**
   * Starts a sign-in for `accountName`. It asks Google for the permissions of the account's configured
   * services, or, when `services` is given, of exactly those (to add a service before it is saved).
   */
  beginAuthorization(
    accountName: string,
    redirectUri: string,
    options: { services?: readonly GoogleServiceName[] } = {},
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
        ...(options.services && { scopes: scopesForServices(options.services) }),
      }),
      waitForCallback,
    };
  }

  completePendingAuthorization(callbackUrl: string): void {
    const callback = new URL(callbackUrl);
    const state = callback.searchParams.get("state");
    if (!state) {
      throw new ConfigurationError(this.name, "The Google OAuth callback is missing its state parameter.");
    }

    const pending = this.pendingAuthorizations.get(state);
    if (!pending) {
      throw new ConfigurationError(this.name, "No pending Google authorization was found for this callback.");
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
    const started = this.disconnectCount(name);

    let tokens: GoogleOAuthTokenUpdate;
    try {
      ({ tokens } = await oauthClient.getToken(code));
    } catch (error: unknown) {
      throw this.createRequestFailure(`exchange Google auth code for ${name}`, error);
    }
    // A disconnect that ran while Google was answering must not be undone by tokens arriving afterwards.
    await this.abandonIfDisconnected(name, started, tokens.refresh_token ?? tokens.access_token ?? undefined);

    try {
      await this.storeOAuthCredentials(name, tokens);
      oauthClient.setCredentials(this.getOAuthCredentials(name));
    } catch (error: unknown) {
      throw this.createRequestFailure(`exchange Google auth code for ${name}`, error);
    }

    await this.syncAccountProfile(name);
    await this.tryStoreAuthDataInVault(name);
    await this.abandonIfDisconnected(name, started, tokens.refresh_token ?? tokens.access_token ?? undefined);
    return this.getAccountStatus(name);
  }

  /** How many times the account has been disconnected; a sign-in compares it before and after its awaits. */
  private disconnects = new Map<string, number>();

  private disconnectCount(name: string): number {
    return this.disconnects.get(name) ?? 0;
  }

  /** If the account was disconnected since `started`, throws away whatever was saved, takes the new grant back, and fails. */
  private async abandonIfDisconnected(name: string, started: number, token: string | undefined): Promise<void> {
    if (this.disconnectCount(name) === started) return;
    this.authData.delete(name);
    if (this.vaultService && this.vaultService.getItemsByCategory(GOOGLE_VAULT_CATEGORY)[name] !== undefined) {
      await this.vaultService.deleteItem(GOOGLE_VAULT_CATEGORY, name);
    }
    await this.revokeAtGoogle(token);
    throw new Error(`${name} was disconnected while signing in, so nothing was saved.`);
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

  private registerAccountProviders(name: string, account: RuntimeGoogleAccount): void {
    if (account.gmail) {
      const emailService = this.app.getService(EmailService);
      emailService?.registerEmailProvider(name, new GmailEmailProvider({ description: account.gmail.description, account: name }, this));
    }

    if (account.calendar) {
      const calendarService = this.app.getService(CalendarService);
      calendarService?.registerCalendarProvider(
        name,
        new GoogleCalendarProvider(
          {
            description: account.calendar.description,
            account: name,
            calendarId: account.calendar.calendarId,
          },
          this,
        ),
      );
    }
  }

  private unregisterAccountProviders(name: string): void {
    this.app.getService(EmailService)?.unregisterEmailProvider(name);
    this.app.getService(CalendarService)?.unregisterCalendarProvider(name);
  }

  private async loadAccountAuth(accountName: string): Promise<void> {
    if (!this.vaultService) return;

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

  private async withOAuth2Api<T>(accountName: string, request: GoogleRequestOptions, operation: (oauth2: oauth2_v2.Oauth2) => Promise<T>): Promise<T> {
    return await this.runGoogleRequest(accountName, request, async auth => await operation(google.oauth2({ version: "v2", auth })));
  }

  private async runGoogleRequest<T>(
    accountName: string,
    request: GoogleRequestOptions,
    operation: (auth: ReturnType<typeof this.createOAuthClient>) => Promise<T>,
  ): Promise<T> {
    const auth = this.createOAuthClient(accountName);

    try {
      return await operation(auth);
    } catch (error: unknown) {
      throw this.normalizeGoogleRequestError(accountName, request, error);
    }
  }

  private createOAuthClient(accountName: string, redirectUri?: string) {
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

    // Explicit undefined checks so null revocations clear stored values.
    if (tokens.access_token !== undefined) {
      if (tokens.access_token) newAuth.accessToken = tokens.access_token;
      else delete newAuth.accessToken;
    }
    if (tokens.expiry_date !== undefined) {
      if (typeof tokens.expiry_date === "number") newAuth.expiryDate = tokens.expiry_date;
      else delete newAuth.expiryDate;
    }
    if (tokens.refresh_token !== undefined) {
      if (tokens.refresh_token) newAuth.refreshToken = tokens.refresh_token;
      else delete newAuth.refreshToken;
    }
    if (tokens.scope !== undefined) {
      newAuth.grantedScopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
    }

    this.authData.set(accountName, newAuth);
    await this.tryStoreAuthDataInVault(accountName);
  }

  private async tryStoreAuthDataInVault(accountName: string) {
    if (!this.vaultService) return;
    const authData = this.authData.get(accountName);
    await this.vaultService.setJsonItem(GOOGLE_VAULT_CATEGORY, accountName, authData);
  }

  /** Exactly the permissions of the services the account has; nothing for a service it does not use. */
  private getDefaultScopes(account: RuntimeGoogleAccount): string[] {
    return scopesForServices([
      ...(account.gmail ? (["gmail"] as const) : []),
      ...(account.calendar ? (["calendar"] as const) : []),
      ...(account.drive ? (["drive"] as const) : []),
    ]);
  }

  private createRequestFailure(context: string, error: unknown): Error {
    const message = Error.isError(error) && error.message ? `${context} failed: ${error.message}` : `${context} failed`;
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
    try {
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

      this.authData.set(accountName, {
        ...this.authData.get(accountName),
        profile,
      });
    } catch (error) {
      this.app.serviceError(this, `Failed to sync profile for ${accountName}`, error);
    }
  }
}
