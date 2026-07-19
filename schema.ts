import type { ConfigFieldMeta } from "@tokenring-ai/app/config/metadata";
import { z } from "zod";

export const GoogleAccountGmailSchema = z.object({
  description: z.string().default("Gmail").meta({ description: "Display name for this account's Gmail integration" } satisfies ConfigFieldMeta),
});

export const GoogleAccountCalendarSchema = z.object({
  description: z.string().default("Google Calendar").meta({ description: "Display name for this account's calendar integration" } satisfies ConfigFieldMeta),
  calendarId: z.string().default("primary").meta({ description: "Calendar ID to use (\"primary\" for the account's main calendar)" } satisfies ConfigFieldMeta),
});

export const GoogleAccountDriveSchema = z.object({
  description: z.string().default("Google Drive filesystem").meta({ description: "Display name for this account's Drive filesystem" } satisfies ConfigFieldMeta),
  rootFolderId: z.string().default("root").meta({ advanced: true, description: "Drive folder ID treated as the filesystem root" } satisfies ConfigFieldMeta),
});

export const GoogleAccountSchema = z.object({
  email: z.string().email().meta({ description: "Google account email address" } satisfies ConfigFieldMeta),
  gmail: GoogleAccountGmailSchema.exactOptional().meta({ label: "Gmail" } satisfies ConfigFieldMeta),
  calendar: GoogleAccountCalendarSchema.exactOptional().meta({ label: "Calendar" } satisfies ConfigFieldMeta),
  drive: GoogleAccountDriveSchema.exactOptional().meta({ label: "Drive" } satisfies ConfigFieldMeta),
});

export const GoogleStoredTokenSchema = z.object({
  refreshToken: z.string().exactOptional().meta({ sensitive: true, description: "OAuth refresh token (obtained via login)" } satisfies ConfigFieldMeta),
  accessToken: z.string().exactOptional().meta({ sensitive: true, description: "OAuth access token (obtained via login)" } satisfies ConfigFieldMeta),
  expiryDate: z.number().exactOptional(),
  grantedScopes: z.array(z.string()).exactOptional(),
  profile: z
    .object({
      email: z.string().nullable().exactOptional(),
      family_name: z.string().nullable().exactOptional(),
      gender: z.string().nullable().exactOptional(),
      given_name: z.string().nullable().exactOptional(),
      hd: z.string().nullable().exactOptional(),
      id: z.string().nullable().exactOptional(),
      link: z.string().nullable().exactOptional(),
      locale: z.string().nullable().exactOptional(),
      name: z.string().nullable().exactOptional(),
      picture: z.string().nullable().exactOptional(),
      verified_email: z.boolean().nullable().exactOptional(),
    })
    .exactOptional(),
});

export const GoogleAgentOptionsSchema = z
  .object({
    account: z.string().exactOptional().meta({ description: "Google account new agents use by default" } satisfies ConfigFieldMeta),
  })
  .default({});

export const GoogleConfigSchema = z
  .object({
    clientId: z.string().optional().meta({ description: "Google OAuth client ID" } satisfies ConfigFieldMeta),
    clientSecret: z.string().optional().meta({ sensitive: true, description: "Google OAuth client secret" } satisfies ConfigFieldMeta),
    accounts: z
      .record(z.string(), GoogleAccountSchema)
      .default({})
      .meta({ label: "Accounts", description: "Connected Google accounts, keyed by name" } satisfies ConfigFieldMeta),
    agentDefaults: GoogleAgentOptionsSchema.default({}).meta({ label: "Agent Defaults" } satisfies ConfigFieldMeta),
  })
  .meta({ label: "Google", description: "Google OAuth, Gmail, Calendar, and Drive integration settings" } satisfies ConfigFieldMeta);

export const GmailEmailProviderOptionsSchema = z.object({
  description: z.string(),
  account: z.string(),
});

export const GoogleCalendarProviderOptionsSchema = z.object({
  description: z.string(),
  account: z.string(),
  calendarId: z.string().default("primary"),
});

export const GoogleDriveFileSystemProviderOptionsSchema = z.object({
  description: z.string().default("Google Drive filesystem"),
  account: z.string(),
  rootFolderId: z.string().default("root"),
});

export type GoogleConfig = z.input<typeof GoogleConfigSchema>;
export type GoogleAccount = z.input<typeof GoogleAccountSchema>;
export type GoogleStoredToken = z.input<typeof GoogleStoredTokenSchema>;
export type GmailEmailProviderOptions = z.input<typeof GmailEmailProviderOptionsSchema>;
export type GoogleCalendarProviderOptions = z.input<typeof GoogleCalendarProviderOptionsSchema>;
export type GoogleDriveFileSystemProviderOptions = z.input<typeof GoogleDriveFileSystemProviderOptionsSchema>;
export type GoogleAccountEmail = z.input<typeof GoogleAccountGmailSchema>;
export type GoogleAccountCalendar = z.input<typeof GoogleAccountCalendarSchema>;
export type GoogleAccountDrive = z.input<typeof GoogleAccountDriveSchema>;
