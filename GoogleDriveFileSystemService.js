// packages/extra/google/services/GoogleDriveFileSystem.js
import {FileSystemService} from '@token-ring/filesystem';
import GoogleService from './GoogleService.js';
// Drive client will be obtained from GoogleService.
// import { drive_v3 } from 'googleapis';

export default class GoogleDriveFileSystemService extends FileSystemService {
  name = "GoogleDriveFileSystemService";
  description = "Provides FileSystem interface for Google Drive";

  static constructorProperties = {
    googleServiceInstanceName: {
      type: "string",
      required: true,
      description: "The name of the configured GoogleService instance in the registry."
    },
    rootFolderId: {
      type: "string",
      required: false,
      default: "root",
      description: "The ID of the Google Drive folder to use as the root. Defaults to 'root'."
    },
    defaultSelectedFiles: {
      type: "array",
      required: false,
      description: "Google Drive file paths (relative to rootFolderId) selected by default.",
      default: []
    }
  };

  constructor({ googleServiceInstanceName, rootFolderId = 'root', defaultSelectedFiles, registry }) {
    super({ defaultSelectedFiles }); // Pass to parent constructor

    if (!registry) {
      throw new Error("GoogleDriveFileSystem constructor requires a 'registry' instance.");
    }
    if (!googleServiceInstanceName) {
      throw new Error("GoogleDriveFileSystem requires a 'googleServiceInstanceName'.");
    }

    this.googleServiceInstanceName = googleServiceInstanceName;
    this.registry = registry;
    this.rootFolderId = rootFolderId; // ID of the root folder in Drive, e.g., 'root' or a specific folder ID

    this.driveClient = null; // Will be initialized
    this._idCache = new Map(); // Cache for resolved path -> ID mappings
  }

  /**
   * Helper to get the GoogleService and Drive API client.
   */
  _getDriveClient() {
    if (this.driveClient) {
      return this.driveClient;
    }
    const googleService = this.registry.getService(this.googleServiceInstanceName);
    if (!googleService || !(googleService instanceof GoogleService)) {
      throw new Error(`GoogleService instance '${this.googleServiceInstanceName}' not found or is not of the correct type.`);
    }

    this.driveClient = googleService.getDriveClient(); // Assuming this method now exists and returns Drive API client
    if (!this.driveClient) {
      throw new Error('Failed to get Drive API client from GoogleService.');
    }
    return this.driveClient;
  }

  _pathToComponents(filePath) {
    if (typeof filePath !== 'string') {
        throw new Error('File path must be a string.');
    }
    // Normalize: remove leading/trailing slashes, split by slash, filter out empty strings from multiple slashes e.g. path//folder
    return filePath.replace(/^\/+|\/+$/g, '').split('/').filter(p => p && p !== '.' && p !== '');
  }

  _invalidateCache(filePath) {
    // Invalidate specific path and potentially parent paths or clear all for simplicity
    // For now, clear all as a simple strategy. More granular invalidation is an optimization.
    this._idCache.clear();
    // If filePath is provided, could try to remove specific entries:
    // if (filePath) {
    //   const fullPathKey = `path:${filePath}`;
    //   this._idCache.delete(fullPathKey);
    //   // Consider invalidating parent directory listings if those are cached differently
    // }
  }

  async _findFileOrFolder(name, parentId, mimeType = null) {
    const drive = this._getDriveClient();
    // Names with single quotes need to be escaped by doubling the quote or using backslash.
    // The googleapis library examples usually show simple concatenation,
    // but for robustness, escaping special characters like ' and \ is important.
    const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let query = `name='${escapedName}' and '${parentId}' in parents and trashed=false`;
    if (mimeType) {
      query += ` and mimeType='${mimeType}'`;
    }
    try {
      const response = await drive.files.list({
        q: query,
        fields: 'files(id, name, mimeType, parents, size, modifiedTime, capabilities)', // Added more fields
        pageSize: 1, // We only need one if it exists by this unique name in parent
      });
      if (response.data.files && response.data.files.length > 0) {
        return response.data.files[0];
      }
      return null;
    } catch (error) {
      // console.error(`Error finding file/folder '${name}' in parent '${parentId}':`, error.message);
      // Re-throwing might be better to let caller decide on 404s vs other errors
      if (error.code === 404) return null; // If parentId itself is not found, GDrive API might return 404 on list.
      throw error;
    }
  }

  async _resolvePathToId(filePath, createMissingFolders = false) {
    const components = this._pathToComponents(filePath);
    if (components.length === 0) { // Root path
      return { fileId: this.rootFolderId, parentId: null, fileName: '', item: { id: this.rootFolderId, mimeType: 'application/vnd.google-apps.folder', name: 'Root', capabilities: {canAddChildren: true} } };
    }

    const fullPathKey = `path:${filePath}`; // Cache key for the full resolution result
    if (this._idCache.has(fullPathKey)) {
      const cachedResult = this._idCache.get(fullPathKey);
      // Ensure cached item is still valid (e.g. not deleted or type changed) by a quick check if needed, or rely on TTL/invalidation.
      // For now, just return cached.
      return cachedResult;
    }

    let currentParentId = this.rootFolderId;
    let currentItem = null; // This will hold the Drive API file object for the current component

    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      const isLastComponent = i === components.length - 1;

      // Try to get item (folder or file) from cache if not the last component (for files, we always fetch fresh unless full path is cached)
      const componentCacheKey = `id:${currentParentId}->${component}`; // Cache key for component within a parent
      if (this._idCache.has(componentCacheKey)) {
          currentItem = this._idCache.get(componentCacheKey);
      } else {
          // Determine expected mimeType for _findFileOrFolder. For the last component, we don't know yet if it's a file or folder.
          const expectedMimeType = isLastComponent ? null : 'application/vnd.google-apps.folder';
          currentItem = await this._findFileOrFolder(component, currentParentId, expectedMimeType);
          if (currentItem) {
            this._idCache.set(componentCacheKey, currentItem); // Cache found item (folder or file)
          }
      }

      if (!currentItem) {
        if (createMissingFolders && !isLastComponent) { // Create missing intermediate folder
          const drive = this._getDriveClient();
          const newFolder = await drive.files.create({
            requestBody: {
              name: component,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [currentParentId],
            },
            fields: 'id, name, mimeType, parents, capabilities',
          });
          currentItem = newFolder.data;
          this._idCache.set(componentCacheKey, currentItem); // Cache newly created folder
        } else {
          // If not creating, or it's the last component and not found
          return { fileId: null, parentId: currentParentId, fileName: component, item: null };
        }
      }

      // If it's not the last component, it must be a folder to continue
      if (!isLastComponent) {
          if (currentItem.mimeType !== 'application/vnd.google-apps.folder') {
               // Expected a folder, but found a file with the same name. Path is invalid.
               return { fileId: null, parentId: currentParentId, fileName: component, item: null };
          }
          currentParentId = currentItem.id; // Move to next level
      }
    }

    // currentItem now refers to the item for the last component of the path
    const result = {
        fileId: currentItem ? currentItem.id : null,
        // If currentItem is null (last component not found), parentId is the ID of the folder where it would be.
        // If currentItem exists, its parent is currentParentId (which was updated unless it's a single-component path).
        parentId: components.length === 1 ? this.rootFolderId : currentParentId,
        fileName: components[components.length - 1],
        item: currentItem
    };

    if (currentItem) { // Only cache the full path resolution if the item was actually found
      this._idCache.set(fullPathKey, result);
    }
    return result;
  }

  async writeFile(filePath, content) {
    const drive = this._getDriveClient();
    // Create missing folders up to the parent of the file.
    const components = this._pathToComponents(filePath);
    if (components.length === 0) throw new Error("Cannot write to root as a file.");

    const fileName = components.pop();
    const parentPath = components.join('/');

    const parentResolved = await this._resolvePathToId(parentPath, true); // createMissingFolders = true for parent
    if (!parentResolved.item || parentResolved.item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Parent path ${parentPath} is not a folder or could not be created.`);
    }
    const parentId = parentResolved.fileId;

    // Check if file already exists in this parent
    const existingFile = await this._findFileOrFolder(fileName, parentId);

    this._invalidateCache(filePath); // Invalidate before write
    if (existingFile) { // File exists, update it
      if (existingFile.mimeType === 'application/vnd.google-apps.folder') {
        throw new Error(`Cannot overwrite folder '${filePath}' with a file.`);
      }
      await drive.files.update({
        fileId: existingFile.id,
        media: { body: content },
      });
      return true;
    } else { // File does not exist, create it
      await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [parentId],
        },
        media: { body: content },
        fields: 'id', // Request 'id' to confirm creation
      });
      return true;
    }
  }

  async getFile(filePath) {
    const drive = this._getDriveClient();
    const resolved = await this._resolvePathToId(filePath);
    if (!resolved.item || resolved.item.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error(`File not found or is a folder: ${filePath}`);
    }
    const response = await drive.files.get({
      fileId: resolved.fileId,
      alt: 'media',
    }, { responseType: 'stream' }); // Get as stream

    return new Promise((resolve, reject) => {
      const chunks = [];
      response.data.on('data', chunk => chunks.push(chunk));
      response.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.data.on('error', reject);
    });
  }

  async deleteFile(filePath) {
    const drive = this._getDriveClient();
    const resolved = await this._resolvePathToId(filePath);
    if (!resolved.item) {
      // File or folder not found, arguably delete should succeed (idempotency) or throw.
      // Let's be strict for now and require it to exist.
      throw new Error(`Cannot delete, path not found: ${filePath}`);
    }
    // Note: Deleting a folder in Drive typically requires it to be empty unless using specific admin SDKs or settings.
    // This basic delete works for files and can also remove folders if they are empty (or sometimes if not, depending on API version/behavior).
    await drive.files.delete({ fileId: resolved.fileId });
    this._invalidateCache(filePath);
    // also invalidate parent if we cache directory listings
    const parentPath = this._pathToComponents(filePath).slice(0, -1).join('/');
    this._invalidateCache(parentPath);
    return true;
  }

  async exists(filePath) {
    const resolved = await this._resolvePathToId(filePath);
    return !!resolved.item;
  }

  async stat(filePath) {
    const resolved = await this._resolvePathToId(filePath);
    if (!resolved.item) {
      throw new Error(`Path not found: ${filePath}`);
    }
    const item = resolved.item;
    const isDirectory = item.mimeType === 'application/vnd.google-apps.folder';

    return {
      path: filePath,
      isFile: !isDirectory,
      isDirectory: isDirectory,
      size: isDirectory ? 0 : parseInt(item.size, 10) || 0, // size might be missing for some GDoc types
      modified: item.modifiedTime ? new Date(item.modifiedTime) : new Date(), // GDocs might not have size/modtime in list
      // Google Drive specific details (optional but can be useful)
      fileId: item.id,
      mimeType: item.mimeType,
      capabilities: item.capabilities,
    };
  }

  async copy(sourceFilePath, destinationFilePath, options = {}) {
    const drive = this._getDriveClient();
    const sourceResolved = await this._resolvePathToId(sourceFilePath);
    if (!sourceResolved.item || sourceResolved.item.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error(`Source is not a file or does not exist: ${sourceFilePath}`);
    }

    const destComponents = this._pathToComponents(destinationFilePath);
    const destFileName = destComponents.pop();
    const destParentPath = destComponents.join('/');

    // Ensure destination parent folder exists, create if necessary
    const destParentResolved = await this._resolvePathToId(destParentPath, true);
    if (!destParentResolved.item || destParentResolved.item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Destination parent path is not a folder or could not be created: ${destParentPath}`);
    }
    const destinationParentId = destParentResolved.fileId;

    // Check if a file/folder with the same name already exists in the destination
    const existingDestItem = await this._findFileOrFolder(destFileName, destinationParentId);
    if (existingDestItem && !options.overwrite) {
        throw new Error(`Destination path already exists and overwrite is false: ${destinationFilePath}`);
    }
    if (existingDestItem && options.overwrite) { // If overwrite is true, delete existing item first.
        if(existingDestItem.mimeType === 'application/vnd.google-apps.folder' && !sourceResolved.item.mimeType === 'application/vnd.google-apps.folder') {
             throw new Error(`Cannot overwrite a folder with a file: ${destinationFilePath}`);
        }
        // For simplicity, if it's a file or empty folder, Drive's copy with new name might handle it,
        // but explicit deletion is safer if overwriting a different type or non-empty folder.
        // GDrive copy usually creates a new file with "(1)" if name conflicts, unless new name is specified.
        // Here we are specifying the name, so it might replace.
        // For true overwrite, one might delete existingDestItem.id first.
        // For now, let's assume google.files.copy handles this by creating a new version or replacing.
    }


    const copiedFile = await drive.files.copy({
      fileId: sourceResolved.fileId,
      requestBody: {
        name: destFileName,
        parents: [destinationParentId],
      },
      fields: 'id', // Request 'id' to confirm copy
    });

    this._invalidateCache(destinationFilePath);
    return !!copiedFile.data.id;
  }

  async *getDirectoryTree(folderPath, params = {}) {
    const { ig /*, recursive = true */ } = params;
    const drive = this._getDriveClient();

    const resolvedPath = await this._resolvePathToId(folderPath);
    if (!resolvedPath.item || resolvedPath.item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Path is not a folder or does not exist: ${folderPath}`);
    }
    const folderId = resolvedPath.fileId;

    const ignoreFilter = ig || (await super.createIgnoreFilter());
    let pageToken = null;

    do {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 200, // Adjust as needed, max 1000
        pageToken: pageToken,
      });

      const files = response.data.files;
      if (files) {
        for (const file of files) {
          // Construct the relative path for the ignore filter and for yielding
          const normalizedFolderPath = folderPath.replace(/^\/+|\/+$/g, '');
          const relativeFilePath = (normalizedFolderPath === '') ? file.name : `${normalizedFolderPath}/${file.name}`;
          if (!ignoreFilter(relativeFilePath)) {
            yield relativeFilePath;
          }
        }
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);
  }

  async createDirectory(folderPath, options = {}) {
    const drive = this._getDriveClient();
    const components = this._pathToComponents(folderPath);
    if (components.length === 0) return true; // Root folder already exists

    const newDirName = components.pop();
    const parentPath = components.join('/');

    // Resolve parent path. If parentPath is empty string, it means newDirName is directly under rootFolderId.
    const resolvedParent = await this._resolvePathToId(parentPath, true); // Create missing parent folders

    if (!resolvedParent.item || resolvedParent.item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Parent path is not a folder or does not exist: ${parentPath}`);
    }
    const parentId = resolvedParent.fileId;

    // Check if the directory/file already exists
    const existingItem = await this._findFileOrFolder(newDirName, parentId);
    if (existingItem) {
      if (existingItem.mimeType === 'application/vnd.google-apps.folder') {
        this._idCache.set(`path:${folderPath}`, { fileId: existingItem.id, parentId: parentId, fileName: newDirName, item: existingItem });
        return true; // Directory already exists
      } else {
        throw new Error(`A file with the name '${newDirName}' already exists in this location and is not a folder.`);
      }
    }

    const createdFile = await drive.files.create({
      requestBody: {
        name: newDirName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id, name, mimeType, parents, capabilities', // fetch the full item to cache
    });

    // Cache the newly created directory
    this._invalidateCache(folderPath); // Clear general cache first
    this._idCache.set(`path:${folderPath}`, { fileId: createdFile.data.id, parentId: parentId, fileName: newDirName, item: createdFile.data });
    // Cache the component specific lookup too
    this._idCache.set(`id:${parentId}->${newDirName}`, createdFile.data);


    return true;
  }

  async rename(oldFilePath, newFilePath) {
    const drive = this._getDriveClient();

    const resolvedOld = await this._resolvePathToId(oldFilePath);
    if (!resolvedOld.item) {
      throw new Error(`Source path does not exist: ${oldFilePath}`);
    }
    const oldFileId = resolvedOld.fileId;
    // oldParentId is needed if we are moving across directories
    const oldParentId = resolvedOld.item.parents ? resolvedOld.item.parents[0] : null;

    const newPathComponents = this._pathToComponents(newFilePath);
    const newFileName = newPathComponents.pop();
    const newParentPath = newPathComponents.join('/');

    const resolvedNewParent = await this._resolvePathToId(newParentPath, true); // Create missing parent folders
    if (!resolvedNewParent.item || resolvedNewParent.item.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Destination parent path is not a folder or cannot be created: ${newParentPath}`);
    }
    const newParentId = resolvedNewParent.fileId;

    const requestBody = { name: newFileName };
    const params = {
        fileId: oldFileId,
        requestBody: requestBody,
        fields: 'id, name, parents' // Request necessary fields back
    };

    // If the parent folder ID is different, specify addParents and removeParents
    // Note: A file must always have at least one parent, so oldParentId should typically exist for non-root items.
    // If oldParentId is null, it implies the old file was in 'My Drive' (root) if rootFolderId is 'root'.
    // Or it was in a shared folder not directly traceable from rootFolderId without more complex logic.
    // For simplicity, if oldParentId is not available from resolvedOld.item.parents, we only set the name.
    if (oldParentId && newParentId !== oldParentId) {
      params.addParents = newParentId;
      params.removeParents = oldParentId;
    } else if (!oldParentId && newParentId !== this.rootFolderId && this.rootFolderId === 'root') {
      // Moving from root ('My Drive') to a specific folder.
      // If oldParentId was not part of resolvedOld.item.parents (e.g. if item was root itself, though that's handled)
      // or if item was directly in 'My Drive' and oldParentId was not explicitly fetched/stored.
      // For items in 'My Drive' (root), they don't have a parent ID in the `parents` array that points back to 'root'.
      // The `files.update` call to move to a new parent requires `addParents`. Removing from root is implicit.
      params.addParents = newParentId;
      // No removeParents needed if it was directly in 'My Drive' (root).
    }


    await drive.files.update(params);

    this._invalidateCache(oldFilePath); // Clear all cache entries for simplicity after move/rename
    this._invalidateCache(newFilePath); // Also invalidate new path representation
    // More granular cache invalidation would be complex here.

    return true;
  }

  async chown(path, uid, gid) {
    throw new Error('Method chown is not supported by GoogleDriveFileSystem.');
  }

  async chmod(path, mode) {
    throw new Error('Method chmod is not supported by GoogleDriveFileSystem.');
  }

  async watch(dir, options) {
    throw new Error('Method watch is not supported by GoogleDriveFileSystem. Consider Google Drive API push notifications.');
  }

  async executeCommand(command, options) {
    throw new Error('Method executeCommand is not supported by GoogleDriveFileSystem.');
  }

  async borrowFile(fileName, callback) {
    throw new Error('Method borrowFile is not supported by GoogleDriveFileSystem.');
  }

  async glob(pattern, options = {}) {
    throw new Error('Method glob is not fully supported by GoogleDriveFileSystem. Google Drive API supports file listing with queries, not glob patterns.');
  }

  async grep(searchString, options = {}) {
    // Drive API has 'fullText contains' in q param of files.list. This is closer than S3/GCS.
    // However, it's not a line-by-line grep.
    throw new Error('Method grep is not directly supported. Use Drive API search queries (e.g., via a dedicated tool or different method) for content searching.');
  }
}
