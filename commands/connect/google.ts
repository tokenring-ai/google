import { setTimeout as delay } from "node:timers/promises";
import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import { type ConfigLayer, ConfigurationService } from "@tokenring-ai/app";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import GoogleService, { GOOGLE_OAUTH_CALLBACK_PATH } from "../../GoogleService.ts";
import type { GoogleService as GoogleServiceName } from "../../rpc/schema.ts";

const inputSchema = {
  args: {
    name: {
      description: "The name to save the Google account under. Defaults to the email address",
      type: "string",
      required: false,
    },
    gmail: {
      description: "Link Email (Gmail): read, write drafts, send and organise mail. Skips the question about which services to link",
      type: "flag",
    },
    calendar: {
      description: "Link Calendar: read and change events. Skips the question about which services to link",
      type: "flag",
    },
    drive: {
      description: "Link Files (Google Drive): read and change ALL files in your Drive. Skips the question about which services to link",
      type: "flag",
    },
    save: {
      description: "Where to save the Google account configuration - in the user configuration or in the project configuration",
      type: "enum",
      values: ["global", "workspace"],
      defaultValue: "workspace",
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

const USAGE = "Usage: /connect google <email> [--gmail] [--calendar] [--drive]. Choose at least one service to link; nothing is linked by default.";

const SERVICE_CHOICES: { service: GoogleServiceName; name: string }[] = [
  { service: "gmail", name: "Email (Gmail): read, write drafts, send and organise your mail" },
  { service: "calendar", name: "Calendar: read and change your events" },
  { service: "drive", name: "Files (Google Drive): read and change ALL files in your Drive" },
];

/** The services to link: the flags when any was given, else the person's answer. Nothing is chosen for them. */
async function chooseServices(
  agent: AgentCommandInputType<typeof inputSchema>["agent"],
  flags: { gmail?: boolean | undefined; calendar?: boolean | undefined; drive?: boolean | undefined },
): Promise<GoogleServiceName[]> {
  const flagged = SERVICE_CHOICES.map(choice => choice.service).filter(service => flags[service]);
  if (flagged.length > 0) return flagged;

  // `whenUnanswered: null`: a question nobody answers is not answered with the pre-ticked boxes.
  const answer = await agent.askQuestion(
    {
      message: "What should TokenRing use from this Google account? Each one asks Google for its own permissions.",
      question: {
        type: "treeSelect",
        label: "Google services",
        minimumSelections: 1,
        defaultValue: ["gmail", "calendar"],
        tree: SERVICE_CHOICES.map(({ service, name }) => ({ name, value: service })),
      },
    },
    { whenUnanswered: null, unansweredNote: "linked nothing" },
  );
  const chosen = SERVICE_CHOICES.map(choice => choice.service).filter(service => answer?.includes(service));
  if (chosen.length === 0) throw new CommandFailedError(USAGE);
  return chosen;
}

export default {
  name: "connect google",
  description: "Connects a Google account",
  inputSchema,
  execute: async ({ agent, args: { email, name, save, gmail, calendar, drive } }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    const googleService = agent.requireService(GoogleService);
    const webHostService = agent.requireService(WebHostService);

    if (!email) {
      email =
        (await agent.askForText({ message: "What is the email address for the Google account you want to connect?", label: "Email Address" })) ?? undefined;
    }

    if (!email) throw new CommandFailedError("Usage: /connect google <email>");

    const services = await chooseServices(agent, { gmail, calendar, drive });
    name ??= email;

    // The account is saved with exactly the chosen services, so only their permissions are asked of Google.
    const configService = agent.requireService(ConfigurationService);
    const overrides = configService.getOverrides(save) as { google?: { accounts?: Record<string, Record<string, unknown>> } };
    const entry: Record<string, unknown> = { ...overrides.google?.accounts?.[name], email };
    for (const service of ["gmail", "calendar", "drive"] as const) {
      if (services.includes(service)) entry[service] = entry[service] ?? {};
      else delete entry[service];
    }
    const saved = await configService.apply(save, {
      ...overrides,
      google: { ...overrides.google, accounts: { ...overrides.google?.accounts, [name]: entry } },
    } as ConfigLayer);
    if (!saved.ok) throw new CommandFailedError(saved.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));

    const redirectUri = new URL(GOOGLE_OAUTH_CALLBACK_PATH, `http://127.0.0.1:${webHostService.getURL().port}`).toString();
    const { authorizationUrl, waitForCallback } = googleService.beginAuthorization(name, redirectUri, { services });

    agent.chatOutput(
      [`Open this URL to sign in to Google for ${name}`, authorizationUrl, "", `TokenRing is listening for the OAuth callback at ${redirectUri}.`].join("\n"),
    );

    const signal = agent.getAbortSignal();
    const callbackUrl = await agent.busyWithActivity(
      `Waiting for Google OAuth callback for ${name}`,
      Promise.race([
        waitForCallback,
        delay(5 * 60 * 1000, null, { signal }).then(() => {
          throw new CommandFailedError(`Timed out waiting for the Google OAuth callback for "${name}"`);
        }),
      ]),
    );

    const code = extractAuthorizationCode(callbackUrl);
    const { isAuthenticated, profile } = await googleService.exchangeAuthorizationCode(name, code, redirectUri);

    if (!isAuthenticated) {
      throw new CommandFailedError(`Google account "${name}" authentication failed`);
    }

    return `Google account "${name}" authenticated with email ${profile?.email ?? "unknown"}. Linked: ${services.join(", ")}.`;
  },
  help: `Authenticate a Google account and store its OAuth tokens in the vault.

You choose which Google services to link; nothing is linked by default. Without flags you are asked, with Email and
Calendar ticked and Drive not. Each service asks Google for its own permissions:

- --gmail: Email. Read, write drafts, send and organise your mail.
- --calendar: Calendar. Read and change your events.
- --drive: Files. Read and change ALL files in your Google Drive.

If nobody can answer the question (an unattended run) and no flag is given, the command stops and tells you to pass flags.

## Examples

/connect google me@gmail.com
/connect google me@gmail.com --gmail --calendar
/connect google me@gmail.com --drive`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
