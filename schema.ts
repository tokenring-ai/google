import {z} from "zod";

export const GoogleAccountEmailSchema = z.object({
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
  clientId: z.string(),
  clientSecret: z.string(),
  userEmail: z.string().email().optional(),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  expiryDate: z.number().optional(),
  scopes: z.array(z.string()).optional(),
  email: GoogleAccountEmailSchema.optional(),
  calendar: GoogleAccountCalendarSchema.optional(),
  drive: GoogleAccountDriveSchema.optional(),
});

export const GoogleStoredTokenSchema = z.object({
  userEmail: z.string().email().optional(),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  expiryDate: z.number().optional(),
});

export const GoogleAgentOptionsSchema = z.object({
  account: z.string().optional(),
}).default({})

export const GoogleConfigSchema = z.object({
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
export type GoogleAccountEmail = z.input<typeof GoogleAccountEmailSchema>;
export type GoogleAccountCalendar = z.input<typeof GoogleAccountCalendarSchema>;
export type GoogleAccountDrive = z.input<typeof GoogleAccountDriveSchema>;
