import {AgentCommandService} from "@tokenring-ai/agent";
import type {TokenRingPlugin} from "@tokenring-ai/app";
import {CalendarService} from "@tokenring-ai/calendar";
import {EmailService} from "@tokenring-ai/email";
import {z} from "zod";
import FileSystemService from "../filesystem/FileSystemService.ts";
import {WebHostService} from "../web-host/index.ts";
import agentCommands from "./commands.ts";
import GmailEmailProvider from "./GmailEmailProvider.ts";
import GoogleCalendarProvider from "./GoogleCalendarProvider.ts";
import GoogleDriveFileSystemProvider from "./GoogleDriveFileSystemProvider.ts";
import GoogleOAuthCallbackResource from "./GoogleOAuthCallbackResource.ts";
import GoogleService from "./GoogleService.ts";
import packageJSON from "./package.json" with {type: "json"};
import {GoogleConfigSchema,} from "./schema.ts";

const packageConfigSchema = z.object({
  google: GoogleConfigSchema.prefault({})
});

export default {
  name: packageJSON.name,
  displayName: "Google Services",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    config.google.clientId ??= process.env.GOOGLE_CLIENT_ID;
    config.google.clientSecret ??= process.env.GOOGLE_CLIENT_SECRET;

    const googleService = new GoogleService(app, config.google);
    app.addServices(googleService);

    app.waitForService(AgentCommandService, (commandService) => {
      commandService.addAgentCommands(agentCommands);
    });

    for (const [name, account] of Object.entries(config.google.accounts)) {
      const {gmail, calendar, drive} = account;
      if (gmail) {
        app.services.waitForItemByType(EmailService, (emailService) => {
          emailService.registerEmailProvider(
            name,
            new GmailEmailProvider(
              {description: gmail.description, account: name},
              googleService,
            ),
          );
        });
      }

      if (calendar) {
        app.services.waitForItemByType(CalendarService, (calendarService) => {
          calendarService.registerCalendarProvider(
            name,
            new GoogleCalendarProvider(
              {
                description: calendar.description,
                account: name,
                calendarId: calendar.calendarId,
              },
              googleService,
            ),
          );
        });
      }

      if (drive) {
        app.services.waitForItemByType(
          FileSystemService,
          (fileSystemService) => {
            fileSystemService.registerFileSystemProvider(
              name,
              new GoogleDriveFileSystemProvider(
                {
                  description: drive.description,
                  account: name,
                  rootFolderId: drive.rootFolderId,
                },
                googleService,
              ),
            );
          },
        );
      }
    }
    app.services.waitForItemByType(WebHostService, (webHostService) => {
      webHostService.registerResource(
        "google-oauth-callback",
        new GoogleOAuthCallbackResource(googleService),
      );
    });
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
