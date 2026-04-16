import type {DirectoryTreeOptions, FileSystemProvider, GrepOptions, GrepResult, StatLike, WatchOptions} from "@tokenring-ai/filesystem/FileSystemProvider";
import type {z} from "zod";
import type GoogleService from "./GoogleService.ts";
import type {GoogleDriveFileSystemProviderOptionsSchema} from "./schema.ts";

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
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export default class GoogleDriveFileSystemProvider
  implements FileSystemProvider {
  readonly name = "GoogleDriveFileSystemProvider";
  description: string;

  private readonly account: string;
  private readonly rootFolderId: string;
  private readonly idCache = new Map<string, DriveFile | ResolvedPath>();

  constructor(
    readonly options: z.output<
      typeof GoogleDriveFileSystemProviderOptionsSchema
    >,
    private readonly googleService: GoogleService,
  ) {
    this.description = options.description;
    this.account = options.account;
    this.rootFolderId = options.rootFolderId;
  }

  async writeFile(
    filePath: string,
    content: string | Buffer,
  ): Promise<boolean> {
    const components = this.pathToComponents(filePath);
    const fileName = components.pop();
    if (!fileName) {
      throw new Error("Cannot write to the Google Drive root as a file.");
    }
    const parentPath = components.join("/");
    const parentResolved = await this.resolvePathToId(parentPath, true);
    if (
      !parentResolved.item ||
      !parentResolved.fileId ||
      parentResolved.item.mimeType !== DRIVE_FOLDER_MIME
    ) {
      throw new Error(
        `Parent path ${parentPath} is not a folder or could not be created.`,
      );
    }
    const {fileId: parentFileId} = parentResolved;

    const existingFile = await this.findFileOrFolder(fileName, parentFileId);
    if (existingFile?.mimeType === DRIVE_FOLDER_MIME) {
      throw new Error(`Cannot overwrite folder '${filePath}' with a file.`);
    }

    await this.uploadFile(parentFileId, fileName, content, existingFile?.id);
    this.invalidateCache();
    return true;
  }

  async appendFile(
    filePath: string,
    finalContent: string | Buffer,
  ): Promise<boolean> {
    const existing = await this.readFile(filePath);
    const appendBuffer = Buffer.isBuffer(finalContent)
      ? finalContent
      : Buffer.from(finalContent, "utf8");
    const nextContent = existing
      ? Buffer.concat([existing, appendBuffer])
      : appendBuffer;
    return await this.writeFile(filePath, nextContent);
  }

  async deleteFile(filePath: string): Promise<boolean> {
    const resolved = await this.resolvePathToId(filePath);
    if (!resolved.fileId) {
      throw new Error(`Cannot delete, path not found: ${filePath}`);
    }

    await this.googleService.withDrive(
      this.account,
      {
        context: "delete Google Drive file",
        method: "DELETE",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        await drive.files.delete({
          fileId: resolved.fileId!,
          supportsAllDrives: true,
        });
      },
    );
    this.invalidateCache();
    return true;
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    const resolved = await this.resolvePathToId(filePath);
    if (!resolved.item || resolved.item.mimeType === DRIVE_FOLDER_MIME) {
      return null;
    }

    return await this.googleService.withDrive<Buffer>(
      this.account,
      {
        context: "read Google Drive file",
        method: "GET",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const response = await drive.files.get(
          {
            alt: "media",
            fileId: resolved.item!.id,
            supportsAllDrives: true,
          },
          {responseType: "arraybuffer"},
        );

        return this.toBuffer(response.data);
      },
    );
  }

  async rename(oldPath: string, newPath: string): Promise<boolean> {
    const resolvedOld = await this.resolvePathToId(oldPath);
    if (!resolvedOld.item) {
      throw new Error(`Source path does not exist: ${oldPath}`);
    }

    const components = this.pathToComponents(newPath);
    const newFileName = components.pop();
    if (!newFileName) throw new Error("Destination path is required");

    const newParentPath = components.join("/");
    const resolvedNewParent = await this.resolvePathToId(newParentPath, true);
    if (
      !resolvedNewParent.item ||
      resolvedNewParent.item.mimeType !== DRIVE_FOLDER_MIME
    ) {
      throw new Error(
        `Destination parent path is not a folder or cannot be created: ${newParentPath}`,
      );
    }

    const oldParentId = resolvedOld.item.parents?.[0];
    let addParents: string | undefined;
    let removeParents: string | undefined;
    if (
      resolvedNewParent.fileId &&
      oldParentId &&
      oldParentId !== resolvedNewParent.fileId
    ) {
      addParents = resolvedNewParent.fileId;
      removeParents = oldParentId;
    } else if (
      resolvedNewParent.fileId &&
      !oldParentId &&
      resolvedNewParent.fileId !== this.rootFolderId
    ) {
      addParents = resolvedNewParent.fileId;
    }

    await this.googleService.withDrive<DriveFile>(
      this.account,
      {
        context: "rename Google Drive file",
        method: "PATCH",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const {data} = await drive.files.update({
          addParents,
          fields: "id,name,mimeType,parents,size,createdTime,modifiedTime",
          fileId: resolvedOld.item!.id,
          removeParents,
          requestBody: {name: newFileName},
          supportsAllDrives: true,
        });
        return data as DriveFile;
      },
    );

    this.invalidateCache();
    return true;
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
      created: resolved.item.createdTime
        ? new Date(resolved.item.createdTime)
        : undefined,
      modified: resolved.item.modifiedTime
        ? new Date(resolved.item.modifiedTime)
        : undefined,
    };
  }

  async createDirectory(
    dirPath: string,
    options: { recursive?: boolean } = {},
  ): Promise<boolean> {
    const components = this.pathToComponents(dirPath);
    if (components.length === 0) return true;

    const dirName = components.pop();
    if (!dirName) return true;
    const parentPath = components.join("/");
    const resolvedParent = await this.resolvePathToId(
      parentPath,
      options.recursive ?? false,
    );
    if (
      !resolvedParent.item ||
      !resolvedParent.fileId ||
      resolvedParent.item.mimeType !== DRIVE_FOLDER_MIME
    ) {
      throw new Error(
        `Parent path is not a folder or does not exist: ${parentPath}`,
      );
    }
    const {fileId: parentFileId} = resolvedParent;

    const existingItem = await this.findFileOrFolder(dirName, parentFileId);
    if (existingItem) {
      if (existingItem.mimeType === DRIVE_FOLDER_MIME) return true;
      throw new Error(
        `A file with the name '${dirName}' already exists in this location and is not a folder.`,
      );
    }

    await this.createFolder(dirName, parentFileId);
    this.invalidateCache();
    return true;
  }

  async copy(
    source: string,
    destination: string,
    options: { overwrite?: boolean } = {},
  ): Promise<boolean> {
    const sourceResolved = await this.resolvePathToId(source);
    if (
      !sourceResolved.item ||
      sourceResolved.item.mimeType === DRIVE_FOLDER_MIME
    ) {
      throw new Error(`Source is not a file or does not exist: ${source}`);
    }

    const components = this.pathToComponents(destination);
    const destFileName = components.pop();
    if (!destFileName) throw new Error("Destination path is required");
    const destParentPath = components.join("/");
    const destParentResolved = await this.resolvePathToId(destParentPath, true);
    if (
      !destParentResolved.item ||
      !destParentResolved.fileId ||
      destParentResolved.item.mimeType !== DRIVE_FOLDER_MIME
    ) {
      throw new Error(
        `Destination parent path is not a folder or could not be created: ${destParentPath}`,
      );
    }
    const {fileId: destParentFileId} = destParentResolved;

    const existingDestItem = await this.findFileOrFolder(
      destFileName,
      destParentFileId,
    );
    if (existingDestItem && !options.overwrite) {
      throw new Error(
        `Destination path already exists and overwrite is false: ${destination}`,
      );
    }
    if (existingDestItem && options.overwrite) {
      await this.googleService.withDrive(
        this.account,
        {
          context: "overwrite Google Drive destination",
          method: "DELETE",
          requiredScopes: [GOOGLE_DRIVE_SCOPE],
        },
        async (drive) => {
          await drive.files.delete({
            fileId: existingDestItem.id,
            supportsAllDrives: true,
          });
        },
      );
    }

    await this.googleService.withDrive<DriveFile>(
      this.account,
      {
        context: "copy Google Drive file",
        method: "POST",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const {data} = await drive.files.copy({
          fields: "id,name,mimeType,parents,size,createdTime,modifiedTime",
          fileId: sourceResolved.item!.id,
          requestBody: {
            name: destFileName,
            parents: [destParentFileId],
          },
          supportsAllDrives: true,
        });
        return data as DriveFile;
      },
    );

    this.invalidateCache();
    return true;
  }

  watch(_dir: string, _options?: WatchOptions) {
    throw new Error(
      "Method watch is not supported by GoogleDriveFileSystemProvider.",
    );
  }

  grep(
    _searchString: string | string[],
    _options?: GrepOptions,
  ): Promise<GrepResult[]> {
    throw new Error(
      "Method grep is not supported by GoogleDriveFileSystemProvider.",
    );
  }

  async* getDirectoryTree(
    path: string,
    params?: DirectoryTreeOptions,
  ): AsyncGenerator<string> {
    const normalizedPath = this.normalizePath(path);
    const ignoreFilter = params?.ignoreFilter ?? (() => false);
    const recursive = params?.recursive ?? true;
    const resolved = await this.resolvePathToId(normalizedPath);
    if (!resolved.item || resolved.item.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(`Path is not a folder or does not exist: ${path}`);
    }

    if (resolved.fileId) {
      for (const child of await this.listChildren(resolved.fileId)) {
        const childPath = normalizedPath
          ? `${normalizedPath}/${child.name}`
          : child.name;
        const yieldedPath =
          child.mimeType === DRIVE_FOLDER_MIME ? `${childPath}/` : childPath;
        if (ignoreFilter(yieldedPath)) continue;
        yield yieldedPath;
        if (recursive && child.mimeType === DRIVE_FOLDER_MIME) {
          yield* this.getDirectoryTree(childPath, params);
        }
      }
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.resolvePathToId(filePath)).item != null;
  }

  private normalizePath(filePath: string): string {
    return this.pathToComponents(filePath).join("/");
  }

  private invalidateCache(): void {
    this.idCache.clear();
  }

  private pathToComponents(filePath: string): string[] {
    return filePath
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((part) => part && part !== ".");
  }

  private async findFileOrFolder(
    name: string,
    parentId: string,
    mimeType?: string,
  ): Promise<DriveFile | null> {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    let query = `name='${escapedName}' and '${parentId}' in parents and trashed=false`;
    if (mimeType) query += ` and mimeType='${mimeType}'`;

    const response = await this.googleService.withDrive<DriveListResponse>(
      this.account,
      {
        context: "find Google Drive file",
        method: "GET",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const {data} = await drive.files.list({
          fields: "files(id,name,mimeType,parents,size,createdTime,modifiedTime)",
          includeItemsFromAllDrives: true,
          pageSize: 1,
          q: query,
          supportsAllDrives: true,
        });
        return data as DriveListResponse;
      },
    );

    return response.files?.[0] ?? null;
  }

  private async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.googleService.withDrive<DriveListResponse>(
        this.account,
        {
          context: "list Google Drive folder",
          method: "GET",
          requiredScopes: [GOOGLE_DRIVE_SCOPE],
        },
        async (drive) => {
          const {data} = await drive.files.list({
            fields:
              "nextPageToken,files(id,name,mimeType,parents,size,createdTime,modifiedTime)",
            includeItemsFromAllDrives: true,
            pageSize: 200,
            pageToken,
            q: `'${parentId}' in parents and trashed=false`,
            supportsAllDrives: true,
          });
          return data as DriveListResponse;
        },
      );

      files.push(...(response.files ?? []));
      pageToken = response.nextPageToken;
    } while (pageToken);

    return files;
  }

  private async resolvePathToId(
    filePath: string,
    createMissingFolders = false,
  ): Promise<ResolvedPath> {
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
        currentItem = await this.findFileOrFolder(
          component,
          currentParentId,
          isLastComponent ? undefined : DRIVE_FOLDER_MIME,
        );
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

  private async createFolder(
    name: string,
    parentId: string,
  ): Promise<DriveFile> {
    return await this.googleService.withDrive<DriveFile>(
      this.account,
      {
        context: "create Google Drive folder",
        method: "POST",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const {data} = await drive.files.create({
          fields: "id,name,mimeType,parents,size,createdTime,modifiedTime",
          requestBody: {
            mimeType: DRIVE_FOLDER_MIME,
            name,
            parents: [parentId],
          },
          supportsAllDrives: true,
        });
        return data as DriveFile;
      },
    );
  }

  private async uploadFile(
    parentId: string,
    fileName: string,
    content: string | Buffer,
    existingFileId?: string,
  ): Promise<DriveFile> {
    const fileBuffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, "utf8");

    return await this.googleService.withDrive<DriveFile>(
      this.account,
      {
        context: existingFileId
          ? "update Google Drive file"
          : "create Google Drive file",
        method: existingFileId ? "PATCH" : "POST",
        requiredScopes: [GOOGLE_DRIVE_SCOPE],
      },
      async (drive) => {
        const requestBody = {
          name: fileName,
          parents: [parentId],
        };

        if (existingFileId) {
          const {data} = await drive.files.update({
            fields: "id,name,mimeType,parents,size,createdTime,modifiedTime",
            fileId: existingFileId,
            media: {
              body: fileBuffer,
              mimeType: "application/octet-stream",
            },
            requestBody,
            supportsAllDrives: true,
          });
          return data as DriveFile;
        }

        const {data} = await drive.files.create({
          fields: "id,name,mimeType,parents,size,createdTime,modifiedTime",
          media: {
            body: fileBuffer,
            mimeType: "application/octet-stream",
          },
          requestBody,
          supportsAllDrives: true,
        });
        return data as DriveFile;
      },
    );
  }

  private toBuffer(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === "string") return Buffer.from(value, "utf8");
    return Buffer.from([]);
  }
}
