import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalStore } from '../contracts.js';
import type { InteractionResolution, PendingInteraction } from '../types.js';
import {
  readJsonFile,
  writeJsonFile,
  WriteLock
} from './PersistentJsonFile.js';
import type { SessionPathResolver } from './SessionPathResolver.js';

interface ApprovalRecord {
  chatId: string;
  turnId: string;
  interaction: PendingInteraction;
  resolution?: InteractionResolution;
}

type ApprovalRecordMap = Record<string, ApprovalRecord>;

export class FileApprovalStore implements ApprovalStore {
  private readonly lock = new WriteLock();

  constructor(private readonly resolver: SessionPathResolver) {}

  async create(
    chatId: string,
    turnId: string,
    interaction: PendingInteraction
  ): Promise<void> {
    await this.withChatRecords(chatId, async (records) => {
      records[interaction.id] = { chatId, turnId, interaction };
      return records;
    });
  }

  async get(
    chatId: string,
    interactionId: string
  ): Promise<PendingInteraction | undefined> {
    const records = await this.readChatRecords(chatId);
    return records[interactionId]?.interaction;
  }

  async lookup(
    interactionId: string
  ): Promise<
    | { chatId: string; turnId: string; interaction: PendingInteraction }
    | undefined
  > {
    await this.resolver.ensureRoot();

    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.resolver.getChatsDirectory(), {
        withFileTypes: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT/.test(message)) {
        return undefined;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const filePath = join(
        this.resolver.getChatsDirectory(),
        entry.name,
        'approvals.json'
      );
      const records = await readJsonFile<ApprovalRecordMap>(filePath, {});
      const record = records[interactionId];
      if (!record) {
        continue;
      }
      return {
        chatId: record.chatId,
        turnId: record.turnId,
        interaction: record.interaction
      };
    }

    return undefined;
  }

  async listPending(chatId: string): Promise<PendingInteraction[]> {
    const records = await this.readChatRecords(chatId);
    return Object.values(records)
      .filter((record) => record.resolution === undefined)
      .map((record) => record.interaction);
  }

  async resolve(
    chatId: string,
    interactionId: string,
    resolution: InteractionResolution
  ): Promise<void> {
    await this.withChatRecords(chatId, async (records) => {
      const record = records[interactionId];
      if (record) {
        record.resolution = resolution;
      }
      return records;
    });
  }

  async clearChat(chatId: string): Promise<void> {
    const filePath = this.resolver.getApprovalsFilePath(chatId);
    await this.lock.run(async () => {
      await writeJsonFile(filePath, {});
    });
  }

  private async readChatRecords(chatId: string): Promise<ApprovalRecordMap> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getApprovalsFilePath(chatId);
    return readJsonFile<ApprovalRecordMap>(filePath, {});
  }

  private async withChatRecords(
    chatId: string,
    mutate: (
      records: ApprovalRecordMap
    ) => Promise<ApprovalRecordMap> | ApprovalRecordMap
  ): Promise<void> {
    await this.resolver.ensureRoot();
    const filePath = this.resolver.getApprovalsFilePath(chatId);
    await this.lock.run(async () => {
      const current = await readJsonFile<ApprovalRecordMap>(filePath, {});
      const next = await mutate(current);
      await writeJsonFile(filePath, next);
    });
  }
}
