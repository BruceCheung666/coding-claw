import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type {
  AgentRuntime,
  ApprovalStore,
  ChatControlStateStore,
  RenderSurface,
  ShellExecutor,
  TranscriptStore,
  WorkspaceBindingStore
} from './contracts.js';
import {
  COMMAND_REGISTRY,
  parseInboundText,
  type CommandId
} from './control/CommandRegistry.js';
import {
  createInitialRenderModel,
  reduceRenderModel
} from './render/reduceRenderModel.js';
import { isCrossPlatformAbsolutePath } from './pathUtils.js';
import { errorToLogObject, logDebug, logError, logWarn } from './logging.js';
import type {
  AgentModelControlOption,
  AgentModeControlOption,
  BridgeEvent,
  ChatControlState,
  ControlResponse,
  InboundChatMessage,
  InboundDispatchResult,
  InteractionResolution,
  PendingInteraction,
  PermissionMode,
  WorkspaceBinding
} from './types.js';

export interface BridgeOrchestratorDeps {
  runtime: AgentRuntime;
  transcripts: TranscriptStore;
  bindings: WorkspaceBindingStore;
  approvals: ApprovalStore;
  controls: ChatControlStateStore;
  shellExecutor: ShellExecutor;
  workspaceRoot: string;
}

export class BridgeOrchestrator {
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly sessions = new Map<
    string,
    Awaited<ReturnType<AgentRuntime['getOrCreateSession']>>
  >();

  constructor(private readonly deps: BridgeOrchestratorDeps) {}

  async dispatchInbound(
    message: InboundChatMessage
  ): Promise<InboundDispatchResult> {
    const parsed = parseInboundText(message.text);
    if (parsed.kind === 'runtime') {
      return {
        kind: 'runtime',
        message: {
          ...message,
          text: parsed.text
        }
      };
    }

    if (parsed.kind === 'unknown-command') {
      return {
        kind: 'control',
        response: {
          format: 'text',
          text: buildUnknownCommandText(parsed.commandName)
        }
      };
    }

    const response = await this.dispatchControlCommand(
      message.chatId,
      parsed.match.id,
      parsed.match.argsText
    );
    return {
      kind: 'control',
      response
    };
  }

  async dispatchControlCommand(
    chatId: string,
    commandId: CommandId,
    argsText: string
  ): Promise<ControlResponse> {
    const binding = await this.getOrCreateBinding(chatId);
    const control = await this.getOrCreateControlState(
      chatId,
      binding.workspacePath
    );
    return this.executeControlCommand(commandId, argsText, binding, control);
  }

  async getChatControlSnapshot(chatId: string): Promise<{
    cwd: string;
    workspacePath: string;
    defaultWorkspacePath: string;
  }> {
    const binding = await this.getOrCreateBinding(chatId);
    const control = await this.getOrCreateControlState(
      chatId,
      binding.workspacePath
    );
    return {
      cwd: control.cwd,
      workspacePath: binding.workspacePath,
      defaultWorkspacePath: this.getDefaultWorkspacePath(chatId)
    };
  }

  getChatExecutionSnapshot(chatId: string): {
    running: boolean;
    willQueue: boolean;
    sessionId?: string;
  } {
    const session = this.sessions.get(chatId);
    return {
      running: session?.busy ?? false,
      willQueue: this.chatLocks.has(chatId),
      sessionId: session?.ref.sessionId
    };
  }

  async injectIntoRunningTurn(chatId: string, text: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session || !session.busy) {
      throw new Error('当前没有可注入的运行中会话。');
    }

    await session.injectUserMessage(text, 'now');
  }

  async handleInbound(
    message: InboundChatMessage,
    surface: RenderSurface
  ): Promise<void> {
    logDebug('[bridge] enqueue inbound turn', {
      chatId: message.chatId,
      messageId: message.messageId,
      textPreview: message.text.slice(0, 120)
    });
    const previous = this.chatLocks.get(message.chatId) ?? Promise.resolve();
    const runCurrentTurn = async () => {
      await this.processInbound(message, surface);
    };
    const current = previous.then(runCurrentTurn, runCurrentTurn);

    this.chatLocks.set(message.chatId, current);
    try {
      await current;
    } finally {
      if (this.chatLocks.get(message.chatId) === current) {
        this.chatLocks.delete(message.chatId);
      }
    }
  }

  async resolveInteraction(
    chatId: string,
    interactionId: string,
    resolution: InteractionResolution
  ): Promise<void> {
    await this.deps.approvals.resolve(chatId, interactionId, resolution);

    const session = this.sessions.get(chatId);
    if (!session) {
      logWarn(
        '[bridge] interaction resolved without an active runtime session',
        {
          chatId,
          interactionId,
          resolution
        }
      );
      return;
    }

    session.resolveInteraction(interactionId, resolution);
  }

  async resolveInteractionById(
    interactionId: string,
    resolution: InteractionResolution
  ): Promise<{ chatId: string; interaction: PendingInteraction } | undefined> {
    const record = await this.deps.approvals.lookup(interactionId);
    if (!record) {
      return undefined;
    }

    await this.resolveInteraction(record.chatId, interactionId, resolution);
    await this.deps.transcripts.append({
      type: 'interaction.resolved',
      chatId: record.chatId,
      turnId: record.turnId,
      interactionId,
      resolution
    });
    return record;
  }

  async listPendingInteractions(chatId: string): Promise<PendingInteraction[]> {
    return this.deps.approvals.listPending(chatId);
  }

  private async processInbound(
    message: InboundChatMessage,
    surface: RenderSurface
  ): Promise<void> {
    const binding = await this.getOrCreateBinding(message.chatId);
    const session = await this.getOrCreateSession(binding);
    const turnId = randomUUID();
    let model = createInitialRenderModel(turnId, message.text);
    logDebug('[bridge] start turn', {
      chatId: message.chatId,
      messageId: message.messageId,
      turnId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId ?? null
    });

    try {
      await surface.startTurn(message, turnId);

      const startEvent: BridgeEvent = {
        type: 'turn.started',
        chatId: message.chatId,
        turnId,
        prompt: message.text,
        startedAt: new Date().toISOString()
      };

      await this.persistAndRender(startEvent, surface, model);

      for await (const event of session.runTurn({
        chatId: message.chatId,
        turnId,
        prompt: message.text,
        binding
      })) {
        if (event.type === 'interaction.requested') {
          await this.deps.approvals.create(
            message.chatId,
            turnId,
            event.interaction
          );
        }

        await this.persistAndRender(event, surface, model);
        model = reduceRenderModel(model, event);

        if (event.type === 'turn.completed' && event.sessionId) {
          binding.sessionId = event.sessionId;
          binding.updatedAt = new Date().toISOString();
          await this.deps.bindings.upsert(binding);
        }
      }

      await surface.complete(turnId);
      logDebug('[bridge] complete turn', {
        chatId: message.chatId,
        messageId: message.messageId,
        turnId,
        sessionId: binding.sessionId ?? null
      });
    } catch (error) {
      await surface.error(
        turnId,
        error instanceof Error ? error.message : String(error)
      );
      logError('[bridge] turn failed', {
        chatId: message.chatId,
        messageId: message.messageId,
        turnId,
        error: errorToLogObject(error)
      });
      throw error;
    }
  }

  private async executeControlCommand(
    commandId: CommandId,
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    switch (commandId) {
      case 'agent.mode':
        return this.handleAgentMode(argsText, binding);
      case 'agent.model':
        return this.handleAgentModel(argsText, binding, control);
      case 'agent.status':
        return this.handleAgentStatus(binding, control);
      case 'reset':
        return this.handleReset(argsText, binding, control);
      case 'shell.exec':
        return this.handleShellExec(argsText, binding, control);
      case 'shell.status':
        return this.handleShellStatus(binding, control);
      case 'chat.status':
        return this.handleChatStatus(binding, control);
      case 'help':
        return {
          format: 'text',
          text: buildHelpText()
        };
    }
  }

  private async handleReset(
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const nextWorkspacePath = argsText.trim();
    if (!nextWorkspacePath) {
      return {
        format: 'reset-workspace-picker',
        options: {
          defaultWorkspacePath: this.getDefaultWorkspacePath(binding.chatId),
          currentWorkspacePath: binding.workspacePath,
          currentCwd: control.cwd
        }
      };
    }

    if (!isCrossPlatformAbsolutePath(nextWorkspacePath)) {
      return {
        format: 'text',
        text: 'reset 目标工作区必须是绝对路径。'
      };
    }

    await this.resetAgentState(binding, control);
    await this.deps.shellExecutor.reset(binding.chatId);
    mkdirSync(nextWorkspacePath, { recursive: true });
    binding.workspacePath = nextWorkspacePath;
    binding.updatedAt = new Date().toISOString();
    await this.deps.bindings.upsert(binding);
    control.cwd = nextWorkspacePath;
    control.shellStatus = 'inactive';
    control.shellSessionId = undefined;
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);

    return {
      format: 'text',
      text: [
        '工作区已重置',
        `cwd: ${control.cwd}`,
        `workspace: ${binding.workspacePath}`
      ].join('\n')
    };
  }

  private async handleAgentStatus(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const session = this.sessions.get(binding.chatId);
    const pending = await this.deps.approvals.listPending(binding.chatId);
    const status = session
      ? await session.getStatus()
      : {
          state: 'not-started' as const,
          supportsContextUsage: false
        };
    const sessionId = status.sessionId ?? binding.sessionId ?? '(none)';
    const contextUsage = status.contextUsage;
    const contextTokens =
      contextUsage?.totalTokens !== undefined &&
      contextUsage.maxTokens !== undefined &&
      contextUsage.percentage !== undefined
        ? `${contextUsage.totalTokens}/${contextUsage.maxTokens} (${formatContextPercentage(contextUsage.percentage)})`
        : 'unavailable';
    return {
      format: 'text',
      text: [
        'Agent 状态',
        `session: ${status.state}`,
        `sessionId: ${sessionId}`,
        `cwd: ${control.cwd}`,
        `pendingInteractions: ${pending.length}`,
        `permissionMode: ${binding.mode}`,
        `model: ${binding.model ?? '(default)'}`,
        `contextTokens: ${contextTokens}`
      ].join('\n')
    };
  }

  private async handleAgentMode(
    argsText: string,
    binding: WorkspaceBinding
  ): Promise<ControlResponse> {
    const rawMode = argsText.trim();
    if (!rawMode) {
      return {
        format: 'agent-mode-picker',
        currentMode: binding.mode,
        options: AGENT_MODE_OPTIONS
      };
    }

    const nextMode = parsePermissionMode(rawMode);
    if (!nextMode) {
      return {
        format: 'text',
        text: [
          `未知权限模式: ${rawMode}`,
          '用法: /agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]'
        ].join('\n')
      };
    }

    binding.mode = nextMode;
    binding.updatedAt = new Date().toISOString();
    await this.deps.bindings.upsert(binding);

    return {
      format: 'text',
      text: [
        'Agent 权限模式已切换',
        `mode: ${binding.mode}`,
        'session: preserved',
        'takesEffect: next-turn'
      ].join('\n')
    };
  }

  private async handleAgentModel(
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const nextModel = argsText.trim();
    if (!nextModel) {
      return {
        format: 'agent-model-picker',
        currentModel: binding.model ?? 'default',
        options: buildAgentModelOptions()
      };
    }

    binding.model = nextModel === 'default' ? undefined : nextModel;
    binding.updatedAt = new Date().toISOString();
    await this.deps.bindings.upsert(binding);
    await this.resetAgentState(binding, control);

    return {
      format: 'text',
      text: [
        'Agent 模型已切换',
        `model: ${binding.model ?? 'default'}`,
        `source: ${binding.model ? 'chat-binding' : 'runtime-default'}`,
        'session: reset'
      ].join('\n')
    };
  }

  private async handleShellExec(
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    if (!argsText.trim()) {
      return {
        format: 'text',
        text: '用法: /shell exec <command>\n别名: /sx <command>'
      };
    }

    const result = await this.deps.shellExecutor.execute({
      chatId: binding.chatId,
      workspacePath: binding.workspacePath,
      cwd: control.cwd,
      command: argsText
    });

    control.cwd = result.cwd;
    control.shellStatus = 'ready';
    control.shellSessionId = result.sessionId;
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);

    return {
      format: 'text',
      text: formatShellExecution(
        argsText,
        result.exitCode,
        result.stdout,
        result.stderr,
        result.cwd,
        result.gitBranch
      )
    };
  }

  private async handleShellStatus(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const shell = await this.deps.shellExecutor.getStatus(binding.chatId);
    applyShellSnapshot(control, shell);
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);

    return {
      format: 'text',
      text: [
        'Shell 状态',
        `session: ${shell.active ? (shell.running ? 'running' : 'ready') : 'inactive'}`,
        `sessionId: ${shell.sessionId ?? '(none)'}`,
        `pid: ${shell.pid ?? '(none)'}`,
        `cwd: ${control.cwd}`
      ].join('\n')
    };
  }

  private async handleChatStatus(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const session = this.sessions.get(binding.chatId);
    const pending = await this.deps.approvals.listPending(binding.chatId);
    const shell = await this.deps.shellExecutor.getStatus(binding.chatId);
    applyShellSnapshot(control, shell);
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);
    return {
      format: 'text',
      text: [
        'Chat 状态',
        `cwd: ${control.cwd}`,
        `inputMode: ${control.inputMode}`,
        `shellStatus: ${control.shellStatus}`,
        `shellSessionId: ${control.shellSessionId ?? '(none)'}`,
        `agentSession: ${session ? (session.busy ? 'running' : 'idle') : 'not-started'}`,
        `sessionId: ${binding.sessionId ?? '(none)'}`,
        `pendingInteractions: ${pending.length}`,
        `workspace: ${binding.workspacePath}`
      ].join('\n')
    };
  }

  private async resetAgentState(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<void> {
    const session = this.sessions.get(binding.chatId);
    session?.abort();
    this.sessions.delete(binding.chatId);
    await this.deps.runtime.dropSession(binding.chatId);
    await this.deps.approvals.clearChat(binding.chatId);

    binding.sessionId = undefined;
    binding.updatedAt = new Date().toISOString();
    await this.deps.bindings.upsert(binding);

    control.lastAgentResetAt = new Date().toISOString();
    control.updatedAt = control.lastAgentResetAt;
    await this.deps.controls.upsert(control);
  }

  private async persistAndRender(
    event: BridgeEvent,
    surface: RenderSurface,
    model: ReturnType<typeof createInitialRenderModel>
  ): Promise<void> {
    await this.deps.transcripts.append(event);
    await surface.apply(event);
    const nextModel = reduceRenderModel(model, event);
    await surface.render(nextModel);
  }

  private async getOrCreateBinding(chatId: string): Promise<WorkspaceBinding> {
    const existing = await this.deps.bindings.get(chatId);
    if (existing) {
      mkdirSync(existing.workspacePath, { recursive: true });
      return existing;
    }

    const now = new Date().toISOString();
    const binding = {
      chatId,
      workspaceId: chatId,
      workspacePath: this.getDefaultWorkspacePath(chatId),
      createdAt: now,
      updatedAt: now,
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    } satisfies WorkspaceBinding;
    mkdirSync(binding.workspacePath, { recursive: true });
    return this.deps.bindings.upsert(binding);
  }

  private getDefaultWorkspacePath(chatId: string): string {
    return `${this.deps.workspaceRoot}/${chatId}`;
  }

  private async getOrCreateControlState(
    chatId: string,
    workspacePath: string
  ): Promise<ChatControlState> {
    const existing = await this.deps.controls.get(chatId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    return this.deps.controls.upsert({
      chatId,
      inputMode: 'agent',
      cwd: workspacePath,
      shellStatus: 'inactive',
      createdAt: now,
      updatedAt: now
    });
  }

  private async getOrCreateSession(binding: WorkspaceBinding) {
    const cached = this.sessions.get(binding.chatId);
    if (cached) {
      return cached;
    }

    const session = await this.deps.runtime.getOrCreateSession(binding);
    this.sessions.set(binding.chatId, session);
    return session;
  }
}

function buildUnknownCommandText(commandName: string): string {
  const rendered = commandName ? `未知命令: /${commandName}` : '未知命令';
  return `${rendered}\n输入 /help 查看可用命令\n如需把 / 开头文本发给 Agent，请使用 // 前缀。`;
}

function buildHelpText(): string {
  const lines = [
    'Bridge Commands',
    ...COMMAND_REGISTRY.map(
      (command) => `${command.usage} - ${command.description}`
    ),
    'Slash Escape',
    '//foo -> 发给 Agent 的文本是 /foo',
    '///foo -> 发给 Agent 的文本是 //foo'
  ];
  return lines.join('\n');
}

function formatShellExecution(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  cwd: string,
  gitBranch?: string | null
): string {
  const output = [stdout.trimEnd(), stderr.trimEnd()]
    .filter(Boolean)
    .join('\n');
  const lines = [`$ ${command}`, `exitCode: ${exitCode}`, `cwd: ${cwd}`];
  if (gitBranch) {
    lines.push(`git: ${gitBranch}`);
  }
  lines.push(output || '(no output)');
  return truncateText(lines.join('\n'), 4000);
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 15)}\n...(truncated)`;
}

function applyShellSnapshot(
  control: ChatControlState,
  shell: { active: boolean; running: boolean; sessionId?: string }
): void {
  control.shellStatus = shell.active
    ? shell.running
      ? 'running'
      : 'ready'
    : 'inactive';
  control.shellSessionId = shell.active ? shell.sessionId : undefined;
}

function formatContextPercentage(value: number): string {
  const normalized = value <= 1 ? value * 100 : value;
  const rounded =
    normalized >= 10
      ? Math.round(normalized)
      : Math.round(normalized * 10) / 10;
  return `${rounded}%`;
}

function parsePermissionMode(value: string): PermissionMode | undefined {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'default':
      return 'default';
    case 'acceptedits':
    case 'accept-edits':
      return 'acceptEdits';
    case 'bypasspermissions':
    case 'bypass-permissions':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'dontask':
    case 'dont-ask':
      return 'dontAsk';
    default:
      return undefined;
  }
}

const AGENT_MODE_OPTIONS: AgentModeControlOption[] = [
  {
    mode: 'default',
    label: 'default',
    description: '工作区内常规开发操作默认放行，高风险动作再确认。'
  },
  {
    mode: 'acceptEdits',
    label: 'acceptEdits',
    description: '对常规编辑更宽松，但敏感路径和高风险动作仍受约束。'
  },
  {
    mode: 'bypassPermissions',
    label: 'bypassPermissions',
    description: '尽量跳过权限确认，适合你明确要快速推进时使用。'
  },
  {
    mode: 'plan',
    label: 'plan',
    description: '优先规划与低风险探索，高风险动作继续要求确认。'
  },
  {
    mode: 'dontAsk',
    label: 'dontAsk',
    description: '对需确认的动作更保守，适合只看不改或最小化执行。'
  }
];

function buildAgentModelOptions(): AgentModelControlOption[] {
  // Runtime default model comes from CLAUDE_MODEL. The picker below exposes
  // chat-level overrides and documents how the alias targets currently map.
  const sonnetTarget =
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || 'claude-sonnet-4-6';
  const opusTarget =
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || 'claude-opus-4-6';
  const haikuTarget =
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    'claude-haiku-4-5-20251001';
  const sonnet1mTarget =
    process.env.ANTHROPIC_DEFAULT_SONNET_1M_MODEL?.trim() || sonnetTarget;
  const opus1mTarget =
    process.env.ANTHROPIC_DEFAULT_OPUS_1M_MODEL?.trim() || opusTarget;
  const disable1m = ['1', 'true', 'yes', 'on'].includes(
    (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT ?? '').trim().toLowerCase()
  );

  const options: AgentModelControlOption[] = [
    {
      model: 'default',
      label: 'default',
      description:
        '清除当前模型覆盖，回到 Claude Code / 当前账号层级的默认模型。'
    },
    {
      model: 'best',
      label: 'best',
      description: '选择当前最强的可用模型；在当前官方语义下通常等价于 opus。'
    },
    {
      model: 'sonnet',
      label: 'sonnet',
      description: formatAliasDescription('通用主力模型 alias。', sonnetTarget)
    },
    {
      model: 'opus',
      label: 'opus',
      description: formatAliasDescription('更强推理能力 alias。', opusTarget)
    },
    {
      model: 'haiku',
      label: 'haiku',
      description: formatAliasDescription('更快更轻量的 alias。', haikuTarget)
    },
    ...(!disable1m
      ? ([
          {
            model: 'sonnet[1m]',
            label: 'sonnet[1m]',
            description: formatAliasDescription(
              '1M 上下文 Sonnet alias，适合超大仓库或长文档场景。',
              sonnet1mTarget
            )
          },
          {
            model: 'opus[1m]',
            label: 'opus[1m]',
            description: formatAliasDescription(
              '1M 上下文 Opus alias，适合超长上下文深度分析。',
              opus1mTarget
            )
          }
        ] satisfies AgentModelControlOption[])
      : []),
    {
      model: 'opusplan',
      label: 'opusplan',
      description: '规划/方案类场景使用的 Opus plan alias。'
    }
  ];

  const customModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModel) {
    options.push({
      model: customModel,
      label: customModel,
      description: '来自 ANTHROPIC_CUSTOM_MODEL_OPTION 的自定义模型项。'
    });
  }

  return options;
}

function formatAliasDescription(
  prefix: string,
  target: string | undefined
): string {
  return target ? `${prefix} 当前映射: ${target}` : prefix;
}
