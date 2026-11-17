import type TokenRingApp from "@tokenring-ai/app";
import { createRPCEndpoint } from "@tokenring-ai/rpc/createRPCEndpoint";
import GoogleConnectService from "../GoogleConnectService.ts";
import GoogleRpcSchema from "./schema.ts";

/** The "Connect Google" wizard. Served on the authenticated RPC socket like every other endpoint. */
export default createRPCEndpoint(GoogleRpcSchema, {
  getSetup(_args, app: TokenRingApp) {
    return app.requireService(GoogleConnectService).getSetup();
  },

  saveCredentials(args, app: TokenRingApp) {
    return app.requireService(GoogleConnectService).saveCredentials(args.clientId, args.clientSecret);
  },

  startConnect(args, app: TokenRingApp) {
    return app.requireService(GoogleConnectService).startSignIn(args.email, args.services);
  },

  getConnectStatus(_args, app: TokenRingApp) {
    return { attempt: app.requireService(GoogleConnectService).getAttempt() };
  },

  listAccounts(_args, app: TokenRingApp) {
    return { accounts: app.requireService(GoogleConnectService).listAccounts() };
  },

  updateAccountServices(args, app: TokenRingApp) {
    return app.requireService(GoogleConnectService).updateServices(args.name, args.services);
  },

  disconnectAccount(args, app: TokenRingApp) {
    return app.requireService(GoogleConnectService).disconnect(args.name);
  },

  cancelConnect(_args, app: TokenRingApp) {
    app.requireService(GoogleConnectService).cancel();
    return { status: "success" as const };
  },
});
