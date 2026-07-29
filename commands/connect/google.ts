import { setTimeout as delay } from "node:timers/promises";
import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import { ConfigurationService } from "@tokenring-ai/app";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import GoogleService, { GOOGLE_OAUTH_CALLBACK_PATH } from "../../GoogleService.ts";
import type { GooglePackageConfig } from "../../schema.ts";

const inputSchema = {
  args: {
    name: {
      description: "The name to save the Google account under. Defaults to the email address",
      type: "string",
      required: false,
    },
    save: {
      description: "Where to save the Google account configuration - in the user configuration or in the project configuration",
      type: "enum",
      values: ["user", "project"],
      defaultValue: "user",
    },
  },
  positionals: [
    {
      name: "email",
      description: "The email address of the Google account name to connect to",
      required: false,
    },
  ],
} as const satisfies AgentCommandInputSchema;

function extractAuthorizationCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CommandFailedError("Google auth cancelled");

  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new CommandFailedError("The Google callback URL is invalid");
    }

    const code = parsed.searchParams.get("code");
    if (!code) throw new CommandFailedError("The Google callback URL does not contain an authorization code");
    return code;
  }

  return trimmed;
}

export default {
  name: "connect",
  description: "Connects a Google account",
  inputSchema,
  execute: async ({ agent, args: { email, name, save } }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const googleService = agent.requireService(GoogleService);
    const webHostService = agent.requireService(WebHostService);

    if (!agent.headless && !email) {
      email =
        (await agent.askForText({ message: "What is the email address for the Google account you want to connect?", label: "Email Address" })) ?? undefined;
    }

    if (!email) throw new CommandFailedError("Usage: /google connect <email>");

    name ??= email;

    const configService = agent.requireService(ConfigurationService);
    await configService.apply(save, {
      google: {
        accounts: {
          [name]: {
            email,
            drive: {},
            calendar: {},
            gmail: {},
          },
        },
      },
    } satisfies GooglePackageConfig);

    const redirectUri = new URL(GOOGLE_OAUTH_CALLBACK_PATH, `http://127.0.0.1:${webHostService.getURL().port}`).toString();
    const { authorizationUrl, waitForCallback } = googleService.beginAuthorization(name, redirectUri);

    agent.chatOutput(
      [`Open this URL to sign in to Google for ${name}`, authorizationUrl, "", `TokenRing is listening for the OAuth callback at ${redirectUri}.`].join("\n"),
    );

    const callbackUrl = await agent.busyWithActivity(
      `Waiting for Google OAuth callback for ${name}`,
      Promise.race([
        waitForCallback,
        delay(5 * 60 * 1000).then(() => {
          throw new CommandFailedError(`Timed out waiting for the Google OAuth callback for "${name}"`);
        }),
      ]),
    );

    const code = extractAuthorizationCode(callbackUrl);
    const { isAuthenticated, profile } = await googleService.exchangeAuthorizationCode(name, code, redirectUri);

    if (!isAuthenticated) {
      throw new CommandFailedError(`Google account "${name}" authentication failed`);
    }

    return `Google account "${name}" authenticated with email ${profile?.email ?? "unknown"}.`;
  },
  help: `Authenticate a Google account and store its OAuth tokens in the vault.

## Example

/google account auth primary`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
