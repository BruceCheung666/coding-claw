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
import { CUSTOM_SYSTEM_PROMPT_METADATA_KEY } from './types.js';
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
  SessionContextProvider,
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
  sessionContextProvider?: SessionContextProvider;
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

  async getBindingSnapshot(chatId: string): Promise<WorkspaceBinding> {
    return this.getOrCreateBinding(chatId);
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
      case 'new':
        return this.handleNewSession(argsText, binding, control);
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
    const parsed = parseResetArgs(argsText);
    if (!parsed) {
      return {
        format: 'text',
        text: 'reset 参数格式无效。'
      };
    }

    const nextWorkspacePath = parsed.workspacePath.trim();
    if (!nextWorkspacePath) {
      return {
        format: 'reset-workspace-picker',
        options: {
          defaultWorkspacePath: this.getDefaultWorkspacePath(binding.chatId),
          currentWorkspacePath: binding.workspacePath,
          currentCwd: control.cwd,
          currentCustomSystemPrompt:
            binding.metadata[CUSTOM_SYSTEM_PROMPT_METADATA_KEY] ?? ''
        }
      };
    }

    if (!isCrossPlatformAbsolutePath(nextWorkspacePath)) {
      return {
        format: 'text',
        text: 'workspace 必须是绝对路径。'
      };
    }

    await this.resetAgentState(binding, control, {
      nextWorkspacePath,
      resetShell: true,
      customSystemPrompt: parsed.customSystemPrompt
    });

    return {
      format: 'text',
      text: [
        '已重置 workspace、shell 与会话。',
        `cwd: ${control.cwd}`,
        `workspace: ${binding.workspacePath}`,
        `system prompt: ${binding.metadata[CUSTOM_SYSTEM_PROMPT_METADATA_KEY] ? '已设置' : '未设置'}`
      ].join('\n')
    };
  }

  private async handleNewSession(
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    if (argsText.trim()) {
      return {
        format: 'text',
        text: '用法: /new'
      };
    }

    await this.resetAgentState(binding, control, {
      nextWorkspacePath: binding.workspacePath,
      resetShell: false
    });

    return {
      format: 'text',
      text: [
        '已开启新会话（保留当前 workspace 与 cwd）。',
        `cwd: ${control.cwd}`,
        `workspace: ${binding.workspacePath}`
      ].join('\n')
    };
  }

  private async handleShellExec(
    argsText: string,
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const command = argsText.trim();
    if (!command) {
      return {
        format: 'text',
        text: '用法: /sx <command>'
      };
    }

    const result = await this.deps.shellExecutor.execute({
      chatId: binding.chatId,
      workspacePath: binding.workspacePath,
      cwd: control.cwd,
      command
    });

    control.cwd = result.cwd;
    control.shellSessionId = result.sessionId;
    control.shellStatus = 'ready';
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);

    return {
      format: 'text',
      text: formatShellExecution(
        command,
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

    const lines = [
      `workspace: ${binding.workspacePath}`,
      `cwd: ${control.cwd}`,
      `active: ${shell.active ? 'yes' : 'no'}`,
      `running: ${shell.running ? 'yes' : 'no'}`,
      `session: ${control.shellStatus}`
    ];
    if (shell.sessionId) {
      lines.push(`sessionId: ${shell.sessionId}`);
    }
    if (shell.pid) {
      lines.push(`pid: ${shell.pid}`);
    }

    return {
      format: 'text',
      text: lines.join('\n')
    };
  }

  private async handleChatStatus(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    const runtime = await this.getOrCreateSession(binding);
    const status = await runtime.getStatus();
    const shell = await this.deps.shellExecutor.getStatus(binding.chatId);
    applyShellSnapshot(control, shell);
    control.updatedAt = new Date().toISOString();
    await this.deps.controls.upsert(control);

    const lines = [
      `chatId: ${binding.chatId}`,
      `workspace: ${binding.workspacePath}`,
      `cwd: ${control.cwd}`,
      `mode: ${binding.mode}`,
      `model: ${binding.model ?? '(default)'}`,
      `agent: ${status.state}`,
      `shell active: ${shell.active ? 'yes' : 'no'}`,
      `shell running: ${shell.running ? 'yes' : 'no'}`
    ];

    if (status.sessionId) {
      lines.push(`sessionId: ${status.sessionId}`);
    }
    if (shell.sessionId) {
      lines.push(`shell sessionId: ${shell.sessionId}`);
    }
    if (status.contextUsage) {
      lines.push(
        `context: ${formatContextUsage(status.contextUsage.percentage, status.contextUsage.totalTokens, status.contextUsage.maxTokens)}`
      );
    }

    return {
      format: 'text',
      text: lines.join('\n')
    };
  }

  private async handleAgentMode(
    argsText: string,
    binding: WorkspaceBinding
  ): Promise<ControlResponse> {
    const nextModeInput = argsText.trim();
    if (!nextModeInput) {
      return {
        format: 'agent-mode-picker',
        currentMode: binding.mode,
        options: buildAgentModeOptions()
      };
    }

    const nextMode = normalizePermissionMode(nextModeInput);
    if (!nextMode) {
      return {
        format: 'text',
        text: [
          `未知权限模式: ${nextModeInput}`,
          '/agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]'
        ].join('\n')
      };
    }

    if (binding.mode === nextMode) {
      return {
        format: 'text',
        text: [
          'Agent 权限模式未变化',
          `mode: ${binding.mode}`,
          'session: preserved',
          'takesEffect: immediate'
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
    const nextModelInput = argsText.trim();
    const options = buildAgentModelOptions();
    if (!nextModelInput) {
      return {
        format: 'agent-model-picker',
        currentModel: binding.model ?? 'default',
        options
      };
    }

    const resolvedModel = resolveAgentModelInput(nextModelInput, options);
    if (!resolvedModel) {
      return {
        format: 'text',
        text: `不支持的模型: ${nextModelInput}`
      };
    }

    const nextModel = resolvedModel === 'default' ? undefined : resolvedModel;
    if (binding.model === nextModel) {
      return {
        format: 'text',
        text: [
          'Agent 模型未变化',
          `model: ${nextModel ?? 'default'}`,
          `source: ${nextModel ? 'chat-binding' : 'runtime-default'}`,
          'session: preserved'
        ].join('\n')
      };
    }

    await this.resetAgentState(binding, control, {
      nextWorkspacePath: binding.workspacePath,
      resetShell: false,
      nextModel,
      clearModelOverride: nextModel === undefined
    });

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

  private async handleAgentStatus(
    binding: WorkspaceBinding,
    control: ChatControlState
  ): Promise<ControlResponse> {
    return this.handleChatStatus(binding, control);
  }

  private async resetAgentState(
    binding: WorkspaceBinding,
    control: ChatControlState,
    options: {
      nextWorkspacePath: string;
      resetShell: boolean;
      nextModel?: string;
      clearModelOverride?: boolean;
      customSystemPrompt?: string;
    }
  ): Promise<void> {
    await this.deps.runtime.dropSession(binding.chatId);
    this.sessions.delete(binding.chatId);
    await this.deps.approvals.clearChat(binding.chatId);
    await this.deps.transcripts.clearChat(binding.chatId);

    const now = new Date().toISOString();
    binding.workspacePath = options.nextWorkspacePath;
    binding.workspaceId = binding.chatId;
    binding.sessionId = undefined;
    binding.model = options.clearModelOverride
      ? undefined
      : (options.nextModel ?? binding.model);
    if (typeof options.customSystemPrompt !== 'undefined') {
      const normalizedPrompt = options.customSystemPrompt.trim();
      if (normalizedPrompt) {
        binding.metadata[CUSTOM_SYSTEM_PROMPT_METADATA_KEY] = normalizedPrompt;
      } else {
        delete binding.metadata[CUSTOM_SYSTEM_PROMPT_METADATA_KEY];
      }
    }
    binding.updatedAt = now;
    mkdirSync(binding.workspacePath, { recursive: true });
    await this.deps.bindings.upsert(binding);

    if (options.resetShell) {
      await this.deps.shellExecutor.reset(binding.chatId);
      control.cwd = binding.workspacePath;
      control.shellSessionId = undefined;
      control.shellStatus = 'inactive';
    } else {
      const shell = await this.deps.shellExecutor.getStatus(binding.chatId);
      applyShellSnapshot(control, shell);
    }

    control.lastAgentResetAt = now;
    control.updatedAt = now;
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
  control.shellSessionId = shell.sessionId;
}

function buildAgentModeOptions(): AgentModeControlOption[] {
  return [
    {
      mode: 'default',
      label: 'Default',
      description: '按默认权限策略执行。'
    },
    {
      mode: 'acceptEdits',
      label: 'Accept Edits',
      description: '允许常规编辑，必要时仍请求确认。'
    },
    {
      mode: 'bypassPermissions',
      label: 'Bypass Permissions',
      description: '跳过大多数权限确认，适合受信任环境。'
    },
    {
      mode: 'plan',
      label: 'Plan',
      description: '优先规划实现，并在执行前请求批准。'
    },
    {
      mode: 'dontAsk',
      label: 'Do not ask',
      description: '尽量减少确认提示。'
    }
  ];
}

function buildAgentModelOptions(): AgentModelControlOption[] {
  const options: AgentModelControlOption[] = [
    {
      model: 'default',
      label: 'default',
      description: '使用 runtime 默认模型。'
    },
    {
      model: 'best',
      label: 'best',
      description: '使用 Claude Code 默认 best 档位。'
    },
    {
      model: 'sonnet',
      label: 'sonnet',
      description: 'claude-sonnet-4-6'
    },
    {
      model: 'opus',
      label: 'opus',
      description: 'claude-opus-4-6'
    },
    {
      model: 'haiku',
      label: 'haiku',
      description: 'claude-haiku-4-5-20251001'
    },
    {
      model: 'sonnet[1m]',
      label: 'sonnet[1m]',
      description: 'claude-sonnet-4-6'
    },
    {
      model: 'opus[1m]',
      label: 'opus[1m]',
      description: 'claude-opus-4-6'
    },
    {
      model: 'opusplan',
      label: 'opusplan',
      description: 'Claude Code 规划优先档位。'
    }
  ];

  const customModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModel && !options.some((option) => option.model === customModel)) {
    options.push({
      model: customModel,
      label: customModel,
      description: `Custom model: ${customModel}`
    });
  }

  return options;
}

function normalizePermissionMode(value: string): PermissionMode | undefined {
  const normalized = value.trim();
  const aliasMap: Record<string, PermissionMode> = {
    default: 'default',
    acceptedits: 'acceptEdits',
    'accept-edits': 'acceptEdits',
    bypasspermissions: 'bypassPermissions',
    'bypass-permissions': 'bypassPermissions',
    plan: 'plan',
    dontask: 'dontAsk',
    'dont-ask': 'dontAsk'
  };

  return aliasMap[normalized.toLowerCase()];
}

function resolveAgentModelInput(
  value: string,
  options: AgentModelControlOption[]
): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'default') {
    return 'default';
  }

  if (normalized === 'claude-sonnet-4-6' || normalized === 'claude-opus-4-6') {
    return normalized;
  }

  if (options.some((option) => option.model === normalized)) {
    return normalized;
  }

  const customModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModel === normalized) {
    return normalized;
  }

  return undefined;
}

function formatContextUsage(
  percentage?: number,
  totalTokens?: number,
  maxTokens?: number
): string {
  const ratio =
    percentage === undefined ? 'unknown' : `${Math.round(percentage * 100)}%`;
  const total = totalTokens === undefined ? '?' : String(totalTokens);
  const max = maxTokens === undefined ? '?' : String(maxTokens);
  return `${ratio} (${total}/${max})`;
}

function parseResetArgs(
  argsText: string
): { workspacePath: string; customSystemPrompt?: string } | null {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return { workspacePath: '' };
  }

  if (!trimmed.startsWith('{')) {
    return {
      workspacePath: trimmed
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      workspacePath?: unknown;
      customSystemPrompt?: unknown;
    };
    return {
      workspacePath:
        typeof parsed.workspacePath === 'string' ? parsed.workspacePath : '',
      customSystemPrompt:
        typeof parsed.customSystemPrompt === 'string'
          ? parsed.customSystemPrompt
          : undefined
    };
  } catch {
    return null;
  }
}
