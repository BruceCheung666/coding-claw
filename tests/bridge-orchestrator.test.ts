import { describe, expect, it, vi } from 'vitest';
import {
  BridgeOrchestrator,
  InMemoryApprovalStore,
  InMemoryChatControlStateStore,
  InMemoryTranscriptStore,
  InMemoryWorkspaceBindingStore,
  type AgentRuntime,
  type BridgeEvent,
  type RenderSurface,
  type RuntimeSession,
  type ShellExecutor,
  type ShellSessionSnapshot,
  type WorkspaceBinding
} from '../packages/core/src/index.js';

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
});
