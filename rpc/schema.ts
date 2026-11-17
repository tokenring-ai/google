import type { RPCSchema } from "@tokenring-ai/rpc/types";
import { z } from "zod";

/*
 * The "Connect Google" wizard's RPC surface. Bundled for the browser: only zod and types here.
 *
 * Nothing in these results carries a credential. The client secret goes in (`saveCredentials`) and is never
 * returned; only whether it is saved, and from where, comes back.
 */

/** Where a credential comes from now. */
export const GoogleCredentialSourceSchema = z.enum(["vault", "environment", "settings", "none"]);

/** Why a connection attempt failed, in terms the wizard can explain. `unknown` is shown verbatim. */
export const GoogleConnectErrorCodeSchema = z.enum([
  "accessDenied",
  "redirectUriMismatch",
  "wrongClient",
  "invalidGrant",
  "noRefreshToken",
  "vaultLocked",
  "noCredentials",
  "timedOut",
  "exchangeFailed",
  "unknown",
]);

export const GoogleConnectErrorSchema = z.object({
  code: GoogleConnectErrorCodeSchema,
  /** One plain sentence: what went wrong. */
  title: z.string(),
  /** The most likely cause. */
  message: z.string(),
  /** What to try, in order. */
  tryThis: z.array(z.string()),
  /** The underlying error text (credentials removed), for "copy details". */
  details: z.string(),
});

/** The Google services TokenRing can link to an account. Each one asks Google for its own permissions. */
export const GoogleServiceSchema = z.enum(["gmail", "calendar", "drive"]);

/** The services the person chose: at least one, none twice. */
export const GoogleServiceChoiceSchema = z
  .array(GoogleServiceSchema)
  .min(1)
  .max(3)
  .refine(services => new Set(services).size === services.length, { message: "List each service once." });

export const GoogleConnectAttemptSchema = z.object({
  id: z.string(),
  /** The account name the attempt connects (the email address). */
  name: z.string(),
  email: z.string(),
  /** The services this sign-in links. */
  services: z.array(GoogleServiceSchema).exactOptional(),
  state: z.enum(["waiting", "finishing", "connected", "failed", "cancelled"]),
  /** Where to send the user to sign in; only while `waiting`. */
  authorizationUrl: z.string().exactOptional(),
  /** The Google account that was connected, once `connected`. */
  connectedEmail: z.string().exactOptional(),
  error: GoogleConnectErrorSchema.exactOptional(),
});

export const GoogleAccountSummarySchema = z.object({
  name: z.string(),
  email: z.string(),
  gmail: z.boolean(),
  calendar: z.boolean(),
  drive: z.boolean(),
  /** Signed in: a long-lived grant is stored. When false the account needs to sign in again. */
  connected: z.boolean(),
});

/** Whether Google confirmed that the access was taken back. */
export const GoogleRevokeSchema = z.enum(["confirmed", "notConfirmed", "nothingToRevoke"]);

const SetupResultSchema = z.object({
  /** Every redirect URI this app uses; each must be listed on the Google OAuth client. */
  redirectUris: z.array(z.string()),
  /** Whether credentials can be saved now: the vault is unlocked. */
  canSaveCredentials: z.boolean(),
  clientIdSource: GoogleCredentialSourceSchema,
  clientSecretSource: GoogleCredentialSourceSchema,
  /** The client ID is an identifier, not a secret, so it can be shown. */
  clientId: z.string().exactOptional(),
  /** Both the client ID and the client secret have a value. */
  credentialsReady: z.boolean(),
  accounts: z.array(GoogleAccountSummarySchema),
});

const InvalidSchema = z.object({ status: z.literal("invalid"), message: z.string() });
const VaultLockedSchema = z.object({ status: z.literal("vaultLocked"), message: z.string() });
const StartResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), attempt: GoogleConnectAttemptSchema }),
  z.object({ status: z.literal("needsCredentials"), message: z.string() }),
  VaultLockedSchema,
  InvalidSchema,
]);

export default {
  name: "Google RPC",
  path: "/rpc/google",
  methods: {
    getSetup: {
      type: "query",
      input: z.object({}),
      result: SetupResultSchema,
    },
    saveCredentials: {
      type: "mutation",
      input: z.object({
        clientId: z.string().max(512),
        clientSecret: z.string().max(512),
      }),
      result: z.discriminatedUnion("status", [z.object({ status: z.literal("success"), setup: SetupResultSchema }), VaultLockedSchema, InvalidSchema]),
    },
    startConnect: {
      type: "mutation",
      input: z.object({ email: z.string().max(320), services: GoogleServiceChoiceSchema }),
      result: StartResultSchema,
    },
    getConnectStatus: {
      type: "query",
      input: z.object({}),
      result: z.object({ attempt: GoogleConnectAttemptSchema.nullable() }),
    },
    cancelConnect: {
      type: "mutation",
      input: z.object({}),
      result: z.object({ status: z.literal("success") }),
    },
    listAccounts: {
      type: "query",
      input: z.object({}),
      result: z.object({ accounts: z.array(GoogleAccountSummarySchema) }),
    },
    updateAccountServices: {
      type: "mutation",
      input: z.object({ name: z.string().max(320), services: GoogleServiceChoiceSchema }),
      result: z.discriminatedUnion("status", [
        /** Only services were taken away (or nothing changed): saved, nothing more to do. */
        z.object({ status: z.literal("saved"), message: z.string(), accounts: z.array(GoogleAccountSummarySchema) }),
        /** A service was added, so Google must ask for permission again; follow the attempt like a sign-in. */
        z.object({ status: z.literal("needsConsent"), attempt: GoogleConnectAttemptSchema }),
        z.object({ status: z.literal("needsCredentials"), message: z.string() }),
        VaultLockedSchema,
        InvalidSchema,
      ]),
    },
    disconnectAccount: {
      type: "mutation",
      input: z.object({ name: z.string().max(320) }),
      result: z.discriminatedUnion("status", [
        z.object({
          status: z.literal("disconnected"),
          /** Whether Google confirmed the access was taken back. */
          revoke: GoogleRevokeSchema,
          /** What happened, in words to show the person. */
          message: z.string(),
          accounts: z.array(GoogleAccountSummarySchema),
        }),
        VaultLockedSchema,
        InvalidSchema,
      ]),
    },
  },
} satisfies RPCSchema;

export type GoogleSetup = z.infer<typeof SetupResultSchema>;
export type GoogleService = z.infer<typeof GoogleServiceSchema>;
export type GoogleAccountSummary = z.infer<typeof GoogleAccountSummarySchema>;
export type GoogleRevoke = z.infer<typeof GoogleRevokeSchema>;
export type GoogleConnectAttempt = z.infer<typeof GoogleConnectAttemptSchema>;
export type GoogleConnectError = z.infer<typeof GoogleConnectErrorSchema>;
export type GoogleConnectErrorCode = z.infer<typeof GoogleConnectErrorCodeSchema>;
