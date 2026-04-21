import { z } from "zod";

export const GoogleAccountGmailSchema = z.object({
  description: z.string().default("Gmail"),
});

export const GoogleAccountCalendarSchema = z.object({
  description: z.string().default("Google Calendar"),
  calendarId: z.string().default("primary"),
});

export const GoogleAccountDriveSchema = z.object({
  description: z.string().default("Google Drive filesystem"),
  rootFolderId: z.string().default("root"),
});

export const GoogleAccountSchema = z.object({
  email: z.string().email(),
  gmail: GoogleAccountGmailSchema.prefault({}),
  calendar: GoogleAccountCalendarSchema.prefault({}),
  drive: GoogleAccountDriveSchema.prefault({}),
});

export const GoogleStoredTokenSchema = z.object({
  refreshToken: z.string().exactOptional(),
  accessToken: z.string().exactOptional(),
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
    account: z.string().exactOptional(),
  })
  .default({});

export const GoogleConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  accounts: z.record(z.string(), GoogleAccountSchema).default({}),
  agentDefaults: GoogleAgentOptionsSchema.default({}),
});

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
