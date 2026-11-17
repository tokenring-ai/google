import { randomUUID } from "node:crypto";
import type TokenRingApp from "@tokenring-ai/app";
import { ConfigurationService } from "@tokenring-ai/app";
import { type ConfigScope, configScopes } from "@tokenring-ai/app/config/scopes";
import type { TokenRingService } from "@tokenring-ai/app/types";
import SecretService from "@tokenring-ai/secrets/SecretService";
import { fromVault, type SecretRef } from "@tokenring-ai/secrets/secret";
import { saveToVaultThen } from "@tokenring-ai/secrets/vaultCredentials";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import { z } from "zod";
import { describeGoogleConnectError } from "./connectErrors.ts";
import GoogleService, { GOOGLE_OAUTH_CALLBACK_PATH } from "./GoogleService.ts";
import type {
  GoogleAccountSummary,
  GoogleConnectAttempt,
  GoogleConnectErrorCode,
  GoogleRevoke,
  GoogleService as GoogleServiceName,
  GoogleSetup,
} from "./rpc/schema.ts";

/**
 * What the "Connect Google" wizard needs from the server. All sign-in work is done by {@link GoogleService}
 * (the same authorization URL, callback and token exchange as `/connect google`); this class only drives it
 * from a web session and keeps the state of the attempt so the browser can poll it.
 *
 * The OAuth client ID and secret are saved to the vault (category `google`) and only references to them are
 * written to the settings. Nothing here returns, logs, or keeps the secret beyond the call that saves it.
 */

const VAULT_CATEGORY = "google";
const CLIENT_ID_REF = fromVault(VAULT_CATEGORY, "oauth-client.id");
const CLIENT_SECRET_REF = fromVault(VAULT_CATEGORY, "oauth-client.secret");

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export const VAULT_LOCKED_HELP = "Your keys are locked. Unlock them (the vault, an encrypted file on this computer), then try again.";

type CredentialSource = GoogleSetup["clientIdSource"];
type SaveResult = { status: "success"; setup: GoogleSetup } | { status: "vaultLocked"; message: string } | { status: "invalid"; message: string };
type StartResult =
  | { status: "started"; attempt: GoogleConnectAttempt }
  | { status: "needsCredentials"; message: string }
  | { status: "vaultLocked"; message: string }
  | { status: "invalid"; message: string };

type GoogleLayer = { google?: { clientId?: unknown; clientSecret?: unknown; accounts?: Record<string, Record<string, unknown>> } };

/** An error that already says what went wrong. */
class CodedError extends Error {
  constructor(
    message: string,
    readonly code: GoogleConnectErrorCode,
  ) {
    super(message);
  }
}

type Attempt = GoogleConnectAttempt & {
  createdAccount: boolean;
  /** The services to save for the account once Google has agreed. */
  services: GoogleServiceName[];
  timer?: ReturnType<typeof setTimeout>;
};

const SERVICE_NAMES: Record<GoogleServiceName, string> = { gmail: "Email (Gmail)", calendar: "Calendar", drive: "Files (Google Drive)" };

export default class GoogleConnectService implements TokenRingService {
  readonly name = "GoogleConnectService";
  description = "Guided Google sign-in for the web app";

  private attempt: Attempt | null = null;

  constructor(
    private readonly app: TokenRingApp,
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  /** The addresses Google must be told it may send the user back to. */
  getRedirectUris(): string[] {
    try {
      const { port } = this.app.requireService(WebHostService).getURL();
      return [new URL(GOOGLE_OAUTH_CALLBACK_PATH, `http://127.0.0.1:${port}`).toString()];
    } catch {
      return [];
    }
  }

  getSetup(): GoogleSetup {
    const google = this.app.requireService(GoogleService);
    const secrets = this.app.requireService(SecretService);
    const configured = (this.app.requireService(ConfigurationService).getEffectiveConfig() as { google?: { clientId?: SecretRef; clientSecret?: SecretRef } })
      .google;
    const clientId = secrets.resolve(configured?.clientId);

    return {
      redirectUris: this.getRedirectUris(),
      canSaveCredentials: secrets.canStore(),
      clientIdSource: sourceOf(configured?.clientId, secrets),
      clientSecretSource: sourceOf(configured?.clientSecret, secrets),
      ...(clientId && { clientId }),
      credentialsReady: google.hasClientCredentials(),
      accounts: this.listAccounts(),
    };
  }

  /** Every connected account: who it is, which services are linked, and whether it is signed in. No tokens. */
  listAccounts(): GoogleAccountSummary[] {
    const google = this.app.requireService(GoogleService);
    return google.getAvailableAccounts().map(name => {
      const status = google.getAccountStatus(name);
      return {
        name,
        email: status.account.email,
        gmail: Boolean(status.account.gmail),
        calendar: Boolean(status.account.calendar),
        drive: Boolean(status.account.drive),
        connected: status.isAuthenticated,
      };
    });
  }

  async saveCredentials(clientIdInput: string, clientSecretInput: string): Promise<SaveResult> {
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    if (!clientId) return { status: "invalid", message: "Paste the Client ID from Google." };
    if (!clientId.endsWith(".apps.googleusercontent.com") || /\s/.test(clientId)) {
      return { status: "invalid", message: "That does not look like a Google Client ID. It is a long address that ends in .apps.googleusercontent.com." };
    }
    if (!clientSecret) return { status: "invalid", message: "Paste the Client secret from Google." };
    if (/\s/.test(clientSecret)) return { status: "invalid", message: "The Client secret should have no spaces or line breaks. Copy it again from Google." };

    const secrets = this.app.requireService(SecretService);
    if (!secrets.canStore()) return { status: "vaultLocked", message: VAULT_LOCKED_HELP };

    const configuration = this.app.requireService(ConfigurationService);
    try {
      await saveToVaultThen(
        secrets,
        [
          [CLIENT_ID_REF, clientId],
          [CLIENT_SECRET_REF, clientSecret],
        ],
        async () => {
          const result = await configuration.update("global", overrides => {
            const layer = overrides as GoogleLayer;
            layer.google = { ...layer.google, clientId: CLIENT_ID_REF, clientSecret: CLIENT_SECRET_REF };
          });
          if (!result.ok) throw new Error(result.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "invalid", message: `Could not save your Google access: ${message.split(clientSecret).join("[hidden]")}` };
    }

    return { status: "success", setup: this.getSetup() };
  }

  async startSignIn(emailInput: string, services: readonly GoogleServiceName[]): Promise<StartResult> {
    const email = emailInput.trim().toLowerCase();
    if (!z.email().safeParse(email).success) {
      return { status: "invalid", message: "Enter the Google email address you want to connect, like name@gmail.com." };
    }
    const chosen = normalizeServices(services);
    if (!chosen) return { status: "invalid", message: NO_SERVICES_MESSAGE };

    const google = this.app.requireService(GoogleService);
    const existing = google.getAvailableAccounts().includes(email);
    const result = await this.startAttempt(email, email, chosen, !existing);
    return result;
  }

  /**
   * Changes which services an account links. Taking services away only changes the settings (and the providers
   * follow). Adding one needs Google's permission, so this starts the same sign-in as connecting; the new
   * services are saved only once Google has agreed.
   */
  async updateServices(
    name: string,
    services: readonly GoogleServiceName[],
  ): Promise<
    | { status: "saved"; message: string; accounts: GoogleAccountSummary[] }
    | { status: "needsConsent"; attempt: GoogleConnectAttempt }
    | Exclude<StartResult, { status: "started" }>
  > {
    const google = this.app.requireService(GoogleService);
    if (!google.getAvailableAccounts().includes(name)) return { status: "invalid", message: `There is no connected Google account called ${name}.` };
    const chosen = normalizeServices(services);
    if (!chosen) return { status: "invalid", message: NO_SERVICES_MESSAGE };

    const current = google.getAccountServices(name);
    const added = chosen.filter(service => !current.includes(service));
    const removed = current.filter(service => !chosen.includes(service));

    if (added.length === 0) {
      if (removed.length === 0) return { status: "saved", message: "Nothing changed.", accounts: this.listAccounts() };
      const saved = await this.saveServices(name, google.requireAccount(name).email, chosen);
      if (!saved.ok) return { status: "invalid", message: saved.message };
      const names = removed.map(service => SERVICE_NAMES[service]).join(", ");
      return {
        status: "saved",
        message: `TokenRing no longer uses ${names} for this account. Google still lists the permission until you disconnect the account or remove TokenRing at myaccount.google.com/permissions.`,
        accounts: this.listAccounts(),
      };
    }

    const started = await this.startAttempt(name, google.requireAccount(name).email, chosen, false);
    return started.status === "started" ? { status: "needsConsent", attempt: started.attempt } : started;
  }

  /**
   * Removes an account: asks Google to revoke the access (best effort), deletes the saved sign-in from the
   * vault, drops the account from the settings and unregisters its Email, Calendar and Drive. The OAuth client
   * ID and secret are shared by every account and stay.
   */
  async disconnect(
    name: string,
  ): Promise<
    | { status: "disconnected"; revoke: GoogleRevoke; message: string; accounts: GoogleAccountSummary[] }
    | { status: "vaultLocked"; message: string }
    | { status: "invalid"; message: string }
  > {
    const google = this.app.requireService(GoogleService);
    if (!google.getAvailableAccounts().includes(name)) return { status: "invalid", message: `There is no connected Google account called ${name}.` };
    if (!this.app.requireService(SecretService).canStore()) {
      return { status: "vaultLocked", message: `${VAULT_LOCKED_HELP} The saved sign-in is deleted from the vault, so it has to be unlocked.` };
    }

    if (this.attempt?.name === name) this.cancel();
    let outcome: Awaited<ReturnType<GoogleService["disconnectAccount"]>>;
    try {
      outcome = await google.disconnectAccount(name);
    } catch (error) {
      return { status: "invalid", message: `Could not disconnect ${name}: ${google.redactSecrets(error instanceof Error ? error.message : String(error))}` };
    }

    const removed = await this.removeAccount(name);
    if (!removed.ok) {
      return {
        status: "invalid",
        message: `The saved sign-in for ${name} was deleted, but the account could not be removed from your settings: ${removed.message}`,
      };
    }
    const message =
      outcome.result === "confirmed"
        ? `${name} is disconnected. TokenRing deleted its saved sign-in and Google confirmed the access was taken back.`
        : `${name} is disconnected. TokenRing deleted its saved sign-in, but ${outcome.message.charAt(0).toLowerCase()}${outcome.message.slice(1)}`;
    return { status: "disconnected", revoke: outcome.result, message, accounts: this.listAccounts() };
  }

  /** Sets up (and checks) everything a sign-in needs, then starts it. `createAccount` adds a new account with just `services`. */
  private async startAttempt(name: string, email: string, services: GoogleServiceName[], createAccount: boolean): Promise<StartResult> {
    const secrets = this.app.requireService(SecretService);
    if (!secrets.canStore()) return { status: "vaultLocked", message: VAULT_LOCKED_HELP };

    const google = this.app.requireService(GoogleService);
    if (!google.hasClientCredentials()) {
      return { status: "needsCredentials", message: "Save your Client ID and Client secret first (step 3)." };
    }
    const redirectUri = this.getRedirectUris()[0];
    if (!redirectUri) return { status: "invalid", message: "TokenRing could not work out its own address, so Google cannot send you back to it." };

    this.cancel();

    if (createAccount) {
      const saved = await this.saveServices(name, email, services);
      if (!saved.ok) return { status: "invalid", message: `Could not add the account: ${saved.message}` };
    }

    let begun: ReturnType<GoogleService["beginAuthorization"]>;
    try {
      begun = google.beginAuthorization(name, redirectUri, { services });
    } catch (error) {
      if (createAccount) await this.removeAccount(name);
      return { status: "invalid", message: google.redactSecrets(error instanceof Error ? error.message : String(error)) };
    }

    const attempt: Attempt = {
      id: randomUUID(),
      name,
      email,
      services,
      state: "waiting",
      authorizationUrl: begun.authorizationUrl,
      createdAccount: createAccount,
    };
    this.attempt = attempt;
    void this.followAttempt(attempt, begun.waitForCallback, redirectUri);
    return { status: "started", attempt: publicAttempt(attempt) };
  }

  /** Writes exactly `services` into the account's entry, in every settings layer that has it (a new account goes in the global one). */
  private async saveServices(name: string, email: string, services: GoogleServiceName[]): Promise<{ ok: true } | { ok: false; message: string }> {
    const configuration = this.app.requireService(ConfigurationService);
    const scopes: ConfigScope[] = configScopes.filter(scope => (configuration.getOverrides(scope) as GoogleLayer).google?.accounts?.[name] !== undefined);
    if (scopes.length === 0) scopes.push("global");
    for (const scope of scopes) {
      const result = await configuration.update(scope, overrides => {
        const layer = overrides as GoogleLayer;
        const accounts = { ...layer.google?.accounts };
        const entry: Record<string, unknown> = { ...accounts[name], email };
        for (const service of ["gmail", "calendar", "drive"] as const) {
          if (services.includes(service)) entry[service] = entry[service] ?? {};
          else delete entry[service];
        }
        accounts[name] = entry;
        layer.google = { ...layer.google, accounts };
      });
      if (!result.ok) return { ok: false, message: result.issues.map(issue => issue.message).join("; ") };
    }
    const effective = this.app.requireService(GoogleService).getAccountServices(name);
    if (effective.length !== services.length || services.some(service => !effective.includes(service))) {
      return { ok: false, message: "These services are set somewhere TokenRing cannot change from here, such as a configuration file you edit by hand." };
    }
    return { ok: true };
  }

  getAttempt(): GoogleConnectAttempt | null {
    return this.attempt ? publicAttempt(this.attempt) : null;
  }

  /** Stops waiting for Google. A sign-in that already finished is left as it is. */
  cancel(): void {
    const attempt = this.attempt;
    if (!attempt || (attempt.state !== "waiting" && attempt.state !== "finishing")) return;
    attempt.state = "cancelled";
    delete attempt.authorizationUrl;
    clearTimeout(attempt.timer);
    this.app.requireService(GoogleService).cancelPendingAuthorizations(attempt.name, "The Google sign-in was cancelled.");
    if (attempt.createdAccount) void this.removeAccount(attempt.name);
  }

  private async followAttempt(attempt: Attempt, waitForCallback: Promise<string>, redirectUri: string): Promise<void> {
    const google = this.app.requireService(GoogleService);
    let code: string | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        attempt.timer = setTimeout(
          () => reject(new CodedError("Timed out waiting for the Google sign-in to finish.", "timedOut")),
          this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
        );
      });
      const callbackUrl = await Promise.race([waitForCallback, timeout]);
      clearTimeout(attempt.timer);
      if (stateOf(attempt) === "cancelled") return;

      attempt.state = "finishing";
      delete attempt.authorizationUrl;
      code = new URL(callbackUrl).searchParams.get("code") ?? undefined;
      if (!code) throw new Error("The Google sign-in came back without a sign-in code.");

      const status = await google.exchangeAuthorizationCode(attempt.name, code, redirectUri);
      if (stateOf(attempt) !== "finishing") return;
      if (!status.isAuthenticated) throw new CodedError("Google did not return a refresh token.", "noRefreshToken");

      // The services are saved only now that Google has agreed to them.
      const saved = await this.saveServices(attempt.name, attempt.email, attempt.services);
      if (!saved.ok) throw new Error(`Could not save the services: ${saved.message}`);
      if (stateOf(attempt) !== "finishing") return;

      attempt.state = "connected";
      attempt.connectedEmail = status.profile?.email ?? attempt.email;
    } catch (error) {
      clearTimeout(attempt.timer);
      if (attempt.state === "cancelled") return;
      if (error instanceof CodedError && error.code === "timedOut") google.cancelPendingAuthorizations(attempt.name, "Timed out.");

      const redact = (text: string) => google.redactSecrets(code ? text.split(code).join("[hidden]") : text);
      attempt.state = "failed";
      delete attempt.authorizationUrl;
      attempt.error = describeGoogleConnectError(error, redact, error instanceof CodedError ? error.code : undefined);
      if (attempt.createdAccount) await this.removeAccount(attempt.name);
    }
  }

  /**
   * Takes an account out of every settings layer that has it. Callers that only clean up after a sign-in that
   * did not finish ignore the result: an account that stays is harmless, and the next attempt reuses it.
   */
  private async removeAccount(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const configuration = this.app.requireService(ConfigurationService);
      for (const scope of configScopes) {
        if ((configuration.getOverrides(scope) as GoogleLayer).google?.accounts?.[name] === undefined) continue;
        const result = await configuration.update(scope, overrides => {
          const layer = overrides as GoogleLayer;
          const accounts = layer.google?.accounts;
          if (!accounts || !(name in accounts)) return;
          delete accounts[name];
          if (Object.keys(accounts).length === 0) delete layer.google?.accounts;
        });
        if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join("; "));
      }
      if (this.app.requireService(GoogleService).getAvailableAccounts().includes(name)) {
        throw new Error("It is set somewhere TokenRing cannot change from here, such as a configuration file you edit by hand.");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** The state as it is now: a cancel can change it while an await is pending, which narrowing cannot see. */
function stateOf(attempt: Attempt): Attempt["state"] {
  return attempt.state;
}

const NO_SERVICES_MESSAGE = "Choose at least one thing for TokenRing to use: Email, Calendar or Files.";

/** The chosen services without repeats, or undefined when nothing was chosen. */
function normalizeServices(services: readonly GoogleServiceName[]): GoogleServiceName[] | undefined {
  const chosen = (["gmail", "calendar", "drive"] as const).filter(service => services.includes(service));
  return chosen.length > 0 ? chosen : undefined;
}

function sourceOf(ref: SecretRef | undefined, secrets: SecretService): CredentialSource {
  if (ref === undefined || secrets.resolve(ref) === undefined) return "none";
  if (typeof ref === "string") return "settings";
  return ref.source === "vault" ? "vault" : "environment";
}

function publicAttempt({ createdAccount: _createdAccount, timer: _timer, ...attempt }: Attempt): GoogleConnectAttempt {
  return { ...attempt, ...(attempt.error && { error: { ...attempt.error, tryThis: [...attempt.error.tryThis] } }) };
}
