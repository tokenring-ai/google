import {CommandFailedError} from "@tokenring-ai/agent/AgentError";
import type {AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand} from "@tokenring-ai/agent/types";
import GoogleService from "../../../GoogleService.ts";

const inputSchema = {
  args: {},
  positionals: [
    {
      name: "name",
      description: "The account name to inspect",
      required: true,
    },
  ],
} as const satisfies AgentCommandInputSchema;

export default {
  name: "google account get",
  description: "Show a Google account",
  inputSchema,
  execute: async ({
                    agent,
                    positionals,
                  }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const googleService = agent.requireServiceByType(GoogleService);
    const accountName = positionals.name;
    if (!accountName)
      throw new CommandFailedError("Usage: /google account get <accountName>");

    const account = googleService.requireAccount(accountName);
    const authenticated =
      await googleService.isAccountAuthenticated(accountName);

    return [
      `Account: ${accountName}`,
      `User email: ${account.userEmail ?? "(available after authentication)"}`,
      `Authenticated: ${authenticated ? "yes" : "no"}`,
    ].join("\n");
  },
  help: `Display a configured Google account.

## Example

/google account get primary`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
