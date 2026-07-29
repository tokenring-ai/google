import { AgentCommandService } from "@tokenring-ai/agent";
import type { TokenRingPlugin } from "@tokenring-ai/app";
import { resolveSecret } from "@tokenring-ai/secrets/SecretService";
import { WebHostService } from "../web-host/index.ts";
import agentCommands from "./commands.ts";
import GoogleOAuthCallbackResource from "./GoogleOAuthCallbackResource.ts";
import GoogleService from "./GoogleService.ts";
import packageJSON from "./package.json" with { type: "json" };
import { GooglePackageConfigSchema, type ResolvedGoogleConfig } from "./schema.ts";

export default {
  name: packageJSON.name,
  displayName: "Google Services",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app) {
    const googleService = app.addService(new GoogleService(app));

    app.waitForService(AgentCommandService, commandService => {
      commandService.addAgentCommands(agentCommands);
    });

    app.services.waitForItemByType(WebHostService, webHostService => {
      webHostService.registerResource("google-oauth-callback", new GoogleOAuthCallbackResource(googleService));
    });
  },
  reconfigure(app, config) {
    // Resolve up front so a misconfigured client secret fails at configure, not on first OAuth.
    const { clientId: clientIdRef, clientSecret: clientSecretRef, ...rest } = config.google;
    const clientId = resolveSecret(app, clientIdRef);
    const clientSecret = resolveSecret(app, clientSecretRef);

    const resolved: ResolvedGoogleConfig = {
      ...rest,
      ...(clientId !== undefined && { clientId }),
      ...(clientSecret !== undefined && { clientSecret }),
    };

    app.requireService(GoogleService).reconfigure(resolved);
  },
  configSchema: GooglePackageConfigSchema,
} satisfies TokenRingPlugin<typeof GooglePackageConfigSchema>;
