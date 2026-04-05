import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource
} from '@anthropic-ai/claude-agent-sdk';
import {
  errorToLogObject,
  logDebug,
  logError,
  logWarn
} from '@coding-claw/core';
import type {
  AgentSummary,
  BridgeEvent,
  InteractionResolution,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeTurnInput,
  RuntimeUserMessagePriority,
  TaskSummary
} from '@coding-claw/core';
import { PermissionPolicy } from '../permissions/PermissionPolicy.js';
import { buildSystemPrompt } from '../prompt/buildSystemPrompt.js';
import { SubagentDrainController } from './SubagentDrainController.js';

interface PendingAgentToolUse {
  toolUseId: string;
  name: string;
  agentType: string;
  description?: string;
}

export interface ClaudeRuntimeSessionOptions {
  model?: string;
  defaultTools?: string[];
  language?: string;
  mcpServers?: string[];
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  extraArgs?: Record<string, string | null>;
  enableAgentTeams?: boolean;
}

interface QueuedItem {
  value?: BridgeEvent;
  done: boolean;
}

class AsyncEventQueue implements AsyncIterable<BridgeEvent> {
  private readonly values: QueuedItem[] = [];
  private readonly waiters: Array<(item: QueuedItem) => void> = [];

  push(value: BridgeEvent): void {
    const item: QueuedItem = { value, done: false };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.values.push(item);
  }

  close(): void {
    const item: QueuedItem = { done: true };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.values.push(item);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BridgeEvent> {
    while (true) {
      const item = await this.nextItem();
      if (item.done) {
        return;
      }
      yield item.value!;
    }
  }

  private async nextItem(): Promise<QueuedItem> {
    const item = this.values.shift();
    if (item) {
      return item;
    }
    return new Promise<QueuedItem>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<IteratorResult<T>> = [];
  private readonly waiters: Array<(item: IteratorResult<T>) => void> = [];
  private closed = false;

  enqueue(value: T): void {
    if (this.closed) {
      throw new Error('Input stream is already closed.');
    }

    const item: IteratorResult<T> = {
      value,
      done: false
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.values.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const item: IteratorResult<T> = {
      value: undefined,
      done: true
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.values.push(item);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = await this.nextItem();
      if (item.done) {
        return;
      }
      yield item.value;
    }
  }

  private async nextItem(): Promise<IteratorResult<T>> {
    const item = this.values.shift();
    if (item) {
      return item;
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

const DEFAULT_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
  'SendMessage',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TodoWrite',
  'NotebookEdit',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion'
];

export class ClaudeRuntimeSession implements RuntimeSession {
  private sessionId?: string;
  private pendingAgents = new Map<string, PendingAgentToolUse>();
  private agents = new Map<string, AgentSummary>();
  private agentTaskIdsByToolUseId = new Map<string, string>();
  private failedAgentToolUseResults = new Map<string, string>();
  private teammateTaskIdsByAgentId = new Map<string, string>();
  private teammateNamesByAgentId = new Map<string, string>();
  private teammateTaskIdsByName = new Map<string, string>();
  private initTools: string[] = [];
  private tasks = new Map<string, TaskSummary>();
  private busyState = false;
  private abortQuery: (() => void) | undefined;
  private permissionPolicy?: PermissionPolicy;
  private activeInput?: AsyncInputQueue<SDKUserMessage>;
  private activeQuery?: Query;

  readonly ref;

  constructor(
    private readonly binding: RuntimeTurnInput['binding'],
    private readonly options: ClaudeRuntimeSessionOptions = {}
  ) {
    this.ref = {
      chatId: binding.chatId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId
    };
    this.sessionId = binding.sessionId;
  }

  get busy(): boolean {
    return this.busyState;
  }

  async getStatus(): Promise<RuntimeSessionStatus> {
    const state = this.sessionId
      ? this.busyState
        ? 'running'
        : 'idle'
      : 'not-started';

    if (!this.activeQuery) {
      return {
        state,
        sessionId: this.sessionId,
        supportsContextUsage: true
      };
    }

    try {
      const usage = await this.activeQuery.getContextUsage();
      return {
        state,
        sessionId: this.sessionId,
        supportsContextUsage: true,
        contextUsage: {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          apiUsage: usage.apiUsage
            ? {
                inputTokens: usage.apiUsage.input_tokens,
                outputTokens: usage.apiUsage.output_tokens,
                cacheCreationInputTokens:
                  usage.apiUsage.cache_creation_input_tokens,
                cacheReadInputTokens: usage.apiUsage.cache_read_input_tokens
              }
            : undefined
        }
      };
    } catch (error) {
      logWarn('[runtime] failed to read context usage', {
        chatId: this.binding.chatId,
        workspaceId: this.binding.workspaceId,
        error: errorToLogObject(error)
      });
      return {
        state,
        sessionId: this.sessionId,
        supportsContextUsage: true
      };
    }
  }

  async injectUserMessage(
    text: string,
    priority: RuntimeUserMessagePriority = 'now'
  ): Promise<void> {
    if (!this.busyState || !this.activeInput) {
      throw new Error('No running turn is available for injected input.');
    }

    this.activeInput.enqueue(this.buildUserMessage(text, priority));
  }

  resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution
  ): void {
    this.permissionPolicy?.resolve(interactionId, resolution);
  }

  abort(): void {
    this.abortQuery?.();
    this.abortQuery = undefined;
  }

  async *runTurn(input: RuntimeTurnInput): AsyncIterable<BridgeEvent> {
    if (this.busyState) {
      throw new Error(`Chat ${input.chatId} already has a running turn.`);
    }

    this.busyState = true;
    this.pendingAgents = new Map();
    this.agents = new Map();
    this.agentTaskIdsByToolUseId = new Map();
    this.failedAgentToolUseResults = new Map();
    this.teammateTaskIdsByAgentId = new Map();
    this.teammateNamesByAgentId = new Map();
    this.teammateTaskIdsByName = new Map();
    this.tasks = new Map();

    const queue = new AsyncEventQueue();
    let backgroundError: unknown;

    void this.executeTurn(input, queue).catch((error) => {
      backgroundError = error;
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      this.busyState = false;
      this.abortQuery = undefined;
      this.activeQuery = undefined;
      this.activeInput?.close();
      this.activeInput = undefined;
    }

    if (backgroundError) {
      throw backgroundError;
    }
  }

  private async executeTurn(
    input: RuntimeTurnInput,
    queue: AsyncEventQueue
  ): Promise<void> {
    const drainController = new SubagentDrainController();
    let drainTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let accumulatedText = '';
    const requestedTools = this.getRequestedTools();
    logDebug('[runtime] turn start', {
      chatId: input.chatId,
      turnId: input.turnId,
      resume: this.sessionId ?? null,
      input
    });
    this.permissionPolicy = new PermissionPolicy(
      input.binding.mode,
      (interaction) => {
        logDebug('[runtime] interaction requested', {
          chatId: input.chatId,
          turnId: input.turnId,
          kind: interaction.kind,
          interactionId: interaction.id,
          interaction
        });
        queue.push({
          type: 'interaction.requested',
          chatId: input.chatId,
          turnId: input.turnId,
          interaction
        });
      },
      input.binding.workspacePath,
      (from, to) => {
        logDebug('[runtime] session mode changed', {
          chatId: input.chatId,
          turnId: input.turnId,
          from,
          to
        });
        queue.push({
          type: 'session.mode.changed',
          chatId: input.chatId,
          turnId: input.turnId,
          from,
          to
        });
      }
    );

    try {
      const systemPrompt = await buildSystemPrompt({
        binding: input.binding,
        model: this.options.model ?? input.binding.model,
        language: this.options.language,
        mcpServers: this.options.mcpServers,
        availableTools: requestedTools
      });
      logDebug('[runtime] system prompt built', {
        chatId: input.chatId,
        turnId: input.turnId,
        sections: systemPrompt.sections,
        prompt: systemPrompt.prompt
      });

      const queryOptions = {
        cwd: input.binding.workspacePath,
        resume: this.sessionId,
        pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
        model: this.options.model ?? input.binding.model,
        systemPrompt: systemPrompt.prompt,
        settingSources: ['user', 'project', 'local'] satisfies SettingSource[],
        permissionMode: input.binding.mode,
        tools: requestedTools,
        env: this.buildRuntimeEnv(),
        extraArgs: this.buildExtraArgs()
      };
      logDebug('[runtime] llm query input', {
        chatId: input.chatId,
        turnId: input.turnId,
        queryInput: {
          prompt: input.prompt,
          options: queryOptions
        }
      });

      const inputStream = new AsyncInputQueue<SDKUserMessage>();
      const q = query({
        prompt: inputStream,
        options: {
          ...queryOptions,
          canUseTool: async (
            toolName: string,
            toolInput: Record<string, unknown>
          ): Promise<
            | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
            | { behavior: 'deny'; message: string }
          > => {
            const rewrittenToolInput = this.rewriteTeamToolInput(
              toolName,
              toolInput
            );
            logDebug('[runtime] canUseTool request', {
              chatId: input.chatId,
              turnId: input.turnId,
              toolName,
              toolInput: rewrittenToolInput,
              originalToolInput:
                rewrittenToolInput === toolInput ? undefined : toolInput
            });
            const decision = await this.permissionPolicy!.evaluate(
              toolName,
              rewrittenToolInput
            );
            if (decision.behavior === 'deny') {
              logDebug('[runtime] canUseTool deny', {
                chatId: input.chatId,
                turnId: input.turnId,
                toolName,
                toolInput: rewrittenToolInput,
                decision
              });
              return {
                behavior: 'deny',
                message: decision.message ?? 'Permission denied.'
              };
            }

            logDebug('[runtime] canUseTool allow', {
              chatId: input.chatId,
              turnId: input.turnId,
              toolName,
              toolInput: rewrittenToolInput,
              decision
            });
            return {
              behavior: 'allow',
              updatedInput: decision.updatedInput ?? rewrittenToolInput
            };
          }
        }
      });

      this.activeInput = inputStream;
      this.activeQuery = q;
      this.abortQuery = () => q.close();
      (q as { isSingleUserTurn?: boolean }).isSingleUserTurn = false;
      inputStream.enqueue(this.buildUserMessage(input.prompt, 'now'));

      const scheduleDrainTimeout = () => {
        if (drainTimeoutHandle) {
          clearTimeout(drainTimeoutHandle);
        }
        if (drainController.size === 0) {
          return;
        }

        drainTimeoutHandle = setTimeout(() => {
          logWarn('[runtime] drain timeout reached without further progress', {
            chatId: input.chatId,
            turnId: input.turnId,
            runningAgents: drainController.getRunningTaskIds()
          });
          q.close();
        }, drainController.timeout);
      };

      for await (const message of q as AsyncIterable<SDKMessage>) {
        logDebug('[runtime] llm output message', {
          chatId: input.chatId,
          turnId: input.turnId,
          type: (message as { type?: string }).type ?? 'unknown',
          subtype: (message as { subtype?: string }).subtype ?? null,
          message
        });

        if ((message as { type?: string }).type !== 'keep_alive') {
          drainController.markActivity();
          if (drainController.hasResult && drainController.size > 0) {
            scheduleDrainTimeout();
          }
        }
        queue.push({
          type: 'runtime.raw',
          chatId: input.chatId,
          turnId: input.turnId,
          payload: message
        });

        const nextSessionId = this.extractSessionId(message);
        if (nextSessionId) {
          this.sessionId = nextSessionId;
          this.ref.sessionId = nextSessionId;
        }

        if (this.isSystemMessage(message, 'init')) {
          this.trackInitTools(input, message, requestedTools);
        }

        if (this.isAssistantMessage(message)) {
          for (const block of this.getContentBlocks(message)) {
            if (block.type === 'text') {
              accumulatedText += String(block.text ?? '');
              queue.push({
                type: 'turn.text.delta',
                chatId: input.chatId,
                turnId: input.turnId,
                textDelta: String(block.text ?? ''),
                accumulatedText
              });
            }

            if (block.type === 'tool_use') {
              const tool = this.toToolStartedEvent(input, block);
              queue.push(tool);
              this.trackToolUse(input, block, queue);
            }
          }
        }

        if (this.isToolResultErrorMessage(message)) {
          this.trackToolResultError(input, message, drainController, queue);
        }

        if (this.isTeammateSpawnResultMessage(message)) {
          this.trackTeammateSpawnResult(input, message);
        }

        if (this.isToolSummary(message)) {
          queue.push({
            type: 'turn.tool.summary',
            chatId: input.chatId,
            turnId: input.turnId,
            summary: String((message as { summary?: string }).summary ?? '')
          });
        }

        if (this.isSystemMessage(message, 'task_started')) {
          this.trackTaskStarted(input, message, drainController, queue);
          logDebug('[runtime] task started', {
            chatId: input.chatId,
            turnId: input.turnId,
            runningAgents: drainController.getRunningTaskIds(),
            message
          });
          if (drainController.hasResult && drainController.size > 0) {
            scheduleDrainTimeout();
          }
        }

        if (this.isSystemMessage(message, 'task_notification')) {
          this.trackTaskCompleted(input, message, drainController, queue);
          logDebug('[runtime] task completed', {
            chatId: input.chatId,
            turnId: input.turnId,
            runningAgents: drainController.getRunningTaskIds(),
            message
          });
          if (drainController.hasResult && drainController.size > 0) {
            scheduleDrainTimeout();
          } else if (drainTimeoutHandle) {
            clearTimeout(drainTimeoutHandle);
            drainTimeoutHandle = undefined;
          }
        }

        if (this.isResultMessage(message)) {
          logDebug('[runtime] result received', {
            chatId: input.chatId,
            turnId: input.turnId,
            runningAgents: drainController.size,
            message
          });
          const decision = drainController.markResult();
          if (decision.shouldClose) {
            q.close();
          } else {
            scheduleDrainTimeout();
          }
        }

        const state = this.isSystemMessage(message, 'session_state_changed')
          ? (message as { state?: unknown }).state
          : undefined;
        const decision = drainController.evaluateSystemState(state);
        if (decision.shouldClose) {
          q.close();
        }
      }

      queue.push({
        type: 'turn.completed',
        chatId: input.chatId,
        turnId: input.turnId,
        status: 'completed',
        finalText: accumulatedText,
        sessionId: this.sessionId,
        finishedAt: new Date().toISOString()
      });
      logDebug('[runtime] turn completed', {
        chatId: input.chatId,
        turnId: input.turnId,
        sessionId: this.sessionId ?? null,
        finalText: accumulatedText
      });
    } catch (error) {
      logError('[runtime] turn error', {
        chatId: input.chatId,
        turnId: input.turnId,
        error: errorToLogObject(error),
        finalText: accumulatedText
      });
      queue.push({
        type: 'turn.completed',
        chatId: input.chatId,
        turnId: input.turnId,
        status: 'error',
        finalText: accumulatedText || String(error),
        sessionId: this.sessionId,
        finishedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      if (drainTimeoutHandle) {
        clearTimeout(drainTimeoutHandle);
      }
      this.activeInput?.close();
      queue.close();
    }
  }

  private buildUserMessage(
    text: string,
    priority: RuntimeUserMessagePriority
  ): SDKUserMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text
          }
        ]
      },
      parent_tool_use_id: null,
      priority,
      timestamp: new Date().toISOString(),
      session_id: this.sessionId
    };
  }

  private toToolStartedEvent(
    input: RuntimeTurnInput,
    block: Record<string, unknown>
  ): BridgeEvent {
    return {
      type: 'turn.tool.started',
      chatId: input.chatId,
      turnId: input.turnId,
      tool: {
        id: String(block.id ?? block.name ?? 'tool'),
        name: String(block.name ?? 'tool'),
        status: 'started',
        input: this.asRecord(block.input)
      }
    };
  }

  private trackToolUse(
    input: RuntimeTurnInput,
    block: Record<string, unknown>,
    queue: AsyncEventQueue
  ): void {
    const toolName = String(block.name ?? 'unknown');
    const toolInput = this.asRecord(block.input) ?? {};
    const toolUseId = String(block.id ?? toolName);

    if (toolName === 'Agent') {
      const description =
        typeof toolInput.description === 'string'
          ? toolInput.description
          : undefined;
      this.pendingAgents.set(toolUseId, {
        toolUseId,
        name: inferAgentDisplayName(toolInput),
        agentType: String(toolInput.subagent_type ?? 'general'),
        description
      });
      return;
    }

    if (toolName === 'TaskCreate') {
      const taskId = String(toolInput.id ?? `task-${this.tasks.size + 1}`);
      this.tasks.set(taskId, {
        id: taskId,
        subject: String(toolInput.subject ?? 'Task'),
        owner:
          typeof toolInput.owner === 'string' ? toolInput.owner : undefined,
        status: 'pending'
      });
      queue.push({
        type: 'turn.tasks.updated',
        chatId: input.chatId,
        turnId: input.turnId,
        tasks: [...this.tasks.values()]
      });
      return;
    }

    if (toolName === 'TaskUpdate') {
      const taskId = String(toolInput.id ?? '');
      const current = this.tasks.get(taskId);
      if (!current) {
        return;
      }

      this.tasks.set(taskId, {
        ...current,
        subject:
          typeof toolInput.subject === 'string'
            ? toolInput.subject
            : current.subject,
        owner:
          typeof toolInput.owner === 'string' ? toolInput.owner : current.owner,
        status: this.toTaskStatus(toolInput.status, current.status)
      });
      queue.push({
        type: 'turn.tasks.updated',
        chatId: input.chatId,
        turnId: input.turnId,
        tasks: [...this.tasks.values()]
      });
      return;
    }

    if (toolName === 'TodoWrite') {
      if (!Object.prototype.hasOwnProperty.call(toolInput, 'todos')) {
        return;
      }

      const tasks = normalizeTodoWriteTasks(toolInput.todos);
      this.tasks = new Map(tasks.map((task) => [task.id, task]));
      queue.push({
        type: 'turn.tasks.updated',
        chatId: input.chatId,
        turnId: input.turnId,
        tasks
      });
    }
  }

  private trackTaskStarted(
    input: RuntimeTurnInput,
    message: SDKMessage,
    drainController: SubagentDrainController,
    queue: AsyncEventQueue
  ): void {
    const taskId = String((message as { task_id?: string }).task_id ?? '');
    drainController.markTaskStarted(taskId);
    const toolUseId = extractAgentToolUseId(message);
    if (toolUseId) {
      this.agentTaskIdsByToolUseId.set(toolUseId, taskId);
    }
    const pending = this.pendingAgents.get(toolUseId);
    if (pending) {
      this.pendingAgents.delete(toolUseId);
    }
    const failedSummary = toolUseId
      ? this.failedAgentToolUseResults.get(toolUseId)
      : undefined;
    this.agents.set(taskId, {
      taskId,
      name: pending?.name ?? taskId,
      agentType: pending?.agentType ?? 'general',
      description: pending?.description,
      summary: failedSummary,
      status: failedSummary ? 'failed' : 'running'
    });
    if (failedSummary) {
      drainController.markTaskFinished(taskId);
    }
    queue.push({
      type: 'turn.agent.updated',
      chatId: input.chatId,
      turnId: input.turnId,
      agents: [...this.agents.values()]
    });
  }

  private trackToolResultError(
    input: RuntimeTurnInput,
    message: SDKMessage,
    drainController: SubagentDrainController,
    queue: AsyncEventQueue
  ): void {
    for (const block of this.getContentBlocks(message)) {
      if (block.type !== 'tool_result' || block.is_error !== true) {
        continue;
      }

      const toolUseId =
        typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (!toolUseId) {
        continue;
      }

      if (
        !this.pendingAgents.has(toolUseId) &&
        !this.agentTaskIdsByToolUseId.has(toolUseId)
      ) {
        continue;
      }

      const summary = extractToolResultErrorSummary(message, block);
      this.failedAgentToolUseResults.set(toolUseId, summary);

      const taskId = this.agentTaskIdsByToolUseId.get(toolUseId);
      if (!taskId) {
        continue;
      }

      const existing = this.agents.get(taskId);
      if (!existing) {
        continue;
      }

      drainController.markTaskFinished(taskId);
      this.agents.set(taskId, {
        ...existing,
        summary,
        status: 'failed'
      });
      queue.push({
        type: 'turn.agent.updated',
        chatId: input.chatId,
        turnId: input.turnId,
        agents: [...this.agents.values()]
      });
    }
  }

  private trackTeammateSpawnResult(
    input: RuntimeTurnInput,
    message: SDKMessage
  ): void {
    const block = this.getContentBlocks(message).find(
      (candidate) => candidate.type === 'tool_result'
    );
    const toolUseId =
      typeof block?.tool_use_id === 'string' ? block.tool_use_id : '';
    if (!toolUseId) {
      return;
    }

    const taskId = this.agentTaskIdsByToolUseId.get(toolUseId);
    if (!taskId) {
      return;
    }

    const result = this.asRecord(
      (message as { tool_use_result?: unknown }).tool_use_result
    );
    const agentId = typeof result?.agent_id === 'string' ? result.agent_id : '';
    if (!agentId) {
      return;
    }

    const name = typeof result?.name === 'string' ? result.name : '';
    this.teammateTaskIdsByAgentId.set(agentId, taskId);
    if (name) {
      this.teammateNamesByAgentId.set(agentId, name);
      this.teammateTaskIdsByName.set(name, taskId);
    }

    logDebug('[runtime] teammate spawn mapped to task', {
      chatId: input.chatId,
      turnId: input.turnId,
      toolUseId,
      taskId,
      agentId,
      name: name || null
    });
  }

  private trackTaskCompleted(
    input: RuntimeTurnInput,
    message: SDKMessage,
    drainController: SubagentDrainController,
    queue: AsyncEventQueue
  ): void {
    const taskId = String((message as { task_id?: string }).task_id ?? '');
    drainController.markTaskFinished(taskId);
    const existing = this.agents.get(taskId);
    if (!existing) {
      return;
    }

    this.agents.set(taskId, {
      ...existing,
      summary:
        typeof (message as { summary?: string }).summary === 'string'
          ? (message as { summary?: string }).summary
          : existing.summary,
      status: 'completed'
    });
    queue.push({
      type: 'turn.agent.updated',
      chatId: input.chatId,
      turnId: input.turnId,
      agents: [...this.agents.values()]
    });
  }

  private getRequestedTools(): string[] {
    const requested = new Set(this.options.defaultTools ?? DEFAULT_TOOLS);
    if (this.options.enableAgentTeams) {
      requested.add('TeamCreate');
      requested.add('TeamDelete');
      requested.add('SendMessage');
    }
    return [...requested];
  }

  private buildRuntimeEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      ...this.options.env
    };
  }

  private buildExtraArgs(): Record<string, string | null> | undefined {
    if (!this.options.extraArgs) {
      return undefined;
    }

    return {
      ...this.options.extraArgs
    };
  }

  private rewriteTeamToolInput(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Record<string, unknown> {
    if (toolName === 'TaskOutput') {
      const candidate =
        typeof toolInput.task_id === 'string'
          ? toolInput.task_id
          : typeof toolInput.taskId === 'string'
            ? toolInput.taskId
            : '';
      if (!candidate) {
        return toolInput;
      }

      const rewrittenTaskId =
        this.teammateTaskIdsByAgentId.get(candidate) ??
        this.teammateTaskIdsByName.get(candidate);
      if (!rewrittenTaskId || rewrittenTaskId === candidate) {
        return toolInput;
      }

      return 'task_id' in toolInput
        ? {
            ...toolInput,
            task_id: rewrittenTaskId
          }
        : {
            ...toolInput,
            taskId: rewrittenTaskId
          };
    }

    if (toolName === 'SendMessage') {
      const candidate = typeof toolInput.to === 'string' ? toolInput.to : '';
      if (!candidate) {
        return toolInput;
      }

      const rewrittenRecipient = this.teammateNamesByAgentId.get(candidate);
      if (!rewrittenRecipient || rewrittenRecipient === candidate) {
        return toolInput;
      }

      return {
        ...toolInput,
        to: rewrittenRecipient
      };
    }

    return toolInput;
  }

  private trackInitTools(
    input: RuntimeTurnInput,
    message: SDKMessage,
    requestedTools: string[]
  ): void {
    const actualTools = Array.isArray((message as { tools?: unknown[] }).tools)
      ? ((message as { tools?: string[] }).tools ?? [])
      : [];
    this.initTools = actualTools;

    const missingRequested = requestedTools.filter(
      (toolName) => !actualTools.includes(toolName)
    );
    if (missingRequested.length === 0) {
      return;
    }

    logWarn('[runtime] requested tools missing from init capabilities', {
      chatId: input.chatId,
      turnId: input.turnId,
      requestedTools,
      actualTools,
      missingRequested
    });
  }

  private extractSessionId(message: SDKMessage): string | undefined {
    const candidate = (message as { session_id?: unknown }).session_id;
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : undefined;
  }

  private isAssistantMessage(message: SDKMessage): boolean {
    return (message as { type?: string }).type === 'assistant';
  }

  private isToolSummary(message: SDKMessage): boolean {
    return (message as { type?: string }).type === 'tool_use_summary';
  }

  private isToolResultErrorMessage(message: SDKMessage): boolean {
    if ((message as { type?: string }).type !== 'user') {
      return false;
    }

    return this.getContentBlocks(message).some(
      (block) => block.type === 'tool_result' && block.is_error === true
    );
  }

  private isTeammateSpawnResultMessage(message: SDKMessage): boolean {
    if ((message as { type?: string }).type !== 'user') {
      return false;
    }

    const result = this.asRecord(
      (message as { tool_use_result?: unknown }).tool_use_result
    );
    return result?.status === 'teammate_spawned';
  }

  private isResultMessage(message: SDKMessage): boolean {
    return (message as { type?: string }).type === 'result';
  }

  private isSystemMessage(message: SDKMessage, subtype: string): boolean {
    const candidate = message as { type?: string; subtype?: string };
    return candidate.type === 'system' && candidate.subtype === subtype;
  }

  private getContentBlocks(
    message: SDKMessage
  ): Array<Record<string, unknown>> {
    const content =
      (message as { message?: { content?: unknown[] }; content?: unknown[] })
        .message?.content ??
      (message as { content?: unknown[] }).content ??
      [];
    return Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
      : [];
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private toTaskStatus(
    value: unknown,
    fallback: TaskSummary['status']
  ): TaskSummary['status'] {
    if (
      value === 'pending' ||
      value === 'in_progress' ||
      value === 'completed'
    ) {
      return value;
    }
    return fallback;
  }
}

function extractAgentToolUseId(message: SDKMessage): string {
  const candidate =
    typeof (message as { tool_use_id?: unknown }).tool_use_id === 'string'
      ? (message as { tool_use_id?: string }).tool_use_id
      : undefined;
  if (candidate) {
    return candidate;
  }

  return String(
    (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? ''
  );
}

function inferAgentDisplayName(toolInput: Record<string, unknown>): string {
  const explicitName =
    typeof toolInput.name === 'string' ? toolInput.name.trim() : '';
  if (explicitName) {
    return explicitName;
  }

  const description =
    typeof toolInput.description === 'string'
      ? toolInput.description.trim()
      : '';
  if (description) {
    return summarizeAgentDescription(description);
  }

  const prompt =
    typeof toolInput.prompt === 'string' ? toolInput.prompt.trim() : '';
  if (prompt) {
    return summarizeAgentDescription(prompt);
  }

  return 'agent';
}

function extractToolResultErrorSummary(
  message: SDKMessage,
  block: Record<string, unknown>
): string {
  if (typeof block.content === 'string' && block.content.trim().length > 0) {
    return block.content.trim();
  }

  const fallback = (message as { tool_use_result?: unknown }).tool_use_result;
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return fallback.trim();
  }

  return 'Agent tool failed.';
}

function summarizeAgentDescription(input: string): string {
  const firstLine = input.split('\n')[0]?.trim() ?? input;
  const candidate = firstLine.replace(/\s+/g, ' ').trim();
  if (!candidate) {
    return 'agent';
  }

  if (candidate.length <= 48) {
    return candidate;
  }

  return `${candidate.slice(0, 45).trimEnd()}...`;
}

function normalizeTodoWriteTasks(value: unknown): TaskSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    const todo =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : undefined;
    if (!todo) {
      return [];
    }

    const status = normalizeTodoStatus(todo.status);
    const subject = resolveTodoSubject(todo, status);
    if (!subject) {
      return [];
    }

    const explicitId =
      typeof todo.id === 'string' && todo.id.trim().length > 0
        ? todo.id.trim()
        : undefined;
    const baseId =
      explicitId ??
      (typeof todo.content === 'string' && todo.content.trim().length > 0
        ? todo.content.trim()
        : subject);

    return [
      {
        id: `${baseId}#${index + 1}`,
        subject,
        status
      } satisfies TaskSummary
    ];
  });
}

function resolveTodoSubject(
  todo: Record<string, unknown>,
  status: TaskSummary['status']
): string {
  const content = typeof todo.content === 'string' ? todo.content.trim() : '';
  const activeForm =
    typeof todo.activeForm === 'string' ? todo.activeForm.trim() : '';

  if (status === 'in_progress' && activeForm) {
    return activeForm;
  }

  return content || activeForm;
}

function normalizeTodoStatus(value: unknown): TaskSummary['status'] {
  if (value === 'completed' || value === 'done') {
    return 'completed';
  }

  if (value === 'in_progress' || value === 'active' || value === 'running') {
    return 'in_progress';
  }

  return 'pending';
}
