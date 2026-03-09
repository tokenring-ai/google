import {z} from "zod";

export const GoogleAccountSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string(),
  userEmail: z.string().email(),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  expiryDate: z.number().optional(),
  scopes: z.array(z.string()).default([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
  ]),
});

export const GoogleConfigSchema = z.object({
  accounts: z.record(z.string(), GoogleAccountSchema).default({}),
  defaultAccount: z.string().optional(),
});

export const GmailEmailProviderOptionsSchema = z.object({
  type: z.enum(["gmail", "google"]),
  description: z.string(),
  account: z.string(),
});

export const GoogleCalendarProviderOptionsSchema = z.object({
  type: z.enum(["google-calendar", "gcal"]),
  description: z.string(),
  account: z.string(),
  calendarId: z.string().default("primary"),
});

export const GoogleDriveFileSystemProviderOptionsSchema = z.object({
  type: z.enum(["google-drive", "gdrive"]),
  description: z.string().default("Google Drive filesystem"),
  account: z.string(),
  rootFolderId: z.string().default("root"),
});

export type GoogleConfig = z.output<typeof GoogleConfigSchema>;
export type GoogleAccount = z.output<typeof GoogleAccountSchema>;
export type GmailEmailProviderOptions = z.output<typeof GmailEmailProviderOptionsSchema>;
export type GoogleCalendarProviderOptions = z.output<typeof GoogleCalendarProviderOptionsSchema>;
export type GoogleDriveFileSystemProviderOptions = z.output<typeof GoogleDriveFileSystemProviderOptionsSchema>;
