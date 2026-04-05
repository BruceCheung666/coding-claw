import type { ChatControlStateStore } from '../contracts.js';
import type { ChatControlState } from '../types.js';

export class InMemoryChatControlStateStore implements ChatControlStateStore {
  private readonly states = new Map<string, ChatControlState>();

  async get(chatId: string): Promise<ChatControlState | undefined> {
    return this.states.get(chatId);
  }

  async upsert(state: ChatControlState): Promise<ChatControlState> {
    this.states.set(state.chatId, state);
    return state;
  }
}
