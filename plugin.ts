import {AgentCommandService} from "@tokenring-ai/agent";
import TokenRingApp, {TokenRingPlugin} from "@tokenring-ai/app";
import {CalendarService} from "@tokenring-ai/calendar";
import {EmailService} from "@tokenring-ai/email";
import FileSystemService from "../filesystem/FileSystemService.ts";
import VaultService from "../vault/VaultService.ts";
import {WebHostService} from "../web-host/index.ts";
import {z} from "zod";
import GoogleCalendarProvider from "./GoogleCalendarProvider.ts";
import GoogleDriveFileSystemProvider from "./GoogleDriveFileSystemProvider.ts";
import GoogleOAuthCallbackResource from "./GoogleOAuthCallbackResource.ts";
import GmailEmailProvider from "./GmailEmailProvider.ts";
import GoogleService from "./GoogleService.ts";
import agentCommands from "./commands.ts";
import packageJSON from "./package.json" with {type: "json"};
import {GoogleConfigSchema, type GoogleAccount} from "./schema.ts";

const packageConfigSchema = z.object({
  google: GoogleConfigSchema.prefault({accounts: {}}),
});

function addAccountsFromEnv(accounts: Record<string, GoogleAccount>) {
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^GOOGLE_CLIENT_ID(\d*)$/);
    if (!match || !value) continue;
    const n = match[1];
    const clientSecret = process.env[`GOOGLE_CLIENT_SECRET${n}`];
    if (!clientSecret) continue;
    const userEmail = process.env[`GOOGLE_USER_EMAIL${n}`];
    const defaultName = `google-${n || "1"}`;
    const name = process.env[`GOOGLE_ACCOUNT_NAME${n}`] ?? userEmail ?? defaultName;
    accounts[name] = {
      clientId: value,
      clientSecret,
      userEmail,
      refreshToken: process.env[`GOOGLE_REFRESH_TOKEN${n}`],
      accessToken: process.env[`GOOGLE_ACCESS_TOKEN${n}`],
      email: { description: "Gmail" },
      calendar: { description: "Google Calendar", calendarId: "primary" },
      drive: {description: "Google Drive", rootFolderId: "root"}
    };
  }
}

export default {
  name: packageJSON.name,
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    addAccountsFromEnv(config.google.accounts);

    const googleService = new GoogleService(GoogleConfigSchema.parse(config.google));
    app.addServices(googleService);

    app.waitForService(VaultService, vaultService => {
      googleService.setVaultService(vaultService);
    });
    app.waitForService(AgentCommandService, commandService => {
      commandService.addAgentCommands(agentCommands);
    });

    for (const [name, account] of Object.entries(config.google.accounts)) {
      if (account.email) {
        app.services.waitForItemByType(EmailService, emailService => {
          emailService.registerEmailProvider(
            name,
            new GmailEmailProvider({description: account.email!.description, account: name}, googleService),
          );
        });
      }

      if (account.calendar) {
        app.services.waitForItemByType(CalendarService, calendarService => {
          calendarService.registerCalendarProvider(
            name,
            new GoogleCalendarProvider({description: account.calendar!.description, account: name, calendarId: account.calendar!.calendarId}, googleService),
          );
        });
      }

      if (account.drive) {
        app.services.waitForItemByType(FileSystemService, fileSystemService => {
          fileSystemService.registerFileSystemProvider(
            name,
            new GoogleDriveFileSystemProvider({description: account.drive!.description, account: name, rootFolderId: account.drive!.rootFolderId}, googleService),
          );
        });
      }
    }
    app.services.waitForItemByType(WebHostService, webHostService => {
      webHostService.registerResource("google-oauth-callback", new GoogleOAuthCallbackResource(googleService));
    });
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
