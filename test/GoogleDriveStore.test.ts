import { describe, expect, it, mock } from "bun:test";
import GoogleDriveStore from "../GoogleDriveStore.ts";
import type GoogleService from "../GoogleService.ts";

const drive = { description: "Google Drive", rootFolderId: "root-id", writable: true, contextualSearch: true };

function fakeDrive(files: Record<string, unknown>) {
  const calls: { method: string; args: unknown }[] = [];
  const api = {
    files: {
      list: mock(async (args: unknown) => {
        calls.push({ method: "list", args });
        return { data: { files: [files["doc"], files["folder"]], nextPageToken: "next" } };
      }),
      get: mock(async (args: { fileId: string; alt?: string }) => {
        calls.push({ method: args.alt ? "download" : "get", args });
        if (args.alt) return { data: Buffer.from("raw bytes") };
        const file = Object.values(files).find(candidate => (candidate as { id: string }).id === args.fileId);
        if (!file) throw Object.assign(new Error("not found"), { code: 404 });
        return { data: file };
      }),
      export: mock(async (args: unknown) => {
        calls.push({ method: "export", args });
        return { data: Buffer.from("# Plan") };
      }),
      create: mock(async (args: unknown) => {
        calls.push({ method: "create", args });
        return { data: { id: "new-id", name: "notes.txt", mimeType: "text/plain" } };
      }),
      update: mock(async (args: unknown) => {
        calls.push({ method: "update", args });
        return { data: { id: "txt-id", name: "notes.txt", mimeType: "text/plain" } };
      }),
    },
  };
  const google = {
    getDriveAccounts: () => [{ name: "work", drive }],
    withDrive: async (_account: string, _request: unknown, operation: (api: unknown) => Promise<unknown>) => operation(api),
  } as unknown as GoogleService;
  return { store: new GoogleDriveStore(google), calls };
}

const files = {
  doc: { id: "doc-id", name: "Plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/d/doc-id" },
  folder: { id: "folder-id", name: "Reports", mimeType: "application/vnd.google-apps.folder" },
  txt: { id: "txt-id", name: "notes.txt", mimeType: "text/plain", size: "9" },
};

describe("GoogleDriveStore", () => {
  it("offers one mount per account with Drive, with its settings", () => {
    const { store } = fakeDrive(files);
    expect(store.mounts()).toEqual([
      { scheme: "googledrive", authority: "work", url: "googledrive://work/", label: "Google Drive · work", writable: true, contextualSearch: true },
    ]);
  });

  it("lists the root folder by its configured id, naming entries by file id", async () => {
    const { store, calls } = fakeDrive(files);
    const listing = await store.list("googledrive://work/");
    expect((calls[0]!.args as { q: string }).q).toContain("'root-id' in parents");
    expect(listing.cursor).toBe("next");
    expect(listing.entries.map(entry => [entry.url, entry.kind, entry.readsAs])).toEqual([
      ["googledrive://work/doc-id", "file", "text/markdown"],
      ["googledrive://work/folder-id", "folder", undefined],
    ]);
  });

  it("exports Google Docs as Markdown instead of downloading them", async () => {
    const { store, calls } = fakeDrive(files);
    const content = await store.read("googledrive://work/doc-id");
    expect(content).toEqual({ name: "Plan", mimeType: "text/markdown", content: Buffer.from("# Plan") });
    expect(calls.map(call => call.method)).toEqual(["get", "export"]);
  });

  it("downloads ordinary files as they are", async () => {
    const { store } = fakeDrive(files);
    const content = await store.read("googledrive://work/txt-id");
    expect(content.mimeType).toBe("text/plain");
    expect(content.content.toString()).toBe("raw bytes");
  });

  it("reports a missing file as null and refuses accounts without Drive", async () => {
    const { store } = fakeDrive(files);
    expect(await store.stat("googledrive://work/nope")).toBeNull();
    await expect(store.list("googledrive://home/")).rejects.toThrow(/no Drive configured/);
  });

  it("searches names and contents, quoting the query", async () => {
    const { store, calls } = fakeDrive(files);
    await store.search("bob's plan", { authority: "work", limit: 5 });
    expect((calls[0]!.args as { q: string }).q).toBe("(name contains 'bob\\'s plan' or fullText contains 'bob\\'s plan') and trashed=false");
  });

  it("creates into a folder and updates by id", async () => {
    const { store, calls } = fakeDrive(files);
    const created = await store.create("googledrive://work/folder-id", "notes.txt", Buffer.from("hi"), "text/plain");
    expect(created.url).toBe("googledrive://work/new-id");
    expect((calls[0]!.args as { requestBody: unknown }).requestBody).toEqual({ name: "notes.txt", parents: ["folder-id"] });
    await store.update("googledrive://work/txt-id", Buffer.from("bye"), "text/plain");
    expect((calls[1]!.args as { fileId: string }).fileId).toBe("txt-id");
  });
});
