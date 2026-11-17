import { describe, expect, it, mock } from "bun:test";
import WebHostService from "@tokenring-ai/web-host/WebHostService";
import { createConnectHarness } from "../../secrets/test/connectHarness.ts";
import command from "../commands/connect/google.ts";
import removeCommand from "../commands/google/account/remove.ts";
import GoogleConnectService from "../GoogleConnectService.ts";
import GoogleService from "../GoogleService.ts";

type Services = ("gmail" | "calendar" | "drive")[];

function setup({ answer, nobodyToAsk = false }: { answer?: string[] | null; nobodyToAsk?: boolean } = {}) {
  const harness = createConnectHarness({ answers: ["me@example.com"], nobodyToAsk });
  const questions: { question: any; options: any }[] = [];
  const google = {
    beginAuthorization: mock((_name: string, _redirectUri: string, _options?: { services?: Services }) => ({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
      waitForCallback: Promise.resolve("http://127.0.0.1:14008/oauth/google/callback?code=the-code"),
    })),
    exchangeAuthorizationCode: mock(async (name: string) => ({ isAuthenticated: true, profile: { email: name } })),
    getAccountStatus: (_name: string) => ({ account: { email: "me@example.com" } }),
  };
  const asked: string[] = [];
  Object.assign(harness.agent, {
    askQuestion: async (question: any, options: any) => {
      questions.push({ question, options });
      // What the real agent does for a question nobody can answer: the `whenUnanswered` answer.
      return nobodyToAsk ? (options?.whenUnanswered ?? null) : (answer ?? null);
    },
    askForApproval: async ({ message }: { message: string }) => {
      asked.push(message);
      return !nobodyToAsk;
    },
    chatOutput: () => {},
    getAbortSignal: () => new AbortController().signal,
    busyWithActivity: async (_activity: string, work: Promise<unknown>) => await work,
  });
  harness.addService(GoogleService, google);
  harness.addService(WebHostService, { getURL: () => new URL("http://127.0.0.1:14008/") });
  return { harness, google, questions, asked };
}

function run(ctx: ReturnType<typeof setup>, args: Record<string, unknown> = {}) {
  return command.execute({ agent: ctx.harness.agent, args: { email: "me@example.com", save: "workspace", ...args } } as never);
}

const savedAccount = (ctx: ReturnType<typeof setup>) =>
  (ctx.harness.configuration.overrides.workspace as { google?: { accounts?: Record<string, unknown> } }).google?.accounts?.["me@example.com"];

describe("/connect google service choice", () => {
  it("asks a multi-select question with Email and Calendar ticked and Drive not, that nobody's silence can answer", async () => {
    const ctx = setup({ answer: ["gmail", "calendar"] });
    await run(ctx);

    const { question, options } = ctx.questions[0]!;
    expect(question.question.type).toBe("treeSelect");
    expect(question.question.minimumSelections).toBe(1);
    expect(question.question.defaultValue).toEqual(["gmail", "calendar"]);
    expect(question.question.tree.map((leaf: { value: string }) => leaf.value)).toEqual(["gmail", "calendar", "drive"]);
    expect(question.question.tree.find((leaf: { value: string }) => leaf.value === "drive").name).toContain("ALL files");
    expect(options.whenUnanswered).toBeNull();
  });

  it("links exactly the services the person ticked, and asks Google for only those", async () => {
    const ctx = setup({ answer: ["gmail", "calendar"] });
    const output = await run(ctx);

    expect(savedAccount(ctx)).toEqual({ email: "me@example.com", gmail: {}, calendar: {} });
    expect(ctx.google.beginAuthorization).toHaveBeenCalledWith("me@example.com", "http://127.0.0.1:14008/oauth/google/callback", {
      services: ["gmail", "calendar"],
    });
    expect(output).toContain("gmail, calendar");
  });

  it("adds Drive only when it is ticked", async () => {
    const ctx = setup({ answer: ["drive"] });
    await run(ctx);
    expect(savedAccount(ctx)).toEqual({ email: "me@example.com", drive: {} });
  });

  it("skips the question when flags say what to link, and links only the flagged services", async () => {
    const ctx = setup({ nobodyToAsk: true });
    await run(ctx, { gmail: true, drive: true });

    expect(ctx.questions).toEqual([]);
    expect(savedAccount(ctx)).toEqual({ email: "me@example.com", gmail: {}, drive: {} });
    expect(ctx.google.beginAuthorization).toHaveBeenCalledWith(expect.any(String), expect.any(String), { services: ["gmail", "drive"] });
  });

  it("fails with a usage message when nobody can answer and no flag was given, linking and saving nothing", async () => {
    const ctx = setup({ nobodyToAsk: true });
    const error = await run(ctx, { email: "me@example.com" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Usage: /connect google");
    expect((error as Error).message).toContain("--drive");
    expect(ctx.harness.configuration.overrides.workspace).toEqual({});
    expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
  });

  it("fails the same way when the question is answered with nothing ticked", async () => {
    const ctx = setup({ answer: [] });
    await expect(run(ctx)).rejects.toThrow("Usage: /connect google");
    expect(ctx.google.beginAuthorization).not.toHaveBeenCalled();
  });

  it("takes services away from an account that was linked before, in the layer it writes", async () => {
    const ctx = setup({ answer: ["gmail"] });
    ctx.harness.configuration.overrides.workspace = { google: { accounts: { "me@example.com": { email: "me@example.com", gmail: {}, drive: {} } } }, other: 1 };
    await run(ctx);
    expect(savedAccount(ctx)).toEqual({ email: "me@example.com", gmail: {} });
    expect((ctx.harness.configuration.overrides.workspace as { other?: number }).other).toBe(1);
  });
});

describe("/google account remove", () => {
  function removeRun(ctx: ReturnType<typeof setup>, disconnect: (name: string) => unknown, args: Record<string, unknown> = {}) {
    ctx.harness.addService(GoogleConnectService, { disconnect });
    return removeCommand.execute({ agent: ctx.harness.agent, args: { name: "me@example.com", ...args } } as never);
  }

  it("confirms, then uses the same disconnect path as the wizard", async () => {
    const ctx = setup();
    const disconnect = mock(async () => ({ status: "disconnected", revoke: "confirmed", message: "me@example.com is disconnected.", accounts: [] }));
    const output = await removeRun(ctx, disconnect);

    expect(ctx.asked[0]).toContain("deletes the saved sign-in");
    expect(disconnect).toHaveBeenCalledWith("me@example.com");
    expect(output).toContain("is disconnected");
  });

  it("does nothing when the confirmation is refused or nobody can answer", async () => {
    const ctx = setup({ nobodyToAsk: true });
    const disconnect = mock(async () => ({ status: "disconnected" }));
    await expect(removeRun(ctx, disconnect)).rejects.toThrow("was not disconnected");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("skips the confirmation with --yes, and reports a failure as a failure", async () => {
    const ctx = setup({ nobodyToAsk: true });
    const disconnect = mock(async () => ({ status: "vaultLocked", message: "Your keys are locked." }));
    await expect(removeRun(ctx, disconnect, { yes: true })).rejects.toThrow("Your keys are locked.");
    expect(ctx.asked).toEqual([]);
  });
});
