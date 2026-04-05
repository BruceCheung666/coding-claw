import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistentInboundMessageStore } from '../packages/channel-feishu/src/PersistentInboundMessageStore.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.map(async (dir) => {
      await import('node:fs/promises').then(({ rm }) =>
        rm(dir, { recursive: true, force: true })
      );
    })
  );
  createdDirs.length = 0;
});

describe('PersistentInboundMessageStore', () => {
  it('drops the same message id after restart once it was completed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-inbound-'));
    createdDirs.push(dir);
    const filePath = join(dir, 'inbound.json');

    const first = new PersistentInboundMessageStore(filePath);
    const accepted = await first.reserve({
      messageId: 'msg-1',
      chatId: 'chat-1',
      text: 'hello'
    });
    expect(accepted.action).toBe('accepted');
    await first.markCompleted('msg-1');

    const second = new PersistentInboundMessageStore(filePath);
    const duplicate = await second.reserve({
      messageId: 'msg-1',
      chatId: 'chat-1',
      text: 'hello'
    });
    expect(duplicate.action).toBe('drop_duplicate_completed');

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Array<{
      messageId: string;
      status: string;
    }>;
    expect(
      persisted.some(
        (record) =>
          record.messageId === 'msg-1' && record.status === 'completed'
      )
    ).toBe(true);
  });
});
