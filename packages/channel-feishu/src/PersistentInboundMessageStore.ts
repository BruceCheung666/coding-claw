import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface InboundMessageRecord {
  messageId: string;
  chatId: string;
  textHash: string;
  textPreview: string;
  status: 'processing' | 'completed' | 'failed';
  firstSeenAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ReserveMessageInput {
  messageId: string;
  chatId: string;
  text: string;
}

export type ReserveResult =
  | { action: 'accepted'; record: InboundMessageRecord }
  | { action: 'drop_duplicate_completed'; record: InboundMessageRecord }
  | { action: 'drop_duplicate_processing'; record: InboundMessageRecord }
  | { action: 'drop_duplicate_failed'; record: InboundMessageRecord };

export interface PersistentInboundMessageStoreOptions {
  ttlMs?: number;
  processingStaleMs?: number;
}

export class PersistentInboundMessageStore {
  private readonly records = new Map<string, InboundMessageRecord>();
  private readonly ttlMs: number;
  private readonly processingStaleMs: number;
  private ready: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: PersistentInboundMessageStoreOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.processingStaleMs = options.processingStaleMs ?? 15 * 60 * 1000;
    this.ready = this.load();
  }

  async reserve(input: ReserveMessageInput): Promise<ReserveResult> {
    await this.ready;
    return this.withLock(async () => {
      const now = new Date();
      this.gc(now.getTime());

      const existing = this.records.get(input.messageId);
      if (existing) {
        const duplicateAction = this.classifyDuplicate(existing, now.getTime());
        if (duplicateAction) {
          return { action: duplicateAction, record: existing };
        }
      }

      const record: InboundMessageRecord = {
        messageId: input.messageId,
        chatId: input.chatId,
        textHash: hashText(input.text),
        textPreview: input.text.slice(0, 200),
        status: 'processing',
        firstSeenAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.records.set(input.messageId, record);
      await this.persist();
      return { action: 'accepted', record };
    });
  }

  async markCompleted(messageId: string): Promise<void> {
    await this.ready;
    await this.withLock(async () => {
      const record = this.records.get(messageId);
      if (!record) {
        return;
      }

      record.status = 'completed';
      record.updatedAt = new Date().toISOString();
      delete record.lastError;
      await this.persist();
    });
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    await this.ready;
    await this.withLock(async () => {
      const record = this.records.get(messageId);
      if (!record) {
        return;
      }

      record.status = 'failed';
      record.updatedAt = new Date().toISOString();
      record.lastError = error;
      await this.persist();
    });
  }

  private classifyDuplicate(
    record: InboundMessageRecord,
    now: number
  ): ReserveResult['action'] | null {
    if (record.status === 'completed') {
      return 'drop_duplicate_completed';
    }

    if (record.status === 'processing') {
      const ageMs = now - new Date(record.updatedAt).getTime();
      if (ageMs <= this.processingStaleMs) {
        return 'drop_duplicate_processing';
      }
      return null;
    }

    if (record.status === 'failed') {
      return 'drop_duplicate_failed';
    }

    return null;
  }

  private gc(now: number): void {
    for (const [messageId, record] of this.records.entries()) {
      const ageMs = now - new Date(record.updatedAt).getTime();
      if (ageMs > this.ttlMs) {
        this.records.delete(messageId);
      }
    }
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as InboundMessageRecord[];
      for (const record of parsed) {
        this.records.set(record.messageId, record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT/.test(message)) {
        throw error;
      }
    }
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.filePath,
      JSON.stringify([...this.records.values()], null, 2),
      'utf8'
    );
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
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

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
