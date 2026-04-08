import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import type { TranscriptStore } from '../contracts.js';
import type { BridgeEvent, TranscriptEntry } from '../types.js';
import {
  readJsonFile,
  removeDirectoryIfExists,
  writeJsonFile,
  WriteLock
} from './PersistentJsonFile.js';
import type { SessionPathResolver } from './SessionPathResolver.js';

export class FileTranscriptStore implements TranscriptStore {
  private readonly lock = new WriteLock();

  constructor(private readonly resolver: SessionPathResolver) {}

  async append(event: BridgeEvent): Promise<void> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getTranscriptTurnFilePath(
      event.chatId,
      event.turnId
    );

    await this.lock.run(async () => {
      const entries = await readJsonFile<TranscriptEntry[]>(filePath, []);
      entries.push({
        chatId: event.chatId,
        turnId: event.turnId,
        event,
        createdAt: new Date().toISOString()
      });
      await writeJsonFile(filePath, entries);
    });
  }

  async listByChat(chatId: string): Promise<BridgeEvent[]> {
    await this.resolver.ensureRoot();
    const turnsDirectory = this.resolver.getTranscriptTurnsDirectory(chatId);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(turnsDirectory, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT/.test(message)) {
        return [];
      }
      throw error;
    }

    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const events: BridgeEvent[] = [];
    for (const file of files) {
      const filePath = this.resolver.getTranscriptTurnFilePath(
        chatId,
        basename(file, '.json')
      );
      const turnEntries = await readJsonFile<TranscriptEntry[]>(filePath, []);
      events.push(...turnEntries.map((entry) => entry.event));
    }
    return events;
  }

  async clearChat(chatId: string): Promise<void> {
    await this.lock.run(async () => {
      await removeDirectoryIfExists(
        this.resolver.getTranscriptDirectory(chatId)
      );
    });
  }
}
