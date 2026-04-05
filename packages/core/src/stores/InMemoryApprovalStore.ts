import type { ApprovalStore } from '../contracts.js';
import type { InteractionResolution, PendingInteraction } from '../types.js';

interface ApprovalRecord {
  turnId: string;
  interaction: PendingInteraction;
  resolution?: InteractionResolution;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, Map<string, ApprovalRecord>>();

  async create(
    chatId: string,
    turnId: string,
    interaction: PendingInteraction
  ): Promise<void> {
    const chatRecords =
      this.records.get(chatId) ?? new Map<string, ApprovalRecord>();
    chatRecords.set(interaction.id, { turnId, interaction });
    this.records.set(chatId, chatRecords);
  }

  async get(
    chatId: string,
    interactionId: string
  ): Promise<PendingInteraction | undefined> {
    return this.records.get(chatId)?.get(interactionId)?.interaction;
  }

  async lookup(
    interactionId: string
  ): Promise<
    | { chatId: string; turnId: string; interaction: PendingInteraction }
    | undefined
  > {
    for (const [chatId, chatRecords] of this.records.entries()) {
      const record = chatRecords.get(interactionId);
      if (record) {
        return {
          chatId,
          turnId: record.turnId,
          interaction: record.interaction
        };
      }
    }

    return undefined;
  }

  async listPending(chatId: string): Promise<PendingInteraction[]> {
    const chatRecords = this.records.get(chatId);
    if (!chatRecords) {
      return [];
    }

    return [...chatRecords.values()]
      .filter((record) => record.resolution === undefined)
      .map((record) => record.interaction);
  }

  async resolve(
    chatId: string,
    interactionId: string,
    resolution: InteractionResolution
  ): Promise<void> {
    const chatRecords = this.records.get(chatId);
    if (!chatRecords) {
      return;
    }

    const record = chatRecords.get(interactionId);
    if (!record) {
      return;
    }

    record.resolution = resolution;
  }

  async clearChat(chatId: string): Promise<void> {
    this.records.delete(chatId);
  }
}
