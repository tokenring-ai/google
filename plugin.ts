import { AgentCommandService } from "@tokenring-ai/agent";
import type { TokenRingPlugin } from "@tokenring-ai/app";
import { RemoteStoreService } from "@tokenring-ai/filesystem";
import { RpcService } from "@tokenring-ai/rpc";
import { resolveSecret } from "@tokenring-ai/secrets/SecretService";
import { WebHostService } from "@tokenring-ai/web-host";
import agentCommands from "./commands.ts";
import GoogleConnectService from "./GoogleConnectService.ts";
import GoogleDriveStore from "./GoogleDriveStore.ts";
import GoogleOAuthCallbackResource from "./GoogleOAuthCallbackResource.ts";
import GoogleService from "./GoogleService.ts";
import packageJSON from "./package.json" with { type: "json" };
import googleRPC from "./rpc/google.ts";
import { GooglePackageConfigSchema, type ResolvedGoogleConfig } from "./schema.ts";

export default {
  name: packageJSON.name,
  displayName: "Google Services",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app) {
    const googleService = app.addService(GoogleService, new GoogleService(app));

    app.addService(GoogleConnectService, new GoogleConnectService(app));
    app.waitForService(RpcService, rpcService => {
      rpcService.registerEndpoint(googleRPC);
    });

    app.waitForService(RemoteStoreService, remoteStores => remoteStores.registerStore(new GoogleDriveStore(googleService)));

    app.waitForService(AgentCommandService, commandService => {
      commandService.addAgentCommands(agentCommands);
    });

    app.waitForService(WebHostService, webHostService => {
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
