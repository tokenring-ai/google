import type { GoogleConnectError, GoogleConnectErrorCode } from "./rpc/schema.ts";

/**
 * Turns what the Google plugin actually throws while connecting into words the wizard can show.
 *
 * What reaches here (see GoogleService):
 * - `Google authorization failed: <error>`: Google redirected back with `error=<error>` (`access_denied`, ...).
 * - `The Google OAuth callback redirect URI did not match the pending authorization request.`
 * - `exchange Google auth code for <name> failed: <message>`: the token exchange, or saving the tokens in the
 *   vault, failed. `<message>` is the token endpoint's own `error` (`invalid_grant`, `invalid_client`,
 *   `redirect_uri_mismatch`, ...) or the vault's (`Vault is uninitialized or locked`).
 * - The wizard's own conditions (timed out, no refresh token), which are raised with a code directly.
 *
 * Anything else is `unknown` and shown as it is.
 */

type Explanation = { title: string; message: string; tryThis: string[] };

const EXPLANATIONS: Record<Exclude<GoogleConnectErrorCode, "unknown">, Explanation> = {
  accessDenied: {
    title: "Google did not let this account in",
    message:
      "Google refused the sign-in. The usual cause: your Google app is still in testing mode and this email address has not been added as a test user. (It also happens if you chose Cancel on Google's page.)",
    tryThis: [
      "In the Google Cloud console, open the OAuth consent screen (or Audience) and add the email address you are signing in with under Test users.",
      "Make sure you sign in with exactly that email address.",
      "Press Connect again.",
    ],
  },
  redirectUriMismatch: {
    title: "Google does not recognise this app's return address",
    message: "The redirect address on your Google OAuth client does not match the one TokenRing uses.",
    tryThis: [
      "In the Google Cloud console, open your OAuth client and check that its Authorized redirect URI is exactly the address shown in step 2, with nothing added or missing.",
      "Save the client, wait a minute, and press Connect again.",
    ],
  },
  wrongClient: {
    title: "Google did not accept the client ID and secret",
    message: "They may have been copied incompletely, or the OAuth client was created as the wrong type. It needs to be a Web application.",
    tryThis: [
      "Open your OAuth client in the Google Cloud console and check its type is Web application.",
      "Copy the Client ID and Client secret again, with no spaces, and save them in step 3.",
      "If you made a new secret, use the new one.",
    ],
  },
  invalidGrant: {
    title: "Google's sign-in code did not work",
    message: "The sign-in code was already used or took too long, or the sign-in for this app was cancelled on Google's side.",
    tryThis: ["Press Connect again and finish the sign-in in one go."],
  },
  noRefreshToken: {
    title: "Google did not give lasting access",
    message: "You signed in, but Google did not hand over the lasting access TokenRing needs to keep your mail and calendar connected.",
    tryThis: ["Open myaccount.google.com/permissions, remove this app, then press Connect again.", "On Google's page, keep every permission box ticked."],
  },
  vaultLocked: {
    title: "Your keys are locked",
    message: "TokenRing keeps your Google sign-in in an encrypted file on this computer (the vault), and it is locked right now.",
    tryThis: ["Unlock the vault, then press Connect again."],
  },
  noCredentials: {
    title: "Your Google access is not set up yet",
    message: "TokenRing does not have a Client ID and Client secret to sign in with.",
    tryThis: ["Finish step 3 and save them, then press Connect."],
  },
  timedOut: {
    title: "The sign-in did not finish",
    message:
      "TokenRing waited five minutes and never heard back from Google. Most often the Google page showed an error (such as redirect_uri_mismatch or access blocked), or the tab was closed early.",
    tryThis: [
      "Press Connect again and read any message on Google's page.",
      "If it mentions a redirect URI, check the address in step 2 against your OAuth client.",
      "If it says access is blocked, add your email as a test user.",
    ],
  },
  exchangeFailed: {
    title: "Signing in with Google did not complete",
    message: "Google accepted your sign-in but would not finish handing TokenRing the access it needs.",
    tryThis: ["Press Connect again.", "If it keeps failing, check your Client ID and secret in step 3 and use Copy details to ask for help."],
  },
};

/** What a vault that cannot be written to looks like in an error message. */
const VAULT_LOCKED = /vault is (?:uninitialized or )?locked|unlock it to save|vault.*locked/i;

/** Which failure an error message describes. */
export function classifyGoogleConnectError(text: string): GoogleConnectErrorCode {
  const message = text.toLowerCase();
  if (VAULT_LOCKED.test(text)) return "vaultLocked";
  if (message.includes("redirect_uri_mismatch") || message.includes("redirect uri did not match")) return "redirectUriMismatch";
  if (message.includes("access_denied") || message.includes("access denied")) return "accessDenied";
  if (message.includes("invalid_client") || message.includes("unauthorized_client") || message.includes("client_secret is missing")) return "wrongClient";
  if (message.includes("invalid_grant")) return "invalidGrant";
  if (message.includes("exchange google auth code")) return "exchangeFailed";
  return "unknown";
}

/**
 * The explanation for a failed connection. `redact` removes credentials from the text first; the text that is
 * returned (and so shown or copied) never contains them.
 */
export function describeGoogleConnectError(
  error: unknown,
  redact: (text: string) => string = text => text,
  forceCode?: GoogleConnectErrorCode,
): GoogleConnectError {
  const raw = error instanceof Error ? error.message || error.name : typeof error === "string" ? error : "Unknown error";
  const details = redact(raw);
  const code = forceCode ?? classifyGoogleConnectError(details);

  if (code === "unknown") {
    return {
      code,
      title: "Connecting to Google failed",
      message: details,
      tryThis: ["Press Connect to try again.", "If it keeps failing, use Copy details and share them with whoever helps you with TokenRing."],
      details,
    };
  }
  return { code, ...EXPLANATIONS[code], tryThis: [...EXPLANATIONS[code].tryThis], details };
}
