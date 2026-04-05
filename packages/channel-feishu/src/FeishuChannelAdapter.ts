import * as lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import {
  COMMAND_REGISTRY,
  errorToLogObject,
  logDebug,
  logError,
  logWarn,
  parseInboundText
} from '@coding-claw/core';
import type {
  AgentModelControlOption,
  AgentModeControlOption,
  BridgeOrchestrator,
  ControlResponse,
  InteractionResolution,
  InboundChatMessage,
  PendingInteraction,
  PendingQuestionRequest,
  PermissionMode,
  ResetWorkspaceControlOption
} from '@coding-claw/core';
import { FeishuRenderSurface } from './FeishuRenderSurface.js';
import { PersistentInboundMessageStore } from './PersistentInboundMessageStore.js';
import { callFeishuApi } from './feishuLogging.js';

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  inboundStorePath: string;
}

type ConfirmableControlCommandId = 'shell.exec';

interface SensitiveControlCommand {
  commandId: ConfirmableControlCommandId;
  argsText: string;
  title: string;
  description: string;
}

interface PendingControlConfirmation {
  interactionId: string;
  chatId: string;
  originalMessageId: string;
  commandId: ConfirmableControlCommandId;
  argsText: string;
  commandText: string;
  title: string;
  description: string;
  cwd?: string;
}

interface PendingRuntimeRoutingDecision {
  interactionId: string;
  message: InboundChatMessage;
}

export class FeishuChannelAdapter {
  private readonly client: lark.Client;
  private wsClient?: lark.WSClient;
  private readonly interactionMessages = new Map<
    string,
    { chatId: string; messageId: string; interaction: PendingInteraction }
  >();
  private readonly pendingControlConfirmations = new Map<
    string,
    PendingControlConfirmation
  >();
  private readonly pendingRuntimeRoutingDecisions = new Map<
    string,
    PendingRuntimeRoutingDecision
  >();
  private readonly lastInboundByChat = new Map<
    string,
    { messageId: string; text: string; receivedAt: number }
  >();
  private static readonly SAME_PROMPT_WINDOW_MS = 30 * 60 * 1000;
  private readonly inboundMessageStore: PersistentInboundMessageStore;

  constructor(
    private readonly config: FeishuChannelConfig,
    private readonly orchestrator: BridgeOrchestrator
  ) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret
    });
    this.inboundMessageStore = new PersistentInboundMessageStore(
      config.inboundStorePath
    );
  }

  async start(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => this.onMessage(data),
      'im.message.message_read_v1': async (data: unknown) =>
        this.onMessageRead(data),
      'card.action.trigger': async (data: unknown) => this.onCardAction(data)
    } as never);

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info
    });

    const raw = this.wsClient as any;
    const originalHandler = raw.handleEventData.bind(raw);
    raw.handleEventData = (data: any) => {
      logDebug('[feishu] ws raw frame', data);
      const messageType = data.headers?.find?.(
        (header: any) => header.key === 'type'
      )?.value;
      if (messageType === 'card') {
        data.headers = data.headers.map((header: any) =>
          header.key === 'type' ? { ...header, value: 'event' } : header
        );
      }
      return originalHandler(data);
    };

    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  private async onMessage(payload: unknown): Promise<void> {
    logDebug('[feishu] raw inbound event', payload);
    const message = this.toInboundMessage(payload);
    if (!message) {
      logDebug('[feishu] inbound event ignored after parsing', payload);
      return;
    }

    const now = Date.now();
    logDebug('[feishu] inbound message', {
      chatId: message.chatId,
      messageId: message.messageId,
      textPreview: message.text.slice(0, 120),
      message
    });

    const reserveResult = await this.inboundMessageStore.reserve({
      messageId: message.messageId,
      chatId: message.chatId,
      text: message.text
    });
    logDebug('[feishu] inbound reserve result', {
      messageId: message.messageId,
      result: reserveResult
    });
    if (reserveResult.action !== 'accepted') {
      logWarn('[feishu] duplicate inbound message dropped', {
        chatId: message.chatId,
        messageId: message.messageId,
        reason: reserveResult.action
      });
      return;
    }

    const previousInbound = this.lastInboundByChat.get(message.chatId);
    if (
      previousInbound &&
      previousInbound.messageId !== message.messageId &&
      previousInbound.text === message.text &&
      now - previousInbound.receivedAt <=
        FeishuChannelAdapter.SAME_PROMPT_WINDOW_MS
    ) {
      logWarn('[feishu] same prompt received again with a new message id', {
        chatId: message.chatId,
        previousMessageId: previousInbound.messageId,
        messageId: message.messageId,
        ageMs: now - previousInbound.receivedAt
      });
    }
    this.lastInboundByChat.set(message.chatId, {
      messageId: message.messageId,
      text: message.text,
      receivedAt: now
    });

    logDebug('[feishu] inbound accepted and returning for ack', {
      chatId: message.chatId,
      messageId: message.messageId
    });
    void this.processAcceptedMessage(message);
  }

  private async onMessageRead(payload: unknown): Promise<void> {
    const event = payload as {
      reader?: {
        reader_id?: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
        read_time?: string;
      };
      message_id_list?: string[];
    };

    logDebug('[feishu] read receipt received', {
      reader: event.reader?.reader_id,
      readTime: event.reader?.read_time,
      messageIds: event.message_id_list ?? [],
      payload
    });
  }

  private async processAcceptedMessage(
    message: InboundChatMessage
  ): Promise<void> {
    try {
      logDebug('[feishu] background processing start', message);
      const sensitiveControlCommand = parseSensitiveControlCommand(
        message.text
      );
      if (sensitiveControlCommand) {
        await this.sendSensitiveControlConfirmation(
          message,
          sensitiveControlCommand
        );
        await this.inboundMessageStore.markCompleted(message.messageId);
        logDebug('[feishu] sensitive control command confirmation sent', {
          messageId: message.messageId,
          commandId: sensitiveControlCommand.commandId
        });
        return;
      }

      const dispatch = await this.orchestrator.dispatchInbound(message);
      logDebug('[feishu] dispatch result', {
        messageId: message.messageId,
        dispatch
      });
      if (dispatch.kind === 'control') {
        await this.replyControl(message, dispatch.response);
        await this.inboundMessageStore.markCompleted(message.messageId);
        logDebug('[feishu] control command completed', {
          messageId: message.messageId
        });
        return;
      }

      const routedMessage = dispatch.message;
      const intercepted =
        await this.tryHandleStartConfirmationReply(routedMessage);
      if (intercepted) {
        await this.inboundMessageStore.markCompleted(message.messageId);
        logDebug('[feishu] start confirmation intercepted', {
          messageId: message.messageId
        });
        return;
      }

      const execution = this.orchestrator.getChatExecutionSnapshot?.(
        routedMessage.chatId
      );
      if (execution?.running && execution.willQueue) {
        await this.sendRuntimeRoutingDecisionCard(routedMessage);
        await this.inboundMessageStore.markCompleted(routedMessage.messageId);
        logDebug('[feishu] runtime message requires queue-or-inject choice', {
          messageId: routedMessage.messageId,
          chatId: routedMessage.chatId,
          execution
        });
        return;
      }

      await this.runRuntimeTurn(routedMessage);
      await this.inboundMessageStore.markCompleted(routedMessage.messageId);
      logDebug('[feishu] runtime turn completed in background', {
        messageId: routedMessage.messageId,
        chatId: routedMessage.chatId
      });
    } catch (error) {
      await this.inboundMessageStore.markFailed(
        message.messageId,
        error instanceof Error ? error.message : String(error)
      );
      logError('[feishu] inbound processing failed after ack', {
        chatId: message.chatId,
        messageId: message.messageId,
        error: errorToLogObject(error)
      });
    }
  }

  private async onCardAction(
    payload: unknown
  ): Promise<Record<string, unknown> | undefined> {
    logDebug('[feishu] raw card action event', payload);
    const event = payload as any;
    const action = event?.action?.value ?? {};
    if (action.action === 'apply-reset-workspace') {
      return this.handleResetWorkspaceCardAction(
        action,
        event?.action?.form_value ?? {}
      );
    }
    if (action.action === 'set-agent-mode') {
      return this.handleAgentModeCardAction(action);
    }
    if (action.action === 'set-agent-model') {
      return this.handleAgentModelCardAction(action);
    }
    if (
      action.action === 'queue-runtime-message' ||
      action.action === 'inject-runtime-message'
    ) {
      const interactionId = String(action.interaction_id ?? '');
      return this.handleRuntimeRoutingDecisionAction(
        interactionId,
        action.action
      );
    }
    const interactionId = String(action.interaction_id ?? '');
    if (!interactionId) {
      logWarn('[feishu] card action missing interaction id', {
        actionName: event?.action?.name,
        hasFormValue: Boolean(event?.action?.form_value)
      });
      return;
    }

    let resolution: InteractionResolution | undefined;
    switch (action.action) {
      case 'confirm-control-command':
      case 'cancel-control-command':
        return this.handleControlConfirmationAction(
          interactionId,
          action.action
        );
      case 'accept-once':
        resolution = { kind: 'permission', action: 'accept-once' };
        break;
      case 'accept-session':
        resolution = {
          kind: 'permission',
          action: 'accept-session',
          scopeKey:
            typeof action.scope_key === 'string' ? action.scope_key : undefined
        };
        break;
      case 'reject':
        resolution = { kind: 'permission', action: 'reject' };
        break;
      case 'approve-plan':
        resolution = { kind: 'plan-approval', approved: true };
        break;
      case 'reject-plan':
        resolution = { kind: 'plan-approval', approved: false };
        break;
      case 'start-confirm':
        resolution = { kind: 'question', answers: { q_0: '确认开始' } };
        break;
      default: {
        const formValue = event?.action?.form_value ?? {};
        const selectedAnswers = new Map<string, string[]>();
        const otherAnswers = new Map<string, string>();

        for (const [key, rawValue] of Object.entries(formValue)) {
          if (key.startsWith('choice_')) {
            const values = normalizeChoiceValues(rawValue);
            if (values.length > 0) {
              selectedAnswers.set(key.slice('choice_'.length), values);
            }
            continue;
          }

          if (key.startsWith('other_')) {
            const value = normalizeFormValue(rawValue);
            if (!value) {
              continue;
            }
            otherAnswers.set(key.slice('other_'.length), value);
          }
        }

        const answerIds = new Set<string>([
          ...selectedAnswers.keys(),
          ...otherAnswers.keys()
        ]);
        const answers = Object.fromEntries(
          [...answerIds].map((id) => {
            const other = otherAnswers.get(id)?.trim();
            const selected = (selectedAnswers.get(id) ?? [])
              .map((value) => value.trim())
              .filter((value) => value && value !== '__other__');

            if (selected.length === 0) {
              return [id, other || ''];
            }

            if (!other && selected.length === 1) {
              return [id, selected[0]];
            }

            return [id, other ? [...selected, other] : selected];
          })
        );
        resolution = { kind: 'question', answers };
      }
    }

    const record = await this.orchestrator.resolveInteractionById(
      interactionId,
      resolution
    );
    if (!record) {
      logWarn('[feishu] interaction already handled', {
        interactionId,
        resolution
      });
      return {
        toast: {
          type: 'warning',
          content: 'Already handled'
        }
      };
    }

    this.interactionMessages.delete(interactionId);

    const response = {
      toast: {
        type: 'success',
        content: buildToast(resolution)
      },
      card: {
        type: 'raw',
        data: buildResolvedInteractionCard(record.interaction, resolution)
      }
    };
    logDebug('[feishu] card action response', {
      interactionId,
      resolution,
      response
    });
    return response;
  }

  private async tryHandleStartConfirmationReply(
    message: InboundChatMessage
  ): Promise<boolean> {
    const pending = await this.orchestrator.listPendingInteractions(
      message.chatId
    );
    const startConfirmation = pending.find(isStartConfirmationInteraction);
    if (!startConfirmation || startConfirmation.kind !== 'question') {
      return false;
    }

    const record = await this.orchestrator.resolveInteractionById(
      startConfirmation.id,
      {
        kind: 'question',
        answers: {
          [startConfirmation.questions[0]?.id ?? 'q_0']: message.text
        }
      }
    );
    if (!record) {
      return false;
    }

    logDebug(
      '[feishu] start confirmation converted to supplemental requirement',
      {
        message,
        interactionId: startConfirmation.id
      }
    );

    await this.updateInteractionMessage(
      startConfirmation.id,
      buildResolvedInteractionCard(
        record.interaction,
        {
          kind: 'question',
          answers: {
            [startConfirmation.questions[0]?.id ?? 'q_0']: message.text
          }
        },
        {
          title: '未开始',
          note: '已转为补充需求'
        }
      )
    );

    this.interactionMessages.delete(startConfirmation.id);
    return true;
  }

  private async updateInteractionMessage(
    interactionId: string,
    card: Record<string, unknown>
  ): Promise<void> {
    const entry = this.interactionMessages.get(interactionId);
    if (!entry) {
      logWarn('[feishu] interaction message missing for update', {
        interactionId
      });
      return;
    }

    const request = {
      path: { message_id: entry.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card)
      }
    };
    await callFeishuApi(
      'im.message.update',
      request,
      async () => await (this.client as any).im.message.update(request)
    );
  }

  private async runRuntimeTurn(message: InboundChatMessage): Promise<void> {
    const surface = new FeishuRenderSurface(
      this.client,
      message.chatId,
      message.messageId,
      (interaction, messageId) => {
        this.interactionMessages.set(interaction.id, {
          chatId: message.chatId,
          messageId,
          interaction
        });
      }
    );
    await this.orchestrator.handleInbound(message, surface);
  }

  private async sendRuntimeRoutingDecisionCard(
    message: InboundChatMessage
  ): Promise<void> {
    const interactionId = randomUUID();
    const record: PendingRuntimeRoutingDecision = {
      interactionId,
      message
    };
    this.pendingRuntimeRoutingDecisions.set(interactionId, record);

    const request = {
      path: { message_id: message.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(buildRuntimeRoutingDecisionCard(record))
      }
    };
    await callFeishuApi(
      'im.message.reply',
      request,
      async () => await (this.client as any).im.message.reply(request)
    );
  }

  private async replyText(messageId: string, text: string): Promise<void> {
    const request = {
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    };
    await callFeishuApi(
      'im.message.reply',
      request,
      async () => await (this.client as any).im.message.reply(request)
    );
  }

  private async replyControl(
    message: InboundChatMessage,
    response: ControlResponse
  ): Promise<void> {
    if (response.format === 'text') {
      await this.replyText(message.messageId, response.text);
      return;
    }

    if (response.format === 'reset-workspace-picker') {
      const request = {
        path: { message_id: message.messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(
            buildResetWorkspaceControlCard(message.chatId, response.options)
          )
        }
      };
      await callFeishuApi(
        'im.message.reply',
        request,
        async () => await (this.client as any).im.message.reply(request)
      );
      return;
    }

    if (response.format === 'agent-model-picker') {
      const request = {
        path: { message_id: message.messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(
            buildAgentModelControlCard(
              message.chatId,
              response.currentModel,
              response.options
            )
          )
        }
      };
      await callFeishuApi(
        'im.message.reply',
        request,
        async () => await (this.client as any).im.message.reply(request)
      );
      return;
    }

    const request = {
      path: { message_id: message.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(
          buildAgentModeControlCard(
            message.chatId,
            response.currentMode,
            response.options
          )
        )
      }
    };
    await callFeishuApi(
      'im.message.reply',
      request,
      async () => await (this.client as any).im.message.reply(request)
    );
  }

  private async sendSensitiveControlConfirmation(
    message: InboundChatMessage,
    command: SensitiveControlCommand
  ): Promise<void> {
    const interactionId = randomUUID();
    const snapshot = (await (this.orchestrator as any).getChatControlSnapshot?.(
      message.chatId
    )) as { cwd?: string } | undefined;
    const record: PendingControlConfirmation = {
      interactionId,
      chatId: message.chatId,
      originalMessageId: message.messageId,
      commandId: command.commandId,
      argsText: command.argsText,
      commandText: message.text,
      title: command.title,
      description: command.description,
      cwd: snapshot?.cwd
    };
    this.pendingControlConfirmations.set(interactionId, record);

    const request = {
      path: { message_id: message.messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(buildSensitiveControlConfirmationCard(record))
      }
    };
    await callFeishuApi(
      'im.message.reply',
      request,
      async () => await (this.client as any).im.message.reply(request)
    );
  }

  private async handleControlConfirmationAction(
    interactionId: string,
    action: 'confirm-control-command' | 'cancel-control-command'
  ): Promise<Record<string, unknown>> {
    const record = this.pendingControlConfirmations.get(interactionId);
    if (!record) {
      return {
        toast: {
          type: 'warning',
          content: 'Already handled'
        }
      };
    }

    this.pendingControlConfirmations.delete(interactionId);

    if (action === 'cancel-control-command') {
      return {
        toast: {
          type: 'success',
          content: '已取消'
        },
        card: {
          type: 'raw',
          data: buildSensitiveControlConfirmationResolvedCard(
            record,
            'cancelled'
          )
        }
      };
    }

    try {
      const response = await this.orchestrator.dispatchControlCommand(
        record.chatId,
        record.commandId,
        record.argsText
      );
      const detail =
        response.format === 'text'
          ? response.text
          : '控制命令已执行，但返回了非文本响应。';
      return {
        toast: {
          type: 'success',
          content: '已确认并执行'
        },
        card: {
          type: 'raw',
          data: buildSensitiveControlConfirmationResolvedCard(
            record,
            'confirmed',
            detail
          )
        }
      };
    } catch (error) {
      logError('[feishu] sensitive control command failed', {
        interactionId,
        record,
        error: errorToLogObject(error)
      });
      return {
        toast: {
          type: 'warning',
          content: '执行失败'
        },
        card: {
          type: 'raw',
          data: buildSensitiveControlConfirmationResolvedCard(
            record,
            'failed',
            error instanceof Error ? error.message : String(error)
          )
        }
      };
    }
  }

  private async handleRuntimeRoutingDecisionAction(
    interactionId: string,
    action: 'queue-runtime-message' | 'inject-runtime-message'
  ): Promise<Record<string, unknown>> {
    const record = this.pendingRuntimeRoutingDecisions.get(interactionId);
    if (!record) {
      return {
        toast: {
          type: 'warning',
          content: 'Already handled'
        }
      };
    }

    this.pendingRuntimeRoutingDecisions.delete(interactionId);

    if (action === 'queue-runtime-message') {
      void this.runRuntimeTurn(record.message).catch((error) => {
        logError('[feishu] queued runtime turn failed', {
          chatId: record.message.chatId,
          messageId: record.message.messageId,
          error: errorToLogObject(error)
        });
      });
      return {
        toast: {
          type: 'success',
          content: '已加入队列'
        },
        card: {
          type: 'raw',
          data: buildRuntimeRoutingDecisionResolvedCard(record, 'queued')
        }
      };
    }

    try {
      await this.orchestrator.injectIntoRunningTurn(
        record.message.chatId,
        record.message.text
      );
      return {
        toast: {
          type: 'success',
          content: '已注入当前会话'
        },
        card: {
          type: 'raw',
          data: buildRuntimeRoutingDecisionResolvedCard(record, 'injected')
        }
      };
    } catch (error) {
      logError('[feishu] runtime message injection failed', {
        chatId: record.message.chatId,
        messageId: record.message.messageId,
        error: errorToLogObject(error)
      });
      return {
        toast: {
          type: 'warning',
          content: '注入失败'
        },
        card: {
          type: 'raw',
          data: buildRuntimeRoutingDecisionResolvedCard(
            record,
            'failed',
            error instanceof Error ? error.message : String(error)
          )
        }
      };
    }
  }

  private async handleResetWorkspaceCardAction(
    action: Record<string, unknown>,
    formValue: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const chatId = typeof action.chat_id === 'string' ? action.chat_id : '';
    const workspaceSource =
      typeof action.workspace_source === 'string'
        ? action.workspace_source
        : '';
    if (!chatId || !workspaceSource) {
      return {
        toast: {
          type: 'warning',
          content: 'Missing reset payload'
        }
      };
    }

    const snapshot = await this.orchestrator.getChatControlSnapshot(chatId);
    const resetOptions = {
      defaultWorkspacePath: snapshot.defaultWorkspacePath,
      currentWorkspacePath: snapshot.workspacePath,
      currentCwd: snapshot.cwd
    } satisfies ResetWorkspaceControlOption;
    const manualWorkspacePath = normalizeFormValue(
      formValue.manual_workspace_path
    );
    const workspacePath =
      workspaceSource === 'default'
        ? snapshot.defaultWorkspacePath
        : workspaceSource === 'cwd'
          ? snapshot.cwd
          : workspaceSource === 'workspace'
            ? snapshot.workspacePath
            : workspaceSource === 'manual'
              ? manualWorkspacePath
              : '';

    if (!workspacePath) {
      return {
        toast: {
          type: 'warning',
          content: '请输入工作区路径'
        },
        card: {
          type: 'raw',
          data: buildResetWorkspaceControlCard(
            chatId,
            resetOptions,
            '手动输入不能为空。',
            true
          )
        }
      };
    }

    if (!workspacePath.startsWith('/')) {
      return {
        toast: {
          type: 'warning',
          content: '请输入绝对路径'
        },
        card: {
          type: 'raw',
          data: buildResetWorkspaceControlCard(
            chatId,
            resetOptions,
            '手动输入必须是绝对路径。',
            true
          )
        }
      };
    }

    try {
      const response = await this.orchestrator.dispatchControlCommand(
        chatId,
        'reset',
        workspacePath
      );
      if (response.format !== 'text') {
        return {
          toast: {
            type: 'warning',
            content: 'reset 未完成'
          },
          card: {
            type: 'raw',
            data: buildResetWorkspaceControlCard(
              chatId,
              resetOptions,
              'reset 结果异常，请重试。',
              true
            )
          }
        };
      }

      return {
        toast: {
          type: 'success',
          content: '工作区已重置'
        },
        card: {
          type: 'raw',
          data: buildResetWorkspaceResultCard(
            workspaceSource,
            workspacePath,
            response.text
          )
        }
      };
    } catch (error) {
      logError('[feishu] reset workspace action failed', {
        chatId,
        workspaceSource,
        workspacePath,
        error: errorToLogObject(error)
      });
      return {
        toast: {
          type: 'warning',
          content: 'reset 失败'
        },
        card: {
          type: 'raw',
          data: buildResetWorkspaceControlCard(
            chatId,
            resetOptions,
            error instanceof Error ? error.message : String(error),
            true
          )
        }
      };
    }
  }

  private async handleAgentModeCardAction(
    action: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const chatId = typeof action.chat_id === 'string' ? action.chat_id : '';
    const mode = typeof action.mode === 'string' ? action.mode : '';
    if (!chatId || !mode) {
      return {
        toast: {
          type: 'warning',
          content: 'Missing mode payload'
        }
      };
    }

    try {
      const response = await this.orchestrator.dispatchControlCommand(
        chatId,
        'agent.mode',
        mode
      );
      return {
        toast: {
          type: 'success',
          content: '权限模式已切换'
        },
        card: {
          type: 'raw',
          data: buildAgentModeControlResultCard(
            mode as PermissionMode,
            response.format === 'text' ? response.text : undefined
          )
        }
      };
    } catch (error) {
      logError('[feishu] agent mode control action failed', {
        chatId,
        mode,
        error: errorToLogObject(error)
      });
      return {
        toast: {
          type: 'warning',
          content: '切换失败'
        },
        card: {
          type: 'raw',
          data: buildAgentModeControlResultCard(
            mode as PermissionMode,
            error instanceof Error ? error.message : String(error),
            true
          )
        }
      };
    }
  }

  private async handleAgentModelCardAction(
    action: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const chatId = typeof action.chat_id === 'string' ? action.chat_id : '';
    const model = typeof action.model === 'string' ? action.model : '';
    if (!chatId || !model) {
      return {
        toast: {
          type: 'warning',
          content: 'Missing model payload'
        }
      };
    }

    try {
      await this.orchestrator.dispatchControlCommand(
        chatId,
        'agent.model',
        model
      );
      return {
        toast: {
          type: 'success',
          content: '模型已切换'
        },
        card: {
          type: 'raw',
          data: buildAgentModelControlResultCard(model)
        }
      };
    } catch (error) {
      logError('[feishu] agent model control action failed', {
        chatId,
        model,
        error: errorToLogObject(error)
      });
      return {
        toast: {
          type: 'warning',
          content: '切换失败'
        },
        card: {
          type: 'raw',
          data: buildAgentModelControlResultCard(
            model,
            error instanceof Error ? error.message : String(error),
            true
          )
        }
      };
    }
  }

  private toInboundMessage(payload: unknown): InboundChatMessage | undefined {
    const event = payload as {
      message?: {
        chat_id?: string;
        message_id?: string;
        message_type?: string;
        content?: string;
      };
    };

    if (event.message?.message_type !== 'text') {
      return undefined;
    }

    const chatId = event.message?.chat_id;
    const messageId = event.message?.message_id;
    if (!chatId || !messageId) {
      return undefined;
    }

    try {
      const content = JSON.parse(event.message.content ?? '{}') as {
        text?: string;
      };
      const text = (content.text ?? '').replace(/@_user_\d+/g, '').trim();
      if (!text) {
        return undefined;
      }

      return {
        channel: 'feishu',
        chatId,
        messageId,
        text
      };
    } catch {
      return undefined;
    }
  }
}

function normalizeFormValue(value: unknown): string {
  return normalizeScalarFormValue(value);
}

function normalizeScalarFormValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.value === 'string') {
      return record.value.trim();
    }
    if (typeof record.text === 'string') {
      return record.text.trim();
    }
  }

  return '';
}

function normalizeChoiceValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeChoiceValues(item)).filter(Boolean);
  }

  const normalized = normalizeScalarFormValue(value);
  return normalized ? [decodeChoiceValue(normalized)] : [];
}

function decodeChoiceValue(value: string): string {
  return value.startsWith('choice:') ? value.slice('choice:'.length) : value;
}

function buildAgentModeControlCard(
  chatId: string,
  currentMode: PermissionMode,
  options: AgentModeControlOption[],
  note?: string,
  failed = false
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: failed ? 'Agent 权限模式切换失败' : 'Agent 权限模式'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模式: **${currentMode}**`
        },
        {
          tag: 'markdown',
          content: options
            .map((option) => `- **${option.label}**: ${option.description}`)
            .join('\n')
        },
        ...(note
          ? [
              {
                tag: 'markdown',
                content: note
              }
            ]
          : []),
        ...options.map((option) => ({
          tag: 'button',
          type: option.mode === currentMode ? 'primary' : 'default',
          text: {
            tag: 'plain_text',
            content: option.label
          },
          name: `set_agent_mode_${option.mode}`,
          value: {
            action: 'set-agent-mode',
            chat_id: chatId,
            mode: option.mode
          }
        }))
      ]
    }
  };
}

function buildResetWorkspaceControlCard(
  chatId: string,
  options: ResetWorkspaceControlOption,
  note?: string,
  failed = false
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: failed ? 'reset 工作区选择失败' : '重置并选择工作区'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '**将执行完整 reset**',
            '',
            '- 会终止当前 Agent 会话',
            '- 会销毁当前 Shell 会话',
            '- 会把新的工作区目录同时设为 workspace 和 cwd',
            '- 不会删除任何现有文件'
          ].join('\n')
        },
        {
          tag: 'markdown',
          content: [
            `默认位置: \`${options.defaultWorkspacePath}\``,
            `当前 cwd: \`${options.currentCwd}\``,
            `当前 workspace: \`${options.currentWorkspacePath}\``
          ].join('\n')
        },
        {
          tag: 'markdown',
          content: '请选择新的工作区目录:'
        },
        {
          tag: 'button',
          type: 'default',
          text: {
            tag: 'plain_text',
            content: '使用默认位置'
          },
          name: 'reset_workspace_default',
          value: {
            action: 'apply-reset-workspace',
            chat_id: chatId,
            workspace_source: 'default'
          }
        },
        {
          tag: 'button',
          type: 'primary',
          text: {
            tag: 'plain_text',
            content: '使用当前 cwd'
          },
          name: 'reset_workspace_cwd',
          value: {
            action: 'apply-reset-workspace',
            chat_id: chatId,
            workspace_source: 'cwd'
          }
        },
        {
          tag: 'button',
          type: 'default',
          text: {
            tag: 'plain_text',
            content: '使用当前 workspace'
          },
          name: 'reset_workspace_current',
          value: {
            action: 'apply-reset-workspace',
            chat_id: chatId,
            workspace_source: 'workspace'
          }
        },
        {
          tag: 'form',
          name: `reset_workspace_form_${chatId}`,
          elements: [
            {
              tag: 'markdown',
              content: '其他位置: 手动输入绝对路径'
            },
            {
              tag: 'input',
              name: 'manual_workspace_path',
              placeholder: {
                tag: 'plain_text',
                content: '/abs/path/to/workspace'
              }
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '使用手动输入路径' },
              type: 'default',
              name: `submit_reset_workspace_${chatId}`,
              action_type: 'form_submit',
              value: {
                action: 'apply-reset-workspace',
                chat_id: chatId,
                workspace_source: 'manual'
              }
            }
          ]
        },
        ...(note
          ? [
              {
                tag: 'markdown',
                content: note
              }
            ]
          : [])
      ]
    }
  };
}

function buildResetWorkspaceResultCard(
  workspaceSource: string,
  workspacePath: string,
  detail: string,
  failed = false
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: failed ? '❌ 工作区重置失败' : '✅ 工作区已重置'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `来源: **${formatResetWorkspaceSource(workspaceSource)}**`
        },
        {
          tag: 'markdown',
          content: `工作区: \`${workspacePath}\``
        },
        {
          tag: 'markdown',
          content: detail
        }
      ]
    }
  };
}

function formatResetWorkspaceSource(workspaceSource: string): string {
  switch (workspaceSource) {
    case 'default':
      return '默认位置';
    case 'cwd':
      return '当前 cwd';
    case 'workspace':
      return '当前 workspace';
    case 'manual':
      return '手动输入';
    default:
      return workspaceSource;
  }
}

function buildAgentModeControlResultCard(
  mode: PermissionMode,
  note?: string,
  failed = false
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: failed
          ? '❌ Agent 权限模式切换失败'
          : '✅ Agent 权限模式已切换'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模式: **${mode}**`
        },
        {
          tag: 'markdown',
          content: AGENT_MODE_CONTROL_OPTIONS.map(
            (option) => `- **${option.label}**: ${option.description}`
          ).join('\n')
        },
        ...(note
          ? [
              {
                tag: 'markdown',
                content: note
              }
            ]
          : [])
      ]
    }
  };
}

const AGENT_MODE_CONTROL_OPTIONS: AgentModeControlOption[] = [
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

function buildAgentModelControlCard(
  chatId: string,
  currentModel: string,
  options: AgentModelControlOption[],
  note?: string,
  failed = false
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: failed ? 'Agent 模型切换失败' : 'Agent 模型'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `当前模型: **${currentModel}**`
        },
        {
          tag: 'markdown',
          content: options
            .map((option) => `- **${option.label}**: ${option.description}`)
            .join('\n')
        },
        {
          tag: 'markdown',
          content: '切换模型会重置当前 Agent Session。'
        },
        ...(note
          ? [
              {
                tag: 'markdown',
                content: note
              }
            ]
          : []),
        ...options.map((option) => ({
          tag: 'button',
          type: option.model === currentModel ? 'primary' : 'default',
          text: {
            tag: 'plain_text',
            content: option.label
          },
          name: `set_agent_model_${option.model}`,
          value: {
            action: 'set-agent-model',
            chat_id: chatId,
            model: option.model
          }
        }))
      ]
    }
  };
}

function buildAgentModelControlResultCard(
  model: string,
  note?: string,
  failed = false
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = failed
    ? [
        ...(note
          ? [
              {
                tag: 'markdown',
                content: note
              }
            ]
          : [])
      ]
    : [
        {
          tag: 'markdown',
          content: `Agent 模型已切换为 **${model}**`
        },
        {
          tag: 'markdown',
          content: '会话已重置'
        }
      ];

  return {
    schema: '2.0',
    header: {
      template: failed ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: failed ? '❌ Agent 模型切换失败' : '✅ Agent 模型已切换'
      }
    },
    body: {
      elements
    }
  };
}

function buildToast(resolution: InteractionResolution): string {
  switch (resolution.kind) {
    case 'permission':
      return resolution.action === 'reject' ? 'Rejected' : 'Submitted';
    case 'plan-approval':
      return resolution.approved ? 'Plan approved' : 'Plan rejected';
    case 'question':
      return 'Answer received';
  }
}

function buildResolvedInteractionCard(
  interaction: PendingInteraction,
  resolution: InteractionResolution,
  options?: { title?: string; note?: string }
): Record<string, unknown> {
  switch (interaction.kind) {
    case 'permission': {
      const approved =
        resolution.kind === 'permission' && resolution.action !== 'reject';
      const title =
        interaction.actionLabel ?? `调用工具 ${interaction.toolName}`;
      const primaryTarget = interaction.targets?.[0]?.value;
      const resolutionText =
        resolution.kind === 'permission' &&
        resolution.action === 'accept-session'
          ? `已记住当前会话范围${formatScopeLabel(interaction, resolution.scopeKey)}`
          : approved
            ? '仅允许本次执行'
            : '本次请求已拒绝';
      return {
        schema: '2.0',
        header: {
          template: approved ? 'grey' : 'red',
          title: {
            tag: 'plain_text',
            content: approved ? '✅ 已批准' : '❌ 已拒绝'
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: `动作: ${title}`
            },
            {
              tag: 'markdown',
              content: `处理结果: ${resolutionText}`
            },
            ...(interaction.reason
              ? [
                  {
                    tag: 'markdown',
                    content: `原因: ${interaction.reason.message}`
                  }
                ]
              : []),
            ...(primaryTarget
              ? [
                  {
                    tag: 'markdown',
                    content: `目标: \`${primaryTarget}\``
                  }
                ]
              : []),
            {
              tag: 'markdown',
              content: `\`\`\`json\n${JSON.stringify(interaction.toolInput, null, 2)}\n\`\`\``
            }
          ]
        }
      };
    }
    case 'plan-approval': {
      const approved =
        resolution.kind === 'plan-approval' && resolution.approved;
      return {
        schema: '2.0',
        header: {
          template: approved ? 'grey' : 'red',
          title: {
            tag: 'plain_text',
            content: approved ? '✅ 计划已批准' : '❌ 计划已拒绝'
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: interaction.plan || '(empty plan)'
            }
          ]
        }
      };
    }
    case 'question': {
      const answers = resolution.kind === 'question' ? resolution.answers : {};
      const answerLines = interaction.questions.map((question) => {
        const answer = answers[question.id];
        const rendered = Array.isArray(answer)
          ? answer.join(', ')
          : answer || '(未回答)';
        return `**${question.question}**\n${rendered}`;
      });

      return {
        schema: '2.0',
        header: {
          template: 'blue',
          title: {
            tag: 'plain_text',
            content:
              options?.title ??
              (isStartConfirmationInteraction(interaction)
                ? '开始确认'
                : '已回答')
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: answerLines.join('\n\n')
            },
            ...(options?.note
              ? [
                  {
                    tag: 'markdown',
                    content: options.note
                  }
                ]
              : [])
          ]
        }
      };
    }
  }
}

function formatScopeLabel(
  interaction: Extract<PendingInteraction, { kind: 'permission' }>,
  scopeKey: string | undefined
): string {
  if (!scopeKey) {
    return '';
  }

  const option = interaction.scopeOptions?.find(
    (candidate) => candidate.key === scopeKey
  );
  return option ? `: ${option.label}` : '';
}

function isStartConfirmationInteraction(
  interaction: PendingInteraction
): interaction is PendingQuestionRequest {
  if (interaction.kind !== 'question' || interaction.questions.length !== 1) {
    return false;
  }

  const question = interaction.questions[0];
  return (
    /确认开始|开始执行|开始实现/.test(question.question) ||
    /确认开始|开始执行|开始实现/.test(question.header)
  );
}

function parseSensitiveControlCommand(
  text: string
): SensitiveControlCommand | undefined {
  const parsed = parseInboundText(text);
  if (parsed.kind !== 'command') {
    return undefined;
  }

  if (parsed.match.id === 'shell.exec') {
    const danger = detectDangerousShellCommand(parsed.match.argsText);
    if (!danger) {
      return undefined;
    }

    return {
      commandId: parsed.match.id,
      argsText: parsed.match.argsText,
      title: '确认执行危险 Shell 命令',
      description: danger
    };
  }

  return undefined;
}

function detectDangerousShellCommand(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (isDangerousRecursiveDelete(normalized)) {
    return '该命令包含强制递归删除，可能会批量移除当前目录下的大量文件。';
  }

  if (/\b(dd|mkfs(\.\w+)?|fdisk|parted|wipefs|shred)\b/.test(normalized)) {
    return '该命令包含磁盘或文件系统级破坏操作，可能导致数据不可恢复。';
  }

  if (
    /\b(shutdown|reboot|poweroff|halt)\b/.test(normalized) ||
    /\binit\s+[06]\b/.test(normalized)
  ) {
    return '该命令会影响当前机器运行状态，可能导致服务中断或会话终止。';
  }

  if (
    /\b(killall|pkill)\b/.test(normalized) ||
    /\bkill\s+-9\s+(-1|1)\b/.test(normalized)
  ) {
    return '该命令会强制终止进程，可能中断当前 bridge、agent 或其他系统服务。';
  }

  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(normalized)) {
    return '该命令是典型 fork bomb，会快速耗尽系统资源。';
  }

  return undefined;
}

function isDangerousRecursiveDelete(command: string): boolean {
  if (!/\brm\b/.test(command)) {
    return false;
  }

  return /\brm\b[\s\S]*?(--recursive|--force|-rf|-fr|-r\s+-f|-f\s+-r)/.test(
    command
  );
}

function buildSensitiveControlConfirmationCard(
  record: PendingControlConfirmation
): Record<string, unknown> {
  const command = COMMAND_REGISTRY.find((item) => item.id === record.commandId);

  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '⚠️ 待确认'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**敏感操作确认**\n\n${record.title}`
        },
        {
          tag: 'markdown',
          content: record.description
        },
        {
          tag: 'markdown',
          content: `命令: \`${record.commandText}\``
        },
        ...(record.cwd
          ? [
              {
                tag: 'markdown',
                content: `当前 cwd: \`${record.cwd}\``
              }
            ]
          : []),
        ...(command
          ? [
              {
                tag: 'markdown',
                content: `说明: ${command.description}`
              }
            ]
          : []),
        {
          tag: 'markdown',
          content: '确认后会立即执行，是否继续？'
        },
        controlActionButton(
          '确认执行',
          'confirm-control-command',
          record.interactionId,
          'danger'
        ),
        controlActionButton(
          '取消',
          'cancel-control-command',
          record.interactionId,
          'default'
        )
      ]
    }
  };
}

function buildSensitiveControlConfirmationResolvedCard(
  record: PendingControlConfirmation,
  status: 'confirmed' | 'cancelled' | 'failed',
  detail?: string
): Record<string, unknown> {
  const title =
    status === 'confirmed'
      ? '✅ 已确认执行'
      : status === 'cancelled'
        ? '❌ 已取消'
        : '❌ 执行失败';
  const headerTemplate = status === 'confirmed' ? 'green' : 'red';

  return {
    schema: '2.0',
    header: {
      template: headerTemplate,
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `命令: \`${record.commandText}\``
        },
        ...(detail
          ? [
              {
                tag: 'markdown',
                content: detail
              }
            ]
          : [])
      ]
    }
  };
}

function buildRuntimeRoutingDecisionCard(
  record: PendingRuntimeRoutingDecision
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '处理中消息'
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '**当前 Agent 仍在处理中。**'
        },
        {
          tag: 'markdown',
          content: `新消息: \`${record.message.text}\``
        },
        {
          tag: 'markdown',
          content: '请选择把这条消息加入队列，还是立刻注入到当前会话。'
        },
        runtimeRoutingActionButton(
          '加入队列',
          'queue-runtime-message',
          record.interactionId,
          'default'
        ),
        runtimeRoutingActionButton(
          '立刻注入当前会话',
          'inject-runtime-message',
          record.interactionId,
          'primary'
        )
      ]
    }
  };
}

function buildRuntimeRoutingDecisionResolvedCard(
  record: PendingRuntimeRoutingDecision,
  status: 'queued' | 'injected' | 'failed',
  detail?: string
): Record<string, unknown> {
  const title =
    status === 'queued'
      ? '✅ 已加入队列'
      : status === 'injected'
        ? '✅ 已注入当前会话'
        : '❌ 处理失败';
  const summary =
    status === 'queued'
      ? '这条消息会在当前 turn 完成后继续处理。'
      : status === 'injected'
        ? '这条消息已作为补充输入送入当前运行中的会话。'
        : undefined;

  return {
    schema: '2.0',
    header: {
      template: status === 'failed' ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `消息: \`${record.message.text}\``
        },
        ...(summary
          ? [
              {
                tag: 'markdown',
                content: summary
              }
            ]
          : []),
        ...(detail
          ? [
              {
                tag: 'markdown',
                content: detail
              }
            ]
          : [])
      ]
    }
  };
}

function controlActionButton(
  label: string,
  action: 'confirm-control-command' | 'cancel-control-command',
  interactionId: string,
  type: 'default' | 'primary' | 'danger'
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    name: `${action}_${interactionId}`,
    value: {
      action,
      interaction_id: interactionId
    }
  };
}

function runtimeRoutingActionButton(
  label: string,
  action: 'queue-runtime-message' | 'inject-runtime-message',
  interactionId: string,
  type: 'default' | 'primary' | 'danger'
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    name: `${action}_${interactionId}`,
    value: {
      action,
      interaction_id: interactionId
    }
  };
}
