import type { RemoteContent, RemoteEntry, RemoteListing, RemoteMount, RemoteSearchOptions, RemoteStore } from "@tokenring-ai/filesystem";
import { parseRemoteUrl } from "@tokenring-ai/filesystem/remote/RemoteStore";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import type GoogleService from "./GoogleService.ts";

const SCHEME = "googledrive";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink";
const PAGE_SIZE = 200;

/** Google-native files have no bytes of their own; `read` exports them to these types. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

type DriveFile = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
};

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from([]);
}

/** Drive query strings quote with single quotes and escape backslashes. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Google Drive as a remote store. URLs name files by ID, `googledrive://<account>/<fileId>`, because
 * Drive allows several files with the same name in one folder; `googledrive://<account>/` is the
 * account's configured root folder.
 */
export default class GoogleDriveStore implements RemoteStore {
  readonly scheme = SCHEME;
  readonly label = "Google Drive";

  constructor(private readonly google: GoogleService) {}

  mounts(): RemoteMount[] {
    return this.google.getDriveAccounts().map(({ name, drive }) => ({
      scheme: SCHEME,
      authority: name,
      url: `${SCHEME}://${encodeURIComponent(name)}/`,
      label: `${drive.description} · ${name}`,
      writable: drive.writable,
      contextualSearch: drive.contextualSearch,
    }));
  }

  private target(url: string): { account: string; fileId: string } {
    const parsed = parseRemoteUrl(url);
    if (!parsed || parsed.scheme !== SCHEME) throw new Error(`Not a Google Drive URL: ${url}`);
    const drive = this.google.getDriveAccounts().find(account => account.name === parsed.authority)?.drive;
    if (!drive) throw new Error(`Google account "${parsed.authority}" has no Drive configured`);
    // Path segments other than the last are ignored, so a URL with a readable prefix still resolves.
    const fileId = parsed.path.split("/").filter(Boolean).at(-1) ?? drive.rootFolderId;
    return { account: parsed.authority, fileId };
  }

  private toEntry(account: string, file: DriveFile): RemoteEntry {
    const mimeType = file.mimeType ?? undefined;
    return {
      url: `${SCHEME}://${encodeURIComponent(account)}/${file.id ?? ""}`,
      name: file.name ?? file.id ?? "(untitled)",
      kind: mimeType === FOLDER_MIME ? "folder" : "file",
      mimeType,
      size: file.size ? Number(file.size) : undefined,
      modified: file.modifiedTime ?? undefined,
      webUrl: file.webViewLink ?? undefined,
      readsAs: mimeType ? EXPORTS[mimeType] : undefined,
    };
  }

  async list(url: string, options: { cursor?: string | undefined } = {}): Promise<RemoteListing> {
    const { account, fileId } = this.target(url);
    const data = await this.google.withDrive(account, { context: "list Google Drive folder", method: "GET", requiredScopes: [DRIVE_SCOPE] }, async drive => {
      const response = await drive.files.list(
        stripUndefinedKeys({
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          includeItemsFromAllDrives: true,
          orderBy: "folder,name",
          pageSize: PAGE_SIZE,
          pageToken: options.cursor,
          q: `${quote(fileId)} in parents and trashed=false`,
          supportsAllDrives: true,
        }),
      );
      return response.data;
    });
    return {
      entries: (data.files ?? []).map(file => this.toEntry(account, file)),
      cursor: data.nextPageToken ?? undefined,
    };
  }

  async stat(url: string): Promise<RemoteEntry | null> {
    const { account, fileId } = this.target(url);
    try {
      const file = await this.google.withDrive(account, { context: "stat Google Drive file", method: "GET", requiredScopes: [DRIVE_SCOPE] }, async drive => {
        const response = await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true });
        return response.data;
      });
      return this.toEntry(account, file);
    } catch (error: unknown) {
      if ((error as { code?: unknown } | null)?.code === 404) return null;
      throw error;
    }
  }

  async read(url: string): Promise<RemoteContent> {
    const entry = await this.stat(url);
    if (!entry) throw new Error(`Not found: ${url}`);
    if (entry.kind === "folder") throw new Error(`${entry.name} is a folder; list it instead`);
    const { account, fileId } = this.target(url);
    const exportAs = entry.readsAs;
    const content = await this.google.withDrive(account, { context: "read Google Drive file", method: "GET", requiredScopes: [DRIVE_SCOPE] }, async drive => {
      const response = exportAs
        ? await drive.files.export({ fileId, mimeType: exportAs }, { responseType: "arraybuffer" })
        : await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      return toBuffer(response.data);
    });
    return { name: entry.name, mimeType: exportAs ?? entry.mimeType ?? "application/octet-stream", content };
  }

  async search(query: string, { authority, limit }: RemoteSearchOptions): Promise<RemoteEntry[]> {
    const text = quote(query);
    const data = await this.google.withDrive(authority, { context: "search Google Drive", method: "GET", requiredScopes: [DRIVE_SCOPE] }, async drive => {
      const response = await drive.files.list({
        fields: `files(${FILE_FIELDS})`,
        includeItemsFromAllDrives: true,
        pageSize: Math.min(limit, 100),
        q: `(name contains ${text} or fullText contains ${text}) and trashed=false`,
        supportsAllDrives: true,
      });
      return response.data;
    });
    return (data.files ?? []).map(file => this.toEntry(authority, file));
  }

  async create(folderUrl: string, name: string, content: Buffer, mimeType: string): Promise<RemoteEntry> {
    const { account, fileId: parentId } = this.target(folderUrl);
    const file = await this.google.withDrive(account, { context: "create Google Drive file", method: "POST", requiredScopes: [DRIVE_SCOPE] }, async drive => {
      const response = await drive.files.create({
        fields: FILE_FIELDS,
        media: { body: content, mimeType },
        requestBody: { name, parents: [parentId] },
        supportsAllDrives: true,
      });
      return response.data;
    });
    return this.toEntry(account, file);
  }

  async update(url: string, content: Buffer, mimeType: string): Promise<RemoteEntry> {
    const { account, fileId } = this.target(url);
    const file = await this.google.withDrive(account, { context: "update Google Drive file", method: "PATCH", requiredScopes: [DRIVE_SCOPE] }, async drive => {
      const response = await drive.files.update({ fileId, fields: FILE_FIELDS, media: { body: content, mimeType }, supportsAllDrives: true });
      return response.data;
    });
    return this.toEntry(account, file);
  }
}
