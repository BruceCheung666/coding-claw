import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeOrchestrator,
  FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY,
  FEISHU_CHAT_ANNOUNCEMENT_UPDATED_AT_METADATA_KEY,
  FileApprovalStore,
  FileChatControlStateStore,
  FileTranscriptStore,
  FileWorkspaceBindingStore,
  InMemoryApprovalStore,
  InMemoryChatControlStateStore,
  InMemoryTranscriptStore,
  InMemoryWorkspaceBindingStore,
  SessionPathResolver,
  type AgentRuntime,
  type BridgeEvent,
  type RenderSurface,
  type RuntimeSession,
  type SessionContextProvider,
  type ShellExecutor,
  type ShellSessionSnapshot,
  type WorkspaceBinding
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

class StubShellExecutor implements ShellExecutor {
  async execute() {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      cwd: '/workspace',
      gitBranch: null,
      sessionId: 'shell-1'
    };
  }

  async reset(): Promise<void> {}

  async getStatus(): Promise<ShellSessionSnapshot> {
    return {
      active: false,
      running: false
    };
  }
}

function createRenderSurface(): RenderSurface {
  return {
    startTurn: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
    render: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    error: vi.fn(async () => {})
  };
}

describe('BridgeOrchestrator', () => {
  it('continues processing later turns after a previous turn failed', async () => {
    const runtimeCalls: string[] = [];
    const runtime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId
          },
          busy: false,
          async *runTurn(input) {
            runtimeCalls.push(input.prompt);
            if (input.prompt === 'first turn fails') {
              throw new Error('boom');
            }

            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'session-1',
              finishedAt: new Date('2026-04-03T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings: new InMemoryWorkspaceBindingStore(),
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator'
    });

    const failedSurface = createRenderSurface();
    await expect(
      orchestrator.handleInbound(
        {
          channel: 'feishu',
          chatId: 'chat-1',
          messageId: 'msg-1',
          text: 'first turn fails'
        },
        failedSurface
      )
    ).rejects.toThrow('boom');

    const nextSurface = createRenderSurface();
    await expect(
      orchestrator.handleInbound(
        {
          channel: 'feishu',
          chatId: 'chat-1',
          messageId: 'msg-2',
          text: 'second turn succeeds'
        },
        nextSurface
      )
    ).resolves.toBeUndefined();

    expect(runtimeCalls).toEqual(['first turn fails', 'second turn succeeds']);
    expect(
      nextSurface.complete as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledTimes(1);
  });

  it('resolves stored approvals even when no runtime session is loaded', async () => {
    const approvals = new InMemoryApprovalStore();
    await approvals.create('chat-1', 'turn-1', {
      kind: 'permission',
      id: 'approval-1',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      toolName: 'Bash',
      toolInput: {
        command: 'pnpm test'
      },
      suggestions: []
    });

    const runtime: AgentRuntime = {
      async getOrCreateSession(): Promise<RuntimeSession> {
        throw new Error('should not load runtime session');
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals,
      bindings: new InMemoryWorkspaceBindingStore(),
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator'
    });

    const resolved = await orchestrator.resolveInteractionById('approval-1', {
      kind: 'permission',
      action: 'accept-once'
    });

    expect(resolved?.chatId).toBe('chat-1');
    expect(await approvals.listPending('chat-1')).toEqual([]);
    expect(
      await orchestrator['deps'].transcripts.listByChat('chat-1')
    ).toContainEqual({
      type: 'interaction.resolved',
      chatId: 'chat-1',
      turnId: 'turn-1',
      interactionId: 'approval-1',
      resolution: {
        kind: 'permission',
        action: 'accept-once'
      }
    });
  });

  it('injects a follow-up message into the running session', async () => {
    const injectUserMessage = vi.fn(async () => {});
    const runtime: AgentRuntime = {
      async getOrCreateSession(): Promise<RuntimeSession> {
        throw new Error('should not load runtime session');
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings: new InMemoryWorkspaceBindingStore(),
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator'
    });

    (orchestrator as any).sessions.set('chat-1', {
      ref: {
        chatId: 'chat-1',
        workspaceId: 'chat-1',
        sessionId: 'session-running-1'
      },
      busy: true,
      async *runTurn() {
        return;
      },
      injectUserMessage,
      resolveInteraction() {},
      abort() {}
    } satisfies RuntimeSession);

    await orchestrator.injectIntoRunningTurn('chat-1', '补充一句需求');

    expect(injectUserMessage).toHaveBeenCalledWith('补充一句需求', 'now');
    expect(orchestrator.getChatExecutionSnapshot('chat-1')).toEqual({
      running: true,
      willQueue: false,
      sessionId: 'session-running-1'
    });
  });

  it('refreshes session metadata before the first turn of a new session', async () => {
    const provider: SessionContextProvider = {
      getSessionMetadata: vi.fn(async () => ({
        [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '请使用中文回复',
        [FEISHU_CHAT_ANNOUNCEMENT_UPDATED_AT_METADATA_KEY]:
          '2026-04-09T00:00:00.000Z'
      }))
    };
    const observedMetadata: Array<Record<string, string>> = [];
    const runtime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        observedMetadata.push({ ...binding.metadata });
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId
          },
          busy: false,
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'session-1',
              finishedAt: new Date('2026-04-09T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };
    const bindings = new InMemoryWorkspaceBindingStore();

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator',
      sessionContextProvider: provider
    });

    await orchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-meta-1',
        messageId: 'msg-1',
        text: 'hello'
      },
      createRenderSurface()
    );

    expect(provider.getSessionMetadata).toHaveBeenCalledWith('chat-meta-1');
    expect(observedMetadata).toEqual([
      {
        [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '请使用中文回复',
        [FEISHU_CHAT_ANNOUNCEMENT_UPDATED_AT_METADATA_KEY]:
          '2026-04-09T00:00:00.000Z'
      }
    ]);
    expect((await bindings.get('chat-meta-1'))?.metadata).toMatchObject({
      [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '请使用中文回复'
    });
  });

  it('does not refresh metadata again while an existing session continues', async () => {
    const provider: SessionContextProvider = {
      getSessionMetadata: vi.fn(async () => ({
        [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '第一次公告'
      }))
    };
    const runtime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId,
            sessionId: binding.sessionId
          },
          busy: false,
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'session-stable-1',
              finishedAt: new Date('2026-04-09T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings: new InMemoryWorkspaceBindingStore(),
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator',
      sessionContextProvider: provider
    });

    await orchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-meta-2',
        messageId: 'msg-1',
        text: 'hello'
      },
      createRenderSurface()
    );
    await orchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-meta-2',
        messageId: 'msg-2',
        text: 'hello again'
      },
      createRenderSurface()
    );

    expect(provider.getSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it('refreshes metadata again after /new clears the session', async () => {
    const provider: SessionContextProvider = {
      getSessionMetadata: vi
        .fn<SessionContextProvider['getSessionMetadata']>()
        .mockResolvedValueOnce({
          [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '旧公告'
        })
        .mockResolvedValueOnce({
          [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '新公告'
        })
    };
    const bindings = new InMemoryWorkspaceBindingStore();
    const runtime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId,
            sessionId: binding.sessionId
          },
          busy: false,
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'session-resettable-1',
              finishedAt: new Date('2026-04-09T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator',
      sessionContextProvider: provider
    });

    await orchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-meta-3',
        messageId: 'msg-1',
        text: 'hello'
      },
      createRenderSurface()
    );

    await orchestrator.dispatchControlCommand('chat-meta-3', 'new', '');

    await orchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-meta-3',
        messageId: 'msg-2',
        text: 'hello again'
      },
      createRenderSurface()
    );

    expect(provider.getSessionMetadata).toHaveBeenCalledTimes(2);
    expect((await bindings.get('chat-meta-3'))?.metadata).toMatchObject({
      [FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]: '新公告'
    });
  });

  it('degrades gracefully when metadata refresh fails', async () => {
    const provider: SessionContextProvider = {
      getSessionMetadata: vi.fn(async () => {
        throw new Error('feishu unavailable');
      })
    };
    const runtime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        expect(binding.metadata).toEqual({});
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId
          },
          busy: false,
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'session-1',
              finishedAt: new Date('2026-04-09T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings: new InMemoryWorkspaceBindingStore(),
      controls: new InMemoryChatControlStateStore(),
      shellExecutor: new StubShellExecutor(),
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator',
      sessionContextProvider: provider
    });

    await expect(
      orchestrator.handleInbound(
        {
          channel: 'feishu',
          chatId: 'chat-meta-4',
          messageId: 'msg-1',
          text: 'hello'
        },
        createRenderSurface()
      )
    ).resolves.toBeUndefined();
  });

  it('reloads persisted binding sessionId after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-bridge-persist-'));
    createdDirs.push(dir);
    const resolver = new SessionPathResolver(dir);
    const firstObserved: Array<string | undefined> = [];
    const secondObserved: Array<string | undefined> = [];

    const firstRuntime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        firstObserved.push(binding.sessionId);
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId,
            sessionId: binding.sessionId
          },
          busy: false,
          async getStatus() {
            return {
              state: 'idle',
              sessionId: binding.sessionId,
              supportsContextUsage: false
            };
          },
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok',
              sessionId: 'persisted-session-1',
              finishedAt: new Date('2026-04-08T00:00:00Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const firstOrchestrator = new BridgeOrchestrator({
      runtime: firstRuntime,
      approvals: new FileApprovalStore(resolver),
      bindings: new FileWorkspaceBindingStore(resolver),
      controls: new FileChatControlStateStore(resolver),
      shellExecutor: new StubShellExecutor(),
      transcripts: new FileTranscriptStore(resolver),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator'
    });

    await firstOrchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-persist',
        messageId: 'msg-1',
        text: 'hello'
      },
      createRenderSurface()
    );

    const secondRuntime: AgentRuntime = {
      async getOrCreateSession(
        binding: WorkspaceBinding
      ): Promise<RuntimeSession> {
        secondObserved.push(binding.sessionId);
        return {
          ref: {
            chatId: binding.chatId,
            workspaceId: binding.workspaceId,
            sessionId: binding.sessionId
          },
          busy: false,
          async getStatus() {
            return {
              state: 'idle',
              sessionId: binding.sessionId,
              supportsContextUsage: false
            };
          },
          async *runTurn(input) {
            yield {
              type: 'turn.completed',
              chatId: input.chatId,
              turnId: input.turnId,
              status: 'completed',
              finalText: 'ok-2',
              sessionId: binding.sessionId,
              finishedAt: new Date('2026-04-08T00:00:01Z').toISOString()
            } satisfies BridgeEvent;
          },
          async injectUserMessage() {},
          resolveInteraction() {},
          abort() {}
        };
      },
      async dropSession(): Promise<void> {}
    };

    const secondOrchestrator = new BridgeOrchestrator({
      runtime: secondRuntime,
      approvals: new FileApprovalStore(resolver),
      bindings: new FileWorkspaceBindingStore(resolver),
      controls: new FileChatControlStateStore(resolver),
      shellExecutor: new StubShellExecutor(),
      transcripts: new FileTranscriptStore(resolver),
      workspaceRoot: '/tmp/coding-claw-bridge-orchestrator'
    });

    await secondOrchestrator.handleInbound(
      {
        channel: 'feishu',
        chatId: 'chat-persist',
        messageId: 'msg-2',
        text: 'hello again'
      },
      createRenderSurface()
    );

    expect(firstObserved).toEqual([undefined]);
    expect(secondObserved).toEqual(['persisted-session-1']);
  });
});
