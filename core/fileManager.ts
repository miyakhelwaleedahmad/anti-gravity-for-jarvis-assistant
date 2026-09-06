import fs from "fs-extra";
import path from "path";
import os from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  extension: string;
  modified: Date;
  created: Date;
}

export interface WriteResult {
  success: boolean;
  filePath: string;
  message: string;
  overwritten?: boolean; // MED-8: flag when a file was silently overwritten
}

// ─── File Manager ─────────────────────────────────────────────────────────────

export class FileManager {
  private resolvePath(filePath: string): string {
    if (filePath.startsWith("~")) {
      return path.join(os.homedir(), filePath.slice(1));
    }
    return path.resolve(filePath);
  }

  // ─── Read ────────────────────────────────────────────────────────

  async readFile(filePath: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    try {
      const content = await fs.readFile(resolved, "utf-8");
      console.log(`[FileManager] Read: ${resolved}`);
      return content;
    } catch (err) {
      throw new Error(`[FileManager] Cannot read "${resolved}": ${String(err)}`);
    }
  }

  async readJSON<T = unknown>(filePath: string): Promise<T> {
    const content = await this.readFile(filePath);
    return JSON.parse(content) as T;
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.pathExists(this.resolvePath(filePath));
  }

  // ─── Write ───────────────────────────────────────────────────────

  async writeFile(filePath: string, content: string): Promise<WriteResult> {
    const resolved = this.resolvePath(filePath);
    try {
      await fs.ensureDir(path.dirname(resolved));
      await fs.writeFile(resolved, content, "utf-8");
      console.log(`[FileManager] Written: ${resolved}`);
      return { success: true, filePath: resolved, message: `File written: ${resolved}` };
    } catch (err) {
      return { success: false, filePath: resolved, message: String(err) };
    }
  }

  async appendFile(filePath: string, content: string): Promise<WriteResult> {
    const resolved = this.resolvePath(filePath);
    try {
      await fs.ensureDir(path.dirname(resolved));
      await fs.appendFile(resolved, content, "utf-8");
      return { success: true, filePath: resolved, message: `Appended to: ${resolved}` };
    } catch (err) {
      return { success: false, filePath: resolved, message: String(err) };
    }
  }

  async writeJSON(filePath: string, data: unknown, pretty = true): Promise<WriteResult> {
    const content = JSON.stringify(data, null, pretty ? 2 : 0);
    return this.writeFile(filePath, content);
  }

  // ─── Delete / Copy / Move ─────────────────────────────────────────

  async deleteFile(filePath: string): Promise<WriteResult> {
    const resolved = this.resolvePath(filePath);
    try {
      await fs.remove(resolved);
      return { success: true, filePath: resolved, message: `Deleted: ${resolved}` };
    } catch (err) {
      return { success: false, filePath: resolved, message: String(err) };
    }
  }

  async copyFile(src: string, dest: string): Promise<WriteResult> {
    const resolvedSrc = this.resolvePath(src);
    const resolvedDest = this.resolvePath(dest);

    // MED-8: Warn before silently overwriting an existing file
    const destExists = await fs.pathExists(resolvedDest);
    if (destExists) {
      console.warn(`[FileManager] OVERWRITE WARNING: "${resolvedDest}" already exists and will be replaced.`);
    }

    try {
      await fs.copy(resolvedSrc, resolvedDest, { overwrite: true });
      return {
        success: true,
        filePath: resolvedDest,
        message: `Copied: ${resolvedSrc} → ${resolvedDest}`,
        overwritten: destExists,
      };
    } catch (err) {
      return { success: false, filePath: resolvedDest, message: String(err) };
    }
  }

  async moveFile(src: string, dest: string): Promise<WriteResult> {
    const resolvedSrc = this.resolvePath(src);
    const resolvedDest = this.resolvePath(dest);

    // MED-8: Warn before silently overwriting an existing file
    const destExists = await fs.pathExists(resolvedDest);
    if (destExists) {
      console.warn(`[FileManager] OVERWRITE WARNING: "${resolvedDest}" already exists and will be replaced.`);
    }

    try {
      await fs.move(resolvedSrc, resolvedDest, { overwrite: true });
      return {
        success: true,
        filePath: resolvedDest,
        message: `Moved: ${resolvedSrc} → ${resolvedDest}`,
        overwritten: destExists,
      };
    } catch (err) {
      return { success: false, filePath: resolvedDest, message: String(err) };
    }
  }

  async createDirectory(dirPath: string): Promise<WriteResult> {
    const resolved = this.resolvePath(dirPath);
    try {
      await fs.ensureDir(resolved);
      return { success: true, filePath: resolved, message: `Directory created: ${resolved}` };
    } catch (err) {
      return { success: false, filePath: resolved, message: String(err) };
    }
  }

  // ─── Directory Listing ───────────────────────────────────────────

  async listDirectory(dirPath: string, recursive = false): Promise<FileInfo[]> {
    const resolved = this.resolvePath(dirPath);
    const entries = recursive
      ? await this.walkDir(resolved)
      : await fs.readdir(resolved);

    const infos: FileInfo[] = [];
    for (const entry of entries) {
      const fullPath = recursive ? (entry as string) : path.join(resolved, entry as string);
      try {
        const stat = await fs.stat(fullPath);
        infos.push({
          name: path.basename(fullPath),
          path: fullPath,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          extension: path.extname(fullPath),
          modified: stat.mtime,
          created: stat.birthtime,
        });
      } catch {
        // skip inaccessible files
      }
    }

    return infos;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      results.push(fullPath);
      if (entry.isDirectory()) {
        results.push(...await this.walkDir(fullPath));
      }
    }
    return results;
  }

  // ─── Search ──────────────────────────────────────────────────────

  async searchInFile(filePath: string, query: string): Promise<string[]> {
    const content = await this.readFile(filePath);
    return content
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
      .map((line) => line.trim());
  }

  async findFiles(dirPath: string, extension: string): Promise<string[]> {
    const files = await this.listDirectory(dirPath, true);
    return files
      .filter((f) => !f.isDirectory && f.extension === extension)
      .map((f) => f.path);
  }

  // ─── Utility ─────────────────────────────────────────────────────

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  getDesktopPath(): string {
    return path.join(os.homedir(), "Desktop");
  }

  getDownloadsPath(): string {
    return path.join(os.homedir(), "Downloads");
  }

  getDocumentsPath(): string {
    return path.join(os.homedir(), "Documents");
  }
}

export const fileManager = new FileManager();
