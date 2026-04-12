import type {AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand} from "@tokenring-ai/agent/types";
import GoogleService from "../../../GoogleService.ts";

const inputSchema = {} as const satisfies AgentCommandInputSchema;

export default {
  name: "google account list",
  description: "List available Google accounts",
  help: `List all available Google accounts.

## Example

/google account list`,
  inputSchema,
  execute: async ({
                    agent,
                  }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const googleService = agent.requireServiceByType(GoogleService);
    const accounts = googleService.getAvailableAccounts();
    if (accounts.length === 0) return "No Google accounts are configured.";

    const lines = await Promise.all(
      accounts.map(async (name) => {
        const account = googleService.requireAccount(name);
        const authenticated = await googleService.isAccountAuthenticated(name);
        const integrations =
          [
            account.email ? "gmail" : null,
            account.calendar ? "calendar" : null,
            account.drive ? "drive" : null,
          ]
            .filter(Boolean)
            .join(", ") || "oauth only";
        return `- ${name}: ${account.userEmail ?? "(email available after authentication)"} [${authenticated ? "authenticated" : "not authenticated"}; ${integrations}]`;
      }),
    );

    return `Available Google accounts:\n${lines.join("\n")}`;
  },
} satisfies TokenRingAgentCommand<typeof inputSchema>;
