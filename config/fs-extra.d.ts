// Fallback type declaration for fs-extra
// This can be removed once @types/fs-extra is installed
declare module 'fs-extra' {
  export * from 'fs';
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
  export function appendFile(path: string, data: string, encoding?: BufferEncoding): Promise<void>;
  export function remove(path: string): Promise<void>;
  export function copy(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void>;
  export function move(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void>;
  export function ensureDir(path: string): Promise<void>;
  export function pathExists(path: string): Promise<boolean>;
  export function readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<import('fs').Dirent[]>;
  export function stat(path: string): Promise<import('fs').Stats>;
  export function readJSON(path: string): Promise<unknown>;
  export function writeJSON(path: string, data: unknown, options?: { spaces?: number }): Promise<void>;
}
