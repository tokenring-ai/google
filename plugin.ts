import {TokenRingPlugin} from "@tokenring-ai/app";
import {CalendarConfigSchema, CalendarService} from "@tokenring-ai/calendar";
import {EmailConfigSchema, EmailService} from "@tokenring-ai/email";
import FileSystemService from "../filesystem/FileSystemService.ts";
import {FileSystemConfigSchema} from "../filesystem/schema.ts";
import {z} from "zod";
import GoogleCalendarProvider from "./GoogleCalendarProvider.ts";
import GoogleDriveFileSystemProvider from "./GoogleDriveFileSystemProvider.ts";
import GmailEmailProvider from "./GmailEmailProvider.ts";
import GoogleService from "./GoogleService.ts";
import packageJSON from "./package.json" with {type: "json"};
import {
  GmailEmailProviderOptionsSchema,
  GoogleCalendarProviderOptionsSchema,
  GoogleConfigSchema,
  GoogleDriveFileSystemProviderOptionsSchema,
} from "./schema.ts";

const packageConfigSchema = z.object({
  google: GoogleConfigSchema.optional(),
  calendar: CalendarConfigSchema.optional(),
  email: EmailConfigSchema.optional(),
  filesystem: FileSystemConfigSchema.optional(),
});

export default {
  name: packageJSON.name,
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    let googleService: GoogleService | undefined;

    if (config.google) {
      googleService = new GoogleService(config.google);
      app.services.register(googleService);
    }

    if (config.email) {
      app.services.waitForItemByType(EmailService, emailService => {
        if (!googleService) {
          throw new Error("Google email providers require google configuration");
        }

        for (const name in config.email!.providers) {
          const provider = config.email!.providers[name];
          if (provider.type === "gmail" || provider.type === "google") {
            emailService.registerEmailProvider(
              name,
              new GmailEmailProvider(GmailEmailProviderOptionsSchema.parse(provider), googleService),
            );
          }
        }
      });
    }

    if (config.calendar) {
      app.services.waitForItemByType(CalendarService, calendarService => {
        if (!googleService) {
          throw new Error("Google calendar providers require google configuration");
        }

        for (const name in config.calendar!.providers) {
          const provider = config.calendar!.providers[name];
          if (provider.type === "google-calendar" || provider.type === "gcal") {
            calendarService.registerCalendarProvider(
              name,
              new GoogleCalendarProvider(GoogleCalendarProviderOptionsSchema.parse(provider), googleService),
            );
          }
        }
      });
    }

    if (config.filesystem) {
      app.services.waitForItemByType(FileSystemService, fileSystemService => {
        if (!googleService) {
          throw new Error("Google filesystem providers require google configuration");
        }

        for (const name in config.filesystem!.providers) {
          const provider = config.filesystem!.providers[name];
          if (provider.type === "google-drive" || provider.type === "gdrive") {
            fileSystemService.registerFileSystemProvider(
              name,
              new GoogleDriveFileSystemProvider(
                GoogleDriveFileSystemProviderOptionsSchema.parse(provider),
                googleService,
              ),
            );
          }
        }
      });
    }
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
