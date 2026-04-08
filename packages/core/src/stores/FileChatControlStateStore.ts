import type { ChatControlStateStore } from '../contracts.js';
import type { ChatControlState } from '../types.js';
import {
  readJsonFile,
  removeFileIfExists,
  writeJsonFile,
  WriteLock
} from './PersistentJsonFile.js';
import type { SessionPathResolver } from './SessionPathResolver.js';

export class FileChatControlStateStore implements ChatControlStateStore {
  private readonly lock = new WriteLock();

  constructor(private readonly resolver: SessionPathResolver) {}

  async get(chatId: string): Promise<ChatControlState | undefined> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getControlFilePath(chatId);
    return readJsonFile<ChatControlState | undefined>(filePath, undefined);
  }

  async upsert(state: ChatControlState): Promise<ChatControlState> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getControlFilePath(state.chatId);
    return this.lock.run(async () => {
      await writeJsonFile(filePath, state);
      return state;
    });
  }

  async delete(chatId: string): Promise<void> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getControlFilePath(chatId);
    await this.lock.run(async () => {
      await removeFileIfExists(filePath);
    });
  }
}
