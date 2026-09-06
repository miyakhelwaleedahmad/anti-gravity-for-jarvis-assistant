/**
 * control/fileController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * File & directory management with folder containment safety and permission checks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { rollbackManager } from './rollbackManager.js';

export class FileController {
  private getApprovedFolders(): string[] {
    const home = os.homedir();
    return [
      path.resolve('W:\\anti gravity for jarvis assistant').toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
      path.resolve(path.join(home, 'Desktop')).toLowerCase(),
      path.resolve(path.join(home, 'Documents')).toLowerCase(),
      path.resolve(path.join(home, 'Downloads')).toLowerCase()
    ];
  }

  private isPathContained(targetPath: string): boolean {
    const resolved = path.resolve(targetPath).toLowerCase();
    
    // Protect system folders explicitly
    const systemFolders = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)'];
    for (const sys of systemFolders) {
      if (resolved.startsWith(sys)) return false;
    }

    const approved = this.getApprovedFolders();
    return approved.some(folder => resolved.startsWith(folder));
  }

  private ensureApproved(filePath: string, action: string): void {
    if (!this.isPathContained(filePath)) {
      throw new Error(`Access Denied: Path "${filePath}" is not allowed outside approved directories for action "${action}".`);
    }
  }

  public async searchFiles(query: string): Promise<string> {
    // Read-only, Level 1 safe. Search approved directories.
    const approved = this.getApprovedFolders();
    const matches: string[] = [];
    
    for (const dir of approved) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
          if (f.toLowerCase().includes(query.toLowerCase())) {
            matches.push(path.join(dir, f));
          }
        }
      } catch {}
    }

    return JSON.stringify(matches, null, 2);
  }

  public async readFile(filePath: string): Promise<string> {
    try {
      this.ensureApproved(filePath, 'readFile');
      // Prevent reading `.env` keys aloud or in stdout if it has sensitive info
      const content = await fs.promises.readFile(filePath, 'utf-8');
      if (filePath.endsWith('.env')) {
        return '(Protected Environment File Content)';
      }
      return content;
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  }

  public async writeFile(filePath: string, content: string): Promise<string> {
    this.ensureApproved(filePath, 'writeFile');
    
    const resolvedPath = path.resolve(filePath);
    const isTempTextWrite = resolvedPath.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()) && path.extname(resolvedPath).toLowerCase() === '.txt';

    // Level 2 (Full control) required to write files outside narrow temp text scratch files.
    if (!isTempTextWrite && !permissionSession.checkPermission(2, `Write file ${filePath}`)) {
      throw new Error('Permission Level 2 required to write files.');
    }

    // Risk level 3 check for source code / config files / .env
    const isSensitive = filePath.endsWith('.env') || filePath.endsWith('package.json') || filePath.includes('tsconfig') || /\.(ts|js|json|py)$/i.test(filePath);
    if (isSensitive) {
      const approved = await approvalGate.requestApproval('Write Sensitive File', `Modify: ${filePath}`);
      if (!approved) {
        throw new Error(`Write cancelled by user for sensitive file: ${filePath}`);
      }
    }

    // Rollback backup
    let exists = fs.existsSync(filePath);
    let originalContent = exists ? await fs.promises.readFile(filePath, 'utf-8') : null;

    await fs.promises.writeFile(filePath, content, 'utf-8');

    rollbackManager.register('write_file', `Undo write to ${filePath}`, async () => {
      if (originalContent !== null) {
        await fs.promises.writeFile(filePath, originalContent, 'utf-8');
      } else {
        await fs.promises.unlink(filePath);
      }
      return true;
    });

    return `File written successfully: ${filePath}`;
  }

  public async copyFile(source: string, destination: string): Promise<string> {
    this.ensureApproved(source, 'copyFile source');
    this.ensureApproved(destination, 'copyFile destination');

    if (!permissionSession.checkPermission(2, `Copy file ${source} -> ${destination}`)) {
      throw new Error('Permission Level 2 required to copy files.');
    }

    await fs.promises.copyFile(source, destination);

    rollbackManager.register('copy_file', `Delete copied file at ${destination}`, async () => {
      await fs.promises.unlink(destination);
      return true;
    });

    return `Copied ${source} to ${destination}`;
  }

  public async moveFile(source: string, destination: string): Promise<string> {
    this.ensureApproved(source, 'moveFile source');
    this.ensureApproved(destination, 'moveFile destination');

    if (!permissionSession.checkPermission(2, `Move file ${source} -> ${destination}`)) {
      throw new Error('Permission Level 2 required to move files.');
    }

    await fs.promises.rename(source, destination);

    rollbackManager.register('move_file', `Move file back: ${destination} -> ${source}`, async () => {
      await fs.promises.rename(destination, source);
      return true;
    });

    return `Moved ${source} to ${destination}`;
  }

  public async renameFile(source: string, destination: string): Promise<string> {
    return this.moveFile(source, destination);
  }

  public async deleteFile(filePath: string): Promise<string> {
    this.ensureApproved(filePath, 'deleteFile');

    // Deletion ALWAYS requires Level 3 confirmation
    const approved = await approvalGate.requestApproval('Delete File', `Permanently delete: ${filePath}`);
    if (!approved) {
      throw new Error(`Delete cancelled by user: ${filePath}`);
    }

    // Rollback backup
    const content = await fs.promises.readFile(filePath, 'utf-8');
    await fs.promises.unlink(filePath);

    rollbackManager.register('delete_file', `Restore deleted file ${filePath}`, async () => {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return true;
    });

    return `Deleted file: ${filePath}`;
  }

  public async createFolder(folderPath: string): Promise<string> {
    this.ensureApproved(folderPath, 'createFolder');
    if (!permissionSession.checkPermission(2, `Create folder ${folderPath}`)) {
      throw new Error('Permission Level 2 required to create folders.');
    }

    await fs.promises.mkdir(folderPath, { recursive: true });

    rollbackManager.register('create_folder', `Remove created folder ${folderPath}`, async () => {
      await fs.promises.rmdir(folderPath);
      return true;
    });

    return `Created folder: ${folderPath}`;
  }

  public async deleteFolder(folderPath: string): Promise<string> {
    this.ensureApproved(folderPath, 'deleteFolder');

    // Deletion ALWAYS requires Level 3 confirmation
    const approved = await approvalGate.requestApproval('Delete Folder', `Permanently delete folder: ${folderPath}`);
    if (!approved) {
      throw new Error(`Delete cancelled by user: ${folderPath}`);
    }

    await fs.promises.rm(folderPath, { recursive: true, force: true });
    return `Deleted folder: ${folderPath}`;
  }
}

export const fileController = new FileController();
