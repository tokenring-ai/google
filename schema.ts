import {z} from "zod";

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
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  expiryDate: z.number().optional(),
  grantedScopes: z.array(z.string()).optional(),
  profile: z
    .object({
      email: z.string().nullable().optional(),
      family_name: z.string().nullable().optional(),
      gender: z.string().nullable().optional(),
      given_name: z.string().nullable().optional(),
      hd: z.string().nullable().optional(),
      id: z.string().nullable().optional(),
      link: z.string().nullable().optional(),
      locale: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      picture: z.string().nullable().optional(),
      verified_email: z.boolean().nullable().optional(),
    })
    .optional(),
});

export const GoogleAgentOptionsSchema = z
  .object({
    account: z.string().optional(),
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
export type GmailEmailProviderOptions = z.input<
  typeof GmailEmailProviderOptionsSchema
>;
export type GoogleCalendarProviderOptions = z.input<
  typeof GoogleCalendarProviderOptionsSchema
>;
export type GoogleDriveFileSystemProviderOptions = z.input<
  typeof GoogleDriveFileSystemProviderOptionsSchema
>;
export type GoogleAccountEmail = z.input<typeof GoogleAccountGmailSchema>;
export type GoogleAccountCalendar = z.input<typeof GoogleAccountCalendarSchema>;
export type GoogleAccountDrive = z.input<typeof GoogleAccountDriveSchema>;
