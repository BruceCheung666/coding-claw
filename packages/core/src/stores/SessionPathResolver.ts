import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export class SessionPathResolver {
  constructor(private readonly rootPath: string) {}

  async ensureRoot(): Promise<void> {
    await mkdir(this.getChatsDirectory(), { recursive: true });
  }

  getRootPath(): string {
    return this.rootPath;
  }

  getChatsDirectory(): string {
    return join(this.rootPath, 'chats');
  }

  getChatDirectory(chatId: string): string {
    return join(this.getChatsDirectory(), hashChatId(chatId));
  }

  getBindingFilePath(chatId: string): string {
    return join(this.getChatDirectory(chatId), 'binding.json');
  }

  getControlFilePath(chatId: string): string {
    return join(this.getChatDirectory(chatId), 'control.json');
  }

  getApprovalsFilePath(chatId: string): string {
    return join(this.getChatDirectory(chatId), 'approvals.json');
  }

  getTranscriptDirectory(chatId: string): string {
    return join(this.getChatDirectory(chatId), 'transcript');
  }

  getTranscriptTurnsDirectory(chatId: string): string {
    return join(this.getTranscriptDirectory(chatId), 'turns');
  }

  getTranscriptTurnFilePath(chatId: string, turnId: string): string {
    return join(
      this.getTranscriptTurnsDirectory(chatId),
      `${sanitizeSegment(turnId)}.json`
    );
  }
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function hashChatId(chatId: string): string {
  return createHash('sha256').update(chatId).digest('hex');
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
