import { readFile, rm, writeFile } from 'node:fs/promises';
import { ensureParentDirectory } from './SessionPathResolver.js';

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile(
  filePath: string,
  data: unknown
): Promise<void> {
  await ensureParentDirectory(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/.test(message)) {
      throw error;
    }
  }
}

export async function removeDirectoryIfExists(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/.test(message)) {
      throw error;
    }
  }
}

export class WriteLock {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
