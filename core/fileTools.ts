import { fileManager, type FileInfo } from "./fileManager.js";
import path from "path";

// ─── File Tools (AI-Callable) ─────────────────────────────────────────────────

export class FileTools {
  /**
   * Read a file and return its content as a string.
   */
  async read(filePath: string): Promise<string> {
    try {
      return await fileManager.readFile(filePath);
    } catch (err) {
      return `Error reading file: ${String(err)}`;
    }
  }

  /**
   * Write content to a file (creates parent directories automatically).
   */
  async write(filePath: string, content: string): Promise<string> {
    const result = await fileManager.writeFile(filePath, content);
    return result.message;
  }

  /**
   * Append content to a file.
   */
  async append(filePath: string, content: string): Promise<string> {
    const result = await fileManager.appendFile(filePath, content);
    return result.message;
  }

  /**
   * Delete a file or directory.
   */
  async delete(filePath: string): Promise<string> {
    const result = await fileManager.deleteFile(filePath);
    return result.message;
  }

  /**
   * Copy a file or folder from source to destination.
   */
  async copy(src: string, dest: string): Promise<string> {
    const result = await fileManager.copyFile(src, dest);
    return result.message;
  }

  /**
   * Move a file or folder from source to destination.
   */
  async move(src: string, dest: string): Promise<string> {
    const result = await fileManager.moveFile(src, dest);
    return result.message;
  }

  /**
   * List files in a directory.
   */
  async list(dirPath: string, recursive = false): Promise<string> {
    try {
      const files = await fileManager.listDirectory(dirPath, recursive);
      if (files.length === 0) return "Directory is empty.";

      return files
        .map((f: FileInfo) => {
          const type = f.isDirectory ? "📁" : "📄";
          const size = f.isDirectory ? "" : ` (${fileManager.formatSize(f.size)})`;
          return `${type} ${f.name}${size}`;
        })
        .join("\n");
    } catch (err) {
      return `Error listing directory: ${String(err)}`;
    }
  }

  /**
   * Search for a text query inside a file.
   */
  async searchInFile(filePath: string, query: string): Promise<string> {
    const lines = await fileManager.searchInFile(filePath, query);
    if (lines.length === 0) return `No matches for "${query}" in ${filePath}`;
    return lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  }

  /**
   * Find files by extension in a directory.
   */
  async findByExtension(dirPath: string, ext: string): Promise<string> {
    const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
    const files = await fileManager.findFiles(dirPath, normalizedExt);
    if (files.length === 0) return `No ${normalizedExt} files found in ${dirPath}`;
    return files.map((f) => `📄 ${f}`).join("\n");
  }

  /**
   * Check if a file exists.
   */
  async exists(filePath: string): Promise<string> {
    const exists = await fileManager.exists(filePath);
    return exists ? `✅ File exists: ${filePath}` : `❌ Not found: ${filePath}`;
  }

  /**
   * Create a directory (including nested).
   */
  async mkdir(dirPath: string): Promise<string> {
    const result = await fileManager.createDirectory(dirPath);
    return result.message;
  }

  /**
   * Get quick links to common directories.
   */
  getCommonPaths(): Record<string, string> {
    return {
      desktop: fileManager.getDesktopPath(),
      downloads: fileManager.getDownloadsPath(),
      documents: fileManager.getDocumentsPath(),
      project: path.resolve("."),
    };
  }

  /**
   * Save Jarvis output/response to a file on Desktop.
   */
  async saveResponseToDesktop(content: string, filename?: string): Promise<string> {
    const fname = filename ?? `jarvis_output_${Date.now()}.txt`;
    const destPath = path.join(fileManager.getDesktopPath(), fname);
    return this.write(destPath, content);
  }
}

export const fileTools = new FileTools();
