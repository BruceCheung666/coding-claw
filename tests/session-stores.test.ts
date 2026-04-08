import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileApprovalStore,
  FileChatControlStateStore,
  FileTranscriptStore,
  FileWorkspaceBindingStore,
  SessionPathResolver,
  type BridgeEvent
} from '../packages/core/src/index.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  createdDirs.length = 0;
});

describe('file-backed session stores', () => {
  it('persists workspace bindings and control state across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-session-'));
    createdDirs.push(dir);
    const resolver = new SessionPathResolver(dir);

    const bindings = new FileWorkspaceBindingStore(resolver);
    const controls = new FileChatControlStateStore(resolver);

    await bindings.upsert({
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath: '/tmp/chat-1',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      sessionId: 'session-1',
      mode: 'default',
      metadata: {}
    });
    await controls.upsert({
      chatId: 'chat-1',
      inputMode: 'agent',
      cwd: '/tmp/chat-1/subdir',
      shellStatus: 'ready',
      shellSessionId: 'shell-1',
      lastAgentResetAt: '2026-04-08T00:00:00.000Z',
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z'
    });

    const reboundBindings = new FileWorkspaceBindingStore(resolver);
    const reboundControls = new FileChatControlStateStore(resolver);

    expect((await reboundBindings.get('chat-1'))?.sessionId).toBe('session-1');
    expect((await reboundControls.get('chat-1'))?.cwd).toBe(
      '/tmp/chat-1/subdir'
    );
    expect((await reboundControls.get('chat-1'))?.shellSessionId).toBe(
      'shell-1'
    );
  });

  it('persists approvals for lookup and resolve across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-session-'));
    createdDirs.push(dir);
    const resolver = new SessionPathResolver(dir);

    const first = new FileApprovalStore(resolver);
    await first.create('chat-1', 'turn-1', {
      kind: 'permission',
      id: 'approval-1',
      createdAt: '2026-04-08T00:00:00.000Z',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      suggestions: []
    });

    const second = new FileApprovalStore(resolver);
    expect(await second.listPending('chat-1')).toHaveLength(1);
    expect(await second.get('chat-1', 'approval-1')).toMatchObject({
      id: 'approval-1'
    });
    expect(await second.lookup('approval-1')).toMatchObject({
      chatId: 'chat-1',
      turnId: 'turn-1'
    });

    await second.resolve('chat-1', 'approval-1', {
      kind: 'permission',
      action: 'accept-once'
    });

    const third = new FileApprovalStore(resolver);
    expect(await third.listPending('chat-1')).toEqual([]);
  });

  it('persists transcripts by chat and clears them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-session-'));
    createdDirs.push(dir);
    const resolver = new SessionPathResolver(dir);

    const first = new FileTranscriptStore(resolver);
    const events: BridgeEvent[] = [
      {
        type: 'turn.started',
        chatId: 'chat-1',
        turnId: 'turn-1',
        prompt: 'hello',
        startedAt: '2026-04-08T00:00:00.000Z'
      },
      {
        type: 'turn.completed',
        chatId: 'chat-1',
        turnId: 'turn-1',
        status: 'completed',
        finalText: 'ok',
        sessionId: 'session-1',
        finishedAt: '2026-04-08T00:00:01.000Z'
      }
    ];

    for (const event of events) {
      await first.append(event);
    }

    const second = new FileTranscriptStore(resolver);
    expect(await second.listByChat('chat-1')).toEqual(events);

    await second.clearChat('chat-1');

    const third = new FileTranscriptStore(resolver);
    expect(await third.listByChat('chat-1')).toEqual([]);
  });
});
