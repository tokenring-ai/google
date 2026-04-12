import {CommandFailedError} from "@tokenring-ai/agent/AgentError";
import type {AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand} from "@tokenring-ai/agent/types";
import {WebHostService} from "@tokenring-ai/web-host";
import {setTimeout as delay} from "node:timers/promises";
import GoogleService, {GOOGLE_OAUTH_CALLBACK_PATH} from "../../../GoogleService.ts";

const inputSchema = {
  args: {},
  positionals: [
    {
      name: "name",
      description: "The Google account name to authenticate",
      required: true,
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
    if (!code)
      throw new CommandFailedError(
        "The Google callback URL does not contain an authorization code",
      );
    return code;
  }

  return trimmed;
}

export default {
  name: "google account auth",
  description: "Authenticate a Google account",
  inputSchema,
  execute: async ({
                    agent,
                    positionals,
                  }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const googleService = agent.requireServiceByType(GoogleService);
    const webHostService = agent.requireServiceByType(WebHostService);
    const accountName = positionals.name;
    if (!accountName)
      throw new CommandFailedError("Usage: /google account auth <accountName>");

    const account = googleService.requireAccount(accountName);
    await googleService.requireVault(agent);

    const redirectUri = new URL(
      GOOGLE_OAUTH_CALLBACK_PATH,
      `http://127.0.0.1:${webHostService.getURL().port}`,
    ).toString();
    const {authorizationUrl, waitForCallback} =
      googleService.beginAuthorization(accountName, redirectUri);

    agent.chatOutput(
      [
        `Open this URL to sign in to Google for ${accountName}${account.userEmail ? ` (${account.userEmail})` : ""}:`,
        authorizationUrl,
        "",
        `TokenRing is listening for the OAuth callback at ${redirectUri}.`,
      ].join("\n"),
    );

    const callbackUrl = await agent.busyWithActivity(
      `Waiting for Google OAuth callback for ${accountName}`,
      Promise.race([
        waitForCallback,
        delay(5 * 60 * 1000).then(() => {
          throw new CommandFailedError(
            `Timed out waiting for the Google OAuth callback for "${accountName}"`,
          );
        }),
      ]),
    );

    const code = extractAuthorizationCode(callbackUrl);
    const updatedAccount = await googleService.exchangeAuthorizationCode(
      accountName,
      code,
      redirectUri,
    );

    return updatedAccount.refreshToken
      ? `Google account "${accountName}" authenticated as ${updatedAccount.userEmail ?? "unknown"} and tokens were saved to the vault.`
      : `Google account "${accountName}" authenticated as ${updatedAccount.userEmail ?? "unknown"}, but Google did not return a refresh token. The current access token was saved to the vault.`;
  },
  help: `Authenticate a Google account and store its OAuth tokens in the vault.

## Example

/google account auth primary`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
