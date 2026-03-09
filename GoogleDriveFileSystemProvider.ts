import FileSystemProvider, {
  type DirectoryTreeOptions,
  type GlobOptions,
  type GrepOptions,
  type GrepResult,
  type StatLike,
  type WatchOptions,
} from "../filesystem/FileSystemProvider.ts";
import {z} from "zod";
import GoogleService from "./GoogleService.ts";
import {GoogleDriveFileSystemProviderOptionsSchema} from "./schema.ts";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

type ResolvedPath = {
  fileId: string | null;
  parentId: string | null;
  fileName: string;
  item: DriveFile | null;
};

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

export default class GoogleDriveFileSystemProvider implements FileSystemProvider {
  readonly name = "GoogleDriveFileSystemProvider";
  description: string;

  private readonly account: string;
  private readonly rootFolderId: string;
  private readonly idCache = new Map<string, DriveFile | ResolvedPath>();

  constructor(
    readonly options: z.output<typeof GoogleDriveFileSystemProviderOptionsSchema>,
    private readonly googleService: GoogleService,
  ) {
    this.description = options.description;
    this.account = options.account;
    this.rootFolderId = options.rootFolderId;
  }

  private pathToComponents(filePath: string): string[] {
    if (typeof filePath !== "string") throw new Error("File path must be a string.");
    return filePath.replace(/^\/+|\/+$/g, "").split("/").filter(part => part && part !== ".");
  }

  private normalizePath(filePath: string): string {
    return this.pathToComponents(filePath).join("/");
  }

  private invalidateCache(): void {
    this.idCache.clear();
  }

  private async findFileOrFolder(name: string, parentId: string, mimeType?: string): Promise<DriveFile | null> {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    let query = `name='${escapedName}' and '${parentId}' in parents and trashed=false`;
    if (mimeType) query += ` and mimeType='${mimeType}'`;

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", "files(id,name,mimeType,parents,size,createdTime,modifiedTime)");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const response = await this.googleService.fetchGoogleJson<DriveListResponse>(
      this.account,
      url.toString(),
      {method: "GET"},
      "find Google Drive file",
    );

    return response.files?.[0] ?? null;
  }

  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", `'${parentId}' in parents and trashed=false`);
      url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,parents,size,createdTime,modifiedTime)");
      url.searchParams.set("pageSize", "200");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await this.googleService.fetchGoogleJson<DriveListResponse>(
        this.account,
        url.toString(),
        {method: "GET"},
        "list Google Drive folder",
      );

      files.push(...(response.files ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken);

    return files;
  }

  private async resolvePathToId(filePath: string, createMissingFolders = false): Promise<ResolvedPath> {
    const normalizedPath = this.normalizePath(filePath);
    const fullPathKey = `path:${normalizedPath}`;
    const cached = this.idCache.get(fullPathKey);
    if (cached && "fileId" in cached) return cached;

    const components = this.pathToComponents(normalizedPath);
    if (components.length === 0) {
      const root = {
        fileId: this.rootFolderId,
        parentId: null,
        fileName: "",
        item: {
          id: this.rootFolderId,
          name: "root",
          mimeType: DRIVE_FOLDER_MIME,
        },
      } satisfies ResolvedPath;
      this.idCache.set(fullPathKey, root);
      return root;
    }

    let currentParentId = this.rootFolderId;
    let currentItem: DriveFile | null = null;

    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      const isLastComponent = index === components.length - 1;
      const componentKey = `id:${currentParentId}->${component}`;
      const cachedItem = this.idCache.get(componentKey);
      if (cachedItem && "id" in cachedItem) {
        currentItem = cachedItem;
      } else {
        currentItem = await this.findFileOrFolder(component, currentParentId, isLastComponent ? undefined : DRIVE_FOLDER_MIME);
        if (currentItem) this.idCache.set(componentKey, currentItem);
      }

      if (!currentItem) {
        if (createMissingFolders && !isLastComponent) {
          currentItem = await this.createFolder(component, currentParentId);
          this.idCache.set(componentKey, currentItem);
        } else {
          return {
            fileId: null,
            parentId: currentParentId,
            fileName: component,
            item: null,
          };
        }
      }

      if (!isLastComponent) {
        if (currentItem.mimeType !== DRIVE_FOLDER_MIME) {
          return {
            fileId: null,
            parentId: currentParentId,
            fileName: component,
            item: null,
          };
        }
        currentParentId = currentItem.id;
      }
    }

    const resolved = {
      fileId: currentItem?.id ?? null,
      parentId: components.length === 1 ? this.rootFolderId : currentParentId,
      fileName: components[components.length - 1],
      item: currentItem,
    } satisfies ResolvedPath;
    if (currentItem) this.idCache.set(fullPathKey, resolved);
    return resolved;
  }

  private async createFolder(name: string, parentId: string): Promise<DriveFile> {
    const body = JSON.stringify({
      name,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    });

    return await this.googleService.fetchGoogleJson<DriveFile>(
      this.account,
      "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents,size,createdTime,modifiedTime&supportsAllDrives=true",
      {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body,
      },
      "create Google Drive folder",
    );
  }

  private async uploadFile(parentId: string, fileName: string, content: string | Buffer, existingFileId?: string): Promise<DriveFile> {
    const boundary = `tokenring-drive-${Date.now()}`;
    const metadata = Buffer.from(JSON.stringify({name: fileName, parents: [parentId]}), "utf8");
    const fileBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      "utf8",
    );
    const middle = Buffer.from(
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const closing = Buffer.from(`\r\n--${boundary}--`, "utf8");
    const body = Buffer.concat([preamble, metadata, middle, fileBuffer, closing]);

    const method = existingFileId ? "PATCH" : "POST";
    const endpoint = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,parents,size,createdTime,modifiedTime&supportsAllDrives=true`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,parents,size,createdTime,modifiedTime&supportsAllDrives=true";

    return await this.googleService.fetchGoogleJson<DriveFile>(
      this.account,
      endpoint,
      {
        method,
        headers: {"Content-Type": `multipart/related; boundary=${boundary}`},
        body,
      },
      existingFileId ? "update Google Drive file" : "create Google Drive file",
    );
  }

  async writeFile(filePath: string, content: string | Buffer): Promise<boolean> {
    const components = this.pathToComponents(filePath);
    if (components.length === 0) throw new Error("Cannot write to the Google Drive root as a file.");

    const fileName = components.pop()!;
    const parentPath = components.join("/");
    const parentResolved = await this.resolvePathToId(parentPath, true);
    if (!parentResolved.item || parentResolved.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Parent path ${parentPath} is not a folder or could not be created.`);
    }

    const existingFile = await this.findFileOrFolder(fileName, parentResolved.fileId!);
    if (existingFile?.mimeType === DRIVE_FOLDER_MIME) {
      throw new Error(`Cannot overwrite folder '${filePath}' with a file.`);
    }

    await this.uploadFile(parentResolved.fileId!, fileName, content, existingFile?.id);
    this.invalidateCache();
    return true;
  }

  async appendFile(filePath: string, finalContent: string | Buffer): Promise<boolean> {
    const existing = await this.readFile(filePath);
    const appendBuffer = Buffer.isBuffer(finalContent) ? finalContent : Buffer.from(finalContent, "utf8");
    const nextContent = existing ? Buffer.concat([existing, appendBuffer]) : appendBuffer;
    return await this.writeFile(filePath, nextContent);
  }

  async deleteFile(filePath: string): Promise<boolean> {
    const resolved = await this.resolvePathToId(filePath);
    if (!resolved.fileId) throw new Error(`Cannot delete, path not found: ${filePath}`);

    await this.googleService.fetchGoogleRaw(
      this.account,
      `https://www.googleapis.com/drive/v3/files/${resolved.fileId}?supportsAllDrives=true`,
      {method: "DELETE"},
      "delete Google Drive file",
    );
    this.invalidateCache();
    return true;
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    const resolved = await this.resolvePathToId(filePath);
    if (!resolved.item || resolved.item.mimeType === DRIVE_FOLDER_MIME) return null;

    const response = await this.googleService.fetchGoogleRaw(
      this.account,
      `https://www.googleapis.com/drive/v3/files/${resolved.fileId}?alt=media&supportsAllDrives=true`,
      {method: "GET"},
      "read Google Drive file",
    );

    return Buffer.from(await response.arrayBuffer());
  }

  async rename(oldPath: string, newPath: string): Promise<boolean> {
    const resolvedOld = await this.resolvePathToId(oldPath);
    if (!resolvedOld.item) throw new Error(`Source path does not exist: ${oldPath}`);

    const components = this.pathToComponents(newPath);
    const newFileName = components.pop();
    if (!newFileName) throw new Error("Destination path is required");

    const newParentPath = components.join("/");
    const resolvedNewParent = await this.resolvePathToId(newParentPath, true);
    if (!resolvedNewParent.item || resolvedNewParent.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Destination parent path is not a folder or cannot be created: ${newParentPath}`);
    }

    const url = new URL(`https://www.googleapis.com/drive/v3/files/${resolvedOld.fileId}`);
    url.searchParams.set("supportsAllDrives", "true");
    const oldParentId = resolvedOld.item.parents?.[0];
    if (resolvedNewParent.fileId && oldParentId && oldParentId !== resolvedNewParent.fileId) {
      url.searchParams.set("addParents", resolvedNewParent.fileId);
      url.searchParams.set("removeParents", oldParentId);
    } else if (resolvedNewParent.fileId && !oldParentId && resolvedNewParent.fileId !== this.rootFolderId) {
      url.searchParams.set("addParents", resolvedNewParent.fileId);
    }
    url.searchParams.set("fields", "id,name,mimeType,parents,size,createdTime,modifiedTime");

    await this.googleService.fetchGoogleJson<DriveFile>(
      this.account,
      url.toString(),
      {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: newFileName}),
      },
      "rename Google Drive file",
    );

    this.invalidateCache();
    return true;
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.resolvePathToId(filePath)).item != null;
  }

  async stat(filePath: string): Promise<StatLike> {
    const normalizedPath = this.normalizePath(filePath);
    const resolved = await this.resolvePathToId(normalizedPath);
    if (!resolved.item) {
      return {exists: false, path: normalizedPath};
    }

    return {
      exists: true,
      path: normalizedPath,
      isFile: resolved.item.mimeType !== DRIVE_FOLDER_MIME,
      isDirectory: resolved.item.mimeType === DRIVE_FOLDER_MIME,
      size: resolved.item.size ? Number.parseInt(resolved.item.size, 10) : 0,
      created: resolved.item.createdTime ? new Date(resolved.item.createdTime) : undefined,
      modified: resolved.item.modifiedTime ? new Date(resolved.item.modifiedTime) : undefined,
    };
  }

  async createDirectory(dirPath: string, options: {recursive?: boolean} = {}): Promise<boolean> {
    const components = this.pathToComponents(dirPath);
    if (components.length === 0) return true;

    const dirName = components.pop()!;
    const parentPath = components.join("/");
    const resolvedParent = await this.resolvePathToId(parentPath, options.recursive ?? false);
    if (!resolvedParent.item || resolvedParent.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Parent path is not a folder or does not exist: ${parentPath}`);
    }

    const existingItem = await this.findFileOrFolder(dirName, resolvedParent.fileId!);
    if (existingItem) {
      if (existingItem.mimeType === DRIVE_FOLDER_MIME) return true;
      throw new Error(`A file with the name '${dirName}' already exists in this location and is not a folder.`);
    }

    await this.createFolder(dirName, resolvedParent.fileId!);
    this.invalidateCache();
    return true;
  }

  async copy(source: string, destination: string, options: {overwrite?: boolean} = {}): Promise<boolean> {
    const sourceResolved = await this.resolvePathToId(source);
    if (!sourceResolved.item || sourceResolved.item.mimeType === DRIVE_FOLDER_MIME) {
      throw new Error(`Source is not a file or does not exist: ${source}`);
    }

    const components = this.pathToComponents(destination);
    const destFileName = components.pop();
    if (!destFileName) throw new Error("Destination path is required");
    const destParentPath = components.join("/");
    const destParentResolved = await this.resolvePathToId(destParentPath, true);
    if (!destParentResolved.item || destParentResolved.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Destination parent path is not a folder or could not be created: ${destParentPath}`);
    }

    const existingDestItem = await this.findFileOrFolder(destFileName, destParentResolved.fileId!);
    if (existingDestItem && !options.overwrite) {
      throw new Error(`Destination path already exists and overwrite is false: ${destination}`);
    }
    if (existingDestItem && options.overwrite) {
      await this.googleService.fetchGoogleRaw(
        this.account,
        `https://www.googleapis.com/drive/v3/files/${existingDestItem.id}?supportsAllDrives=true`,
        {method: "DELETE"},
        "overwrite Google Drive destination",
      );
    }

    await this.googleService.fetchGoogleJson<DriveFile>(
      this.account,
      `https://www.googleapis.com/drive/v3/files/${sourceResolved.fileId}/copy?fields=id,name,mimeType,parents,size,createdTime,modifiedTime&supportsAllDrives=true`,
      {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          name: destFileName,
          parents: [destParentResolved.fileId],
        }),
      },
      "copy Google Drive file",
    );

    this.invalidateCache();
    return true;
  }

  async glob(_pattern: string, _options?: GlobOptions): Promise<string[]> {
    throw new Error("Method glob is not supported by GoogleDriveFileSystemProvider.");
  }

  async watch(_dir: string, _options?: WatchOptions): Promise<any> {
    throw new Error("Method watch is not supported by GoogleDriveFileSystemProvider.");
  }

  async grep(_searchString: string | string[], _options?: GrepOptions): Promise<GrepResult[]> {
    throw new Error("Method grep is not supported by GoogleDriveFileSystemProvider.");
  }

  async *getDirectoryTree(path: string, params?: DirectoryTreeOptions): AsyncGenerator<string> {
    const normalizedPath = this.normalizePath(path);
    const ignoreFilter = params?.ignoreFilter ?? (() => false);
    const recursive = params?.recursive ?? true;
    const resolved = await this.resolvePathToId(normalizedPath);
    if (!resolved.item || resolved.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Path is not a folder or does not exist: ${path}`);
    }

    for (const child of await this.listChildren(resolved.fileId!)) {
      const childPath = normalizedPath ? `${normalizedPath}/${child.name}` : child.name;
      const yieldedPath = child.mimeType === DRIVE_FOLDER_MIME ? `${childPath}/` : childPath;
      if (ignoreFilter(yieldedPath)) continue;
      yield yieldedPath;
      if (recursive && child.mimeType === DRIVE_FOLDER_MIME) {
        yield* this.getDirectoryTree(childPath, params);
      }
    }
  }
}
