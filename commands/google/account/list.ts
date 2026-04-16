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
  execute: ({
                    agent,
                  }: AgentCommandInputType<typeof inputSchema>) => {
    const googleService = agent.requireServiceByType(GoogleService);
    const accounts = googleService.getAvailableAccounts();
    if (accounts.length === 0) return "No Google accounts are configured.";

    const lines =
      accounts.map((name) => {
        const {isAuthenticated, account, profile} = googleService.getAccountStatus(name);
        const integrations =
          [
            isAuthenticated ? "authenticated" : "not authenticated",
            profile ? `profile (${profile.email})` : "no profile",
            account.gmail ? "gmail" : null,
            account.calendar ? "calendar" : null,
            account.drive ? "drive" : null,
          ]
            .filter(Boolean)
            .join(", ");
        return `- ${name}: ${account.email} [${integrations}]`;
      });

    return `Available Google accounts:\n${lines.join("\n")}`;
  },
} satisfies TokenRingAgentCommand<typeof inputSchema>;
