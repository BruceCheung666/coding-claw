import type { WorkspaceBindingStore } from '../contracts.js';
import type { WorkspaceBinding } from '../types.js';
import {
  readJsonFile,
  removeFileIfExists,
  writeJsonFile,
  WriteLock
} from './PersistentJsonFile.js';
import type { SessionPathResolver } from './SessionPathResolver.js';

export class FileWorkspaceBindingStore implements WorkspaceBindingStore {
  private readonly lock = new WriteLock();

  constructor(private readonly resolver: SessionPathResolver) {}

  async get(chatId: string): Promise<WorkspaceBinding | undefined> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getBindingFilePath(chatId);
    return readJsonFile<WorkspaceBinding | undefined>(filePath, undefined);
  }

  async upsert(binding: WorkspaceBinding): Promise<WorkspaceBinding> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getBindingFilePath(binding.chatId);
    return this.lock.run(async () => {
      await writeJsonFile(filePath, binding);
      return binding;
    });
  }

  async delete(chatId: string): Promise<void> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getBindingFilePath(chatId);
    await this.lock.run(async () => {
      await removeFileIfExists(filePath);
    });
  }
}
