import type { TranscriptStore } from '../contracts.js';
import type { BridgeEvent, TranscriptEntry } from '../types.js';

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly entries = new Map<string, TranscriptEntry[]>();

  async append(event: BridgeEvent): Promise<void> {
    const bucket = this.entries.get(event.chatId) ?? [];
    bucket.push({
      chatId: event.chatId,
      turnId: event.turnId,
      event,
      createdAt: new Date().toISOString()
    });
    this.entries.set(event.chatId, bucket);
  }

  async listByChat(chatId: string): Promise<BridgeEvent[]> {
    return (this.entries.get(chatId) ?? []).map((entry) => entry.event);
  }

  async clearChat(chatId: string): Promise<void> {
    this.entries.delete(chatId);
  }
}
