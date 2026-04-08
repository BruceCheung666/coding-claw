import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BridgeOrchestrator,
  InMemoryApprovalStore,
  InMemoryChatControlStateStore,
  InMemoryTranscriptStore,
  InMemoryWorkspaceBindingStore,
  parseInboundText,
  type AgentRuntime,
  type RuntimeSession,
  type RuntimeSessionStatus,
  type ShellExecutor,
  type ShellSessionSnapshot,
  type WorkspaceBinding
} from '../packages/core/src/index.js';
import { LocalShellExecutor } from '../apps/bridge/src/LocalShellExecutor.js';

class StubRuntime implements AgentRuntime {
  readonly dropCalls: string[] = [];
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sessionStatuses = new Map<string, RuntimeSessionStatus>();

  setSessionStatus(chatId: string, status: RuntimeSessionStatus): void {
    this.sessionStatuses.set(chatId, status);
  }

  async getOrCreateSession(binding: WorkspaceBinding): Promise<RuntimeSession> {
    const cached = this.sessions.get(binding.chatId);
    if (cached) {
      return cached;
    }

    const runtime = this;
    const session: RuntimeSession = {
      ref: {
        chatId: binding.chatId,
        workspaceId: binding.workspaceId,
        sessionId: binding.sessionId
      },
      busy: false,
      async getStatus() {
        return (
          runtime.sessionStatuses.get(binding.chatId) ?? {
            state: this.busy ? 'running' : 'idle',
            sessionId: binding.sessionId,
            supportsContextUsage: false
          }
        );
      },
      async *runTurn() {
        return;
      },
      async injectUserMessage() {},
      resolveInteraction() {},
      abort() {}
    };
    this.sessions.set(binding.chatId, session);
    return session;
  }

  async dropSession(chatId: string): Promise<void> {
    this.dropCalls.push(chatId);
    this.sessions.delete(chatId);
    this.sessionStatuses.delete(chatId);
  }
}

class StubShellExecutor implements ShellExecutor {
  readonly calls: Array<{ cwd: string; command: string }> = [];
  status: ShellSessionSnapshot = {
    active: false,
    running: false
  };

  async execute(input: {
    chatId: string;
    workspacePath: string;
    cwd: string;
    command: string;
  }) {
    this.calls.push({ cwd: input.cwd, command: input.command });
    this.status = {
      active: true,
      running: false,
      sessionId: 'shell-1',
      pid: 123
    };
    return {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      cwd: `${input.cwd}/next`,
      gitBranch: 'main',
      sessionId: 'shell-1'
    };
  }

  async reset(): Promise<void> {
    this.status = {
      active: false,
      running: false
    };
  }

  async getStatus(): Promise<ShellSessionSnapshot> {
    return this.status;
  }
}

describe('parseInboundText', () => {
  it('parses canonical commands and aliases', () => {
    const canonical = parseInboundText('/reset');
    expect(canonical.kind).toBe('command');
    if (canonical.kind === 'command') {
      expect(canonical.match.id).toBe('reset');
      expect(canonical.match.argsText).toBe('');
    }

    const alias = parseInboundText('/sx git status');
    expect(alias.kind).toBe('command');
    if (alias.kind === 'command') {
      expect(alias.match.id).toBe('shell.exec');
      expect(alias.match.aliasUsed).toBe('sx');
      expect(alias.match.argsText).toBe('git status');
    }
  });

  it('treats multiple leading slashes as escaped agent text', () => {
    expect(parseInboundText('//reset')).toEqual({
      kind: 'runtime',
      text: '/reset'
    });
    expect(parseInboundText('///reset')).toEqual({
      kind: 'runtime',
      text: '//reset'
    });
  });

  it('reports unknown single-slash commands', () => {
    expect(parseInboundText('/unknown command')).toEqual({
      kind: 'unknown-command',
      commandName: 'unknown'
    });
  });
});

describe('BridgeOrchestrator control commands', () => {
  it('shows a workspace picker through /reset', async () => {
    const runtime = new StubRuntime();
    const approvals = new InMemoryApprovalStore();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();
    const workspacePath = '/tmp/chat-1';

    await bindings.upsert({
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
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
      shellStatus: 'inactive',
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z'
    });
    await approvals.create('chat-1', 'turn-1', {
      kind: 'permission',
      id: 'approval-1',
      createdAt: '2026-04-02T00:00:00.000Z',
      toolName: 'Bash',
      toolInput: {},
      suggestions: []
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals,
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-1',
      text: '/reset'
    });

    expect(result.kind).toBe('control');
    if (result.kind === 'control') {
      expect(result.response.format).toBe('reset-workspace-picker');
      if (result.response.format === 'reset-workspace-picker') {
        expect(result.response.options.defaultWorkspacePath).toBe(
          '/tmp/chat-1'
        );
        expect(result.response.options.currentWorkspacePath).toBe(
          '/tmp/chat-1'
        );
        expect(result.response.options.currentCwd).toBe('/tmp/chat-1/subdir');
      }
    }
    expect(runtime.dropCalls).toEqual([]);
    expect((await bindings.get('chat-1'))?.sessionId).toBe('session-1');
    expect(await approvals.listPending('chat-1')).toHaveLength(1);
    expect((await controls.get('chat-1'))?.cwd).toBe('/tmp/chat-1/subdir');
  });

  it('rebinds the workspace and resets agent and shell through /reset <path>', async () => {
    const runtime = new StubRuntime();
    const approvals = new InMemoryApprovalStore();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath: '/tmp/chat-1',
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
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
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z'
    });
    await approvals.create('chat-1', 'turn-1', {
      kind: 'permission',
      id: 'approval-1',
      createdAt: '2026-04-02T00:00:00.000Z',
      toolName: 'Bash',
      toolInput: {},
      suggestions: []
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals,
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchControlCommand(
      'chat-1',
      'reset',
      '/tmp/custom-workspace'
    );

    expect(result.format).toBe('text');
    expect(runtime.dropCalls).toEqual(['chat-1']);
    expect((await bindings.get('chat-1'))?.sessionId).toBeUndefined();
    expect((await bindings.get('chat-1'))?.workspacePath).toBe(
      '/tmp/custom-workspace'
    );
    expect(await approvals.listPending('chat-1')).toEqual([]);
    expect((await controls.get('chat-1'))?.cwd).toBe('/tmp/custom-workspace');
    expect((await controls.get('chat-1'))?.shellStatus).toBe('inactive');
  });

  it('shows the effective model through /agent model', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-model',
      workspaceId: 'chat-model',
      workspacePath: '/tmp/chat-model',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      model: 'claude-sonnet-4-6',
      metadata: {}
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-model',
      messageId: 'msg-model',
      text: '/agent model'
    });

    expect(result.kind).toBe('control');
    if (result.kind === 'control') {
      expect(result.response.format).toBe('agent-model-picker');
      if (result.response.format === 'agent-model-picker') {
        expect(result.response.currentModel).toBe('claude-sonnet-4-6');
        expect(result.response.options.map((option) => option.model)).toEqual([
          'default',
          'best',
          'sonnet',
          'opus',
          'haiku',
          'sonnet[1m]',
          'opus[1m]',
          'opusplan'
        ]);
        expect(
          result.response.options.find((option) => option.model === 'sonnet')
            ?.description
        ).toContain('claude-sonnet-4-6');
        expect(
          result.response.options.find((option) => option.model === 'opus')
            ?.description
        ).toContain('claude-opus-4-6');
        expect(
          result.response.options.find((option) => option.model === 'haiku')
            ?.description
        ).toContain('claude-haiku-4-5-20251001');
        expect(
          result.response.options.find(
            (option) => option.model === 'sonnet[1m]'
          )?.description
        ).toContain('claude-sonnet-4-6');
        expect(
          result.response.options.find((option) => option.model === 'opus[1m]')
            ?.description
        ).toContain('claude-opus-4-6');
      }
    }
  });

  it('shows the current permission mode through /agent mode', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-mode',
      workspaceId: 'chat-mode',
      workspacePath: '/tmp/chat-mode',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      mode: 'plan',
      metadata: {}
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-mode',
      messageId: 'msg-mode',
      text: '/agent mode'
    });

    expect(result.kind).toBe('control');
    if (result.kind === 'control') {
      expect(result.response.format).toBe('agent-mode-picker');
      if (result.response.format === 'agent-mode-picker') {
        expect(result.response.currentMode).toBe('plan');
        expect(result.response.options.map((option) => option.mode)).toEqual([
          'default',
          'acceptEdits',
          'bypassPermissions',
          'plan',
          'dontAsk'
        ]);
      }
    }
  });

  it('switches the model through /agent model <name> and resets the session', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-switch',
      workspaceId: 'chat-switch',
      workspacePath: '/tmp/chat-switch',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      sessionId: 'session-old',
      mode: 'default',
      model: 'claude-sonnet-4-6',
      metadata: {}
    });
    await controls.upsert({
      chatId: 'chat-switch',
      inputMode: 'agent',
      cwd: '/tmp/chat-switch/subdir',
      shellStatus: 'inactive',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z'
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-switch',
      messageId: 'msg-switch',
      text: '/agent model claude-opus-4-6'
    });

    expect(result.kind).toBe('control');
    expect(runtime.dropCalls).toEqual(['chat-switch']);
    expect((await bindings.get('chat-switch'))?.model).toBe('claude-opus-4-6');
    expect((await bindings.get('chat-switch'))?.sessionId).toBeUndefined();
    if (result.kind === 'control') {
      expect(result.response.text).toContain('Agent 模型已切换');
      expect(result.response.text).toContain('model: claude-opus-4-6');
      expect(result.response.text).toContain('source: chat-binding');
      expect(result.response.text).toContain('session: reset');
    }
  });

  it('switches to default model through /agent model default by clearing the override', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-model-default',
      workspaceId: 'chat-model-default',
      workspacePath: '/tmp/chat-model-default',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      sessionId: 'session-old',
      mode: 'default',
      model: 'claude-opus-4-6',
      metadata: {}
    });
    await controls.upsert({
      chatId: 'chat-model-default',
      inputMode: 'agent',
      cwd: '/tmp/chat-model-default',
      shellStatus: 'inactive',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z'
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-model-default',
      messageId: 'msg-model-default',
      text: '/agent model default'
    });

    expect(result.kind).toBe('control');
    expect((await bindings.get('chat-model-default'))?.model).toBeUndefined();
    if (result.kind === 'control') {
      expect(result.response.text).toContain('model: default');
      expect(result.response.text).toContain('source: runtime-default');
      expect(result.response.text).toContain('session: reset');
    }
  });

  it('adds a custom model option from ANTHROPIC_CUSTOM_MODEL_OPTION', async () => {
    const previous = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'partner/custom-model';
    try {
      const runtime = new StubRuntime();
      const controls = new InMemoryChatControlStateStore();
      const bindings = new InMemoryWorkspaceBindingStore();
      const shellExecutor = new StubShellExecutor();

      const orchestrator = new BridgeOrchestrator({
        runtime,
        approvals: new InMemoryApprovalStore(),
        bindings,
        controls,
        shellExecutor,
        transcripts: new InMemoryTranscriptStore(),
        workspaceRoot: '/tmp'
      });

      const result = await orchestrator.dispatchInbound({
        channel: 'feishu',
        chatId: 'chat-custom-model',
        messageId: 'msg-custom-model',
        text: '/agent model'
      });

      expect(result.kind).toBe('control');
      if (
        result.kind === 'control' &&
        result.response.format === 'agent-model-picker'
      ) {
        expect(
          result.response.options.some(
            (option) => option.model === 'partner/custom-model'
          )
        ).toBe(true);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
      } else {
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = previous;
      }
    }
  });

  it('switches permission mode through /agent mode <mode> without resetting the session', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    await bindings.upsert({
      chatId: 'chat-mode-switch',
      workspaceId: 'chat-mode-switch',
      workspacePath: '/tmp/chat-mode-switch',
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: '2026-04-04T00:00:00.000Z',
      runtime: 'claude',
      channel: 'feishu',
      sessionId: 'session-existing',
      mode: 'default',
      metadata: {}
    });

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-mode-switch',
      messageId: 'msg-mode-switch',
      text: '/agent mode bypass-permissions'
    });

    expect(result.kind).toBe('control');
    expect(runtime.dropCalls).toEqual([]);
    expect((await bindings.get('chat-mode-switch'))?.mode).toBe(
      'bypassPermissions'
    );
    expect((await bindings.get('chat-mode-switch'))?.sessionId).toBe(
      'session-existing'
    );
    if (result.kind === 'control') {
      expect(result.response.text).toContain('Agent 权限模式已切换');
      expect(result.response.text).toContain('mode: bypassPermissions');
      expect(result.response.text).toContain('session: preserved');
      expect(result.response.text).toContain('takesEffect: next-turn');
    }
  });

  it('reports invalid permission modes through /agent mode', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-mode-invalid',
      messageId: 'msg-mode-invalid',
      text: '/agent mode wrong-mode'
    });

    expect(result.kind).toBe('control');
    if (result.kind === 'control') {
      expect(result.response.text).toContain('未知权限模式: wrong-mode');
      expect(result.response.text).toContain(
        '/agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]'
      );
    }
  });

  it('executes /sx and persists cwd updates', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();
    const workspaceRoot = '/tmp/coding-claw-tests';

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-2',
      messageId: 'msg-2',
      text: '/sx pwd'
    });

    expect(result.kind).toBe('control');
    expect(shellExecutor.calls).toEqual([
      {
        cwd: `${workspaceRoot}/chat-2`,
        command: 'pwd'
      }
    ]);
    expect((await controls.get('chat-2'))?.cwd).toBe(
      `${workspaceRoot}/chat-2/next`
    );
    if (result.kind === 'control') {
      expect(result.response.text).toContain('$ pwd');
      expect(result.response.text).toContain('git: main');
    }
  });

  it('reports shell session state through /ss', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();
    shellExecutor.status = {
      active: true,
      running: true,
      sessionId: 'shell-42',
      pid: 4242
    };

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-tests'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-3',
      messageId: 'msg-3',
      text: '/ss'
    });

    expect(result.kind).toBe('control');
    expect((await controls.get('chat-3'))?.shellStatus).toBe('running');
    expect((await controls.get('chat-3'))?.shellSessionId).toBe('shell-42');
    if (result.kind === 'control') {
      expect(result.response.text).toContain('session: running');
      expect(result.response.text).toContain('sessionId: shell-42');
    }
  });

  it('does not pre-block commands only by name', async () => {
    const runtime = new StubRuntime();
    const controls = new InMemoryChatControlStateStore();
    const bindings = new InMemoryWorkspaceBindingStore();
    const shellExecutor = new StubShellExecutor();

    const orchestrator = new BridgeOrchestrator({
      runtime,
      approvals: new InMemoryApprovalStore(),
      bindings,
      controls,
      shellExecutor,
      transcripts: new InMemoryTranscriptStore(),
      workspaceRoot: '/tmp/coding-claw-tests'
    });

    const result = await orchestrator.dispatchInbound({
      channel: 'feishu',
      chatId: 'chat-4',
      messageId: 'msg-4',
      text: '/sx vim README.md'
    });

    expect(result.kind).toBe('control');
    expect(shellExecutor.calls).toEqual([
      {
        cwd: '/tmp/coding-claw-tests/chat-4',
        command: 'vim README.md'
      }
    ]);
    if (result.kind === 'control') {
      expect(result.response.text).toContain('$ vim README.md');
    }
  });
});

describe('LocalShellExecutor', () => {
  it('persists shell environment across commands and resets cleanly', async () => {
    const shellPath = process.env.SHELL || process.env.COMSPEC;
    if (!shellPath) {
      throw new Error('No test shell available in current environment.');
    }

    const resolvedShellPath = shellPath.toLowerCase().endsWith('bash')
      ? join(dirname(shellPath), 'bash.exe')
      : shellPath;
    const executor = new LocalShellExecutor({
      shellPath: resolvedShellPath
    });
    const chatId = 'chat-local-shell';
    const workspacePath = '/tmp';

    const first = await executor.execute({
      chatId,
      workspacePath,
      cwd: workspacePath,
      command: 'export CODING_CLAW_TEST_VAR=hello'
    });
    expect(first.exitCode).toBe(0);
    expect(first.sessionId).toBeTruthy();

    const second = await executor.execute({
      chatId,
      workspacePath,
      cwd: first.cwd,
      command: 'printf %s "$CODING_CLAW_TEST_VAR"'
    });
    expect(second.stdout).toContain('hello');
    expect(second.sessionId).toBe(first.sessionId);

    await executor.reset(chatId);

    const third = await executor.execute({
      chatId,
      workspacePath,
      cwd: workspacePath,
      command: 'printf %s "${CODING_CLAW_TEST_VAR:-missing}"'
    });
    expect(third.stdout).toContain('missing');

    await executor.reset(chatId);
  });
});
