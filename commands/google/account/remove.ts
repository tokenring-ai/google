import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import GoogleConnectService from "../../../GoogleConnectService.ts";
import GoogleService from "../../../GoogleService.ts";

const inputSchema = {
  args: {
    yes: {
      description: "Do not ask for confirmation",
      type: "flag",
    },
  },
  positionals: [
    {
      name: "name",
      description: "The Google account name to disconnect",
      required: true,
    },
  ],
} as const satisfies AgentCommandInputSchema;

export default {
  name: "google account remove",
  alias: "google account disconnect",
  description: "Disconnect a Google account",
  inputSchema,
  execute: async ({ agent, args }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const name = args.name;
    const { account } = agent.requireService(GoogleService).getAccountStatus(name);

    if (!args.yes) {
      const approved = await agent.askForApproval({
        message: `Disconnect ${account.email}? TokenRing asks Google to take back its access, deletes the saved sign-in from the vault, and stops using this account's Email, Calendar and Drive. Your Google data is not touched.`,
        label: "Disconnect",
      });
      if (!approved) throw new CommandFailedError(`Google account "${name}" was not disconnected.`);
    }

    const result = await agent.requireService(GoogleConnectService).disconnect(name);
    if (result.status !== "disconnected") throw new CommandFailedError(result.message);
    return result.message;
  },
  help: `Disconnect a Google account: ask Google to revoke its access (best effort), delete its saved sign-in from the vault, remove it from the settings, and stop its Email, Calendar and Drive.
The OAuth client ID and secret are shared by all accounts and stay. If Google cannot be reached the account is still removed, and the result says Google did not confirm the revoke.

## Example

/google account remove me@gmail.com`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
