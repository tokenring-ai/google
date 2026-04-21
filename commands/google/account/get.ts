import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
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
  execute: ({ agent, positionals }: AgentCommandInputType<typeof inputSchema>) => {
    const googleService = agent.requireServiceByType(GoogleService);
    const accountName = positionals.name;
    if (!accountName) throw new CommandFailedError("Usage: /google account get <accountName>");

    const { isAuthenticated, account, profile } = googleService.getAccountStatus(accountName);

    return [
      `Account: ${accountName} (${account.email})`,
      `User Profile Email: ${profile?.email ?? "(available after authentication)"}`,
      `Authenticated: ${isAuthenticated ? "yes" : "no"}`,
    ].join("\n");
  },
  help: `Display a configured Google account.

## Example

/google account get primary`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
