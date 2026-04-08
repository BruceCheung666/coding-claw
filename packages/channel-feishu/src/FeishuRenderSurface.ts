import type { Client } from '@larksuiteoapi/node-sdk';
import type {
  AgentSummary,
  BridgeEvent,
  InboundChatMessage,
  PendingInteraction,
  RenderModel,
  RenderSection,
  RenderSurface,
  TaskSummary
} from '@coding-claw/core';
import { buildInteractionCard } from './render/interactionCards.js';
import { callFeishuApi } from './feishuLogging.js';
import { CardStreamer } from './render/CardStreamer.js';

interface FeishuMessageClient {
  im: {
    message: {
      reply(
        request: Record<string, unknown>
      ): Promise<{ data?: { message_id?: string } }>;
      create(
        request: Record<string, unknown>
      ): Promise<{ data?: { message_id?: string } }>;
    };
  };
}

function asFeishuMessageClient(client: Client): FeishuMessageClient {
  return client as unknown as FeishuMessageClient;
}

export class FeishuRenderSurface implements RenderSurface {
  private streamer?: CardStreamer;
  private latestModel?: RenderModel;
  private shouldRepostContextCard = false;
  private skipRepostOnNextRender = false;

  constructor(
    private readonly client: Client,
    private readonly chatId: string,
    private readonly replyToMessageId?: string,
    private readonly onInteractionSent?: (
      interaction: PendingInteraction,
      messageId: string
    ) => void
  ) {}

  async startTurn(message: InboundChatMessage, turnId: string): Promise<void> {
    this.streamer = this.createStreamer(message.chatId, message.messageId);
    this.shouldRepostContextCard = false;
    this.skipRepostOnNextRender = false;

    this.latestModel = {
      turnId,
      title: 'Claude',
      prompt: message.text,
      body: '',
      loading: true,
      agents: [],
      tasks: [],
      sections: [
        {
          id: 'user',
          kind: 'user-prompt',
          prompt: message.text
        }
      ],
      nextSectionOrdinal: 1
    };
  }

  async apply(event: BridgeEvent): Promise<void> {
    if (event.type !== 'interaction.requested') {
      return;
    }

    const messageClient = asFeishuMessageClient(this.client);
    const response = this.streamer?.currentMessageId
      ? await callFeishuApi(
          'im.message.reply',
          {
            path: { message_id: this.streamer.currentMessageId },
            data: {
              msg_type: 'interactive',
              content: JSON.stringify(buildInteractionCard(event.interaction))
            }
          },
          async () =>
            await messageClient.im.message.reply({
              path: { message_id: this.streamer!.currentMessageId },
              data: {
                msg_type: 'interactive',
                content: JSON.stringify(buildInteractionCard(event.interaction))
              }
            })
        )
      : await callFeishuApi(
          'im.message.create',
          {
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: this.chatId,
              msg_type: 'interactive',
              content: JSON.stringify(buildInteractionCard(event.interaction))
            }
          },
          async () =>
            await messageClient.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: this.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(buildInteractionCard(event.interaction))
              }
            })
        );
    const messageId = response?.data?.message_id;
    if (typeof messageId === 'string' && this.onInteractionSent) {
      this.onInteractionSent(event.interaction, messageId);
    }

    this.shouldRepostContextCard = true;
    this.skipRepostOnNextRender = true;
  }

  async render(model: RenderModel): Promise<void> {
    this.latestModel = model;
    if (!this.streamer) {
      return;
    }

    if (this.skipRepostOnNextRender) {
      this.skipRepostOnNextRender = false;
    } else if (this.shouldRepostContextCard) {
      const previousStreamer = this.streamer;
      await previousStreamer.complete(this.composeSupersededMarkdown(), {
        showHeader: false
      });
      this.streamer = this.createStreamer(this.chatId, this.replyToMessageId);
      this.shouldRepostContextCard = false;
    }

    await this.streamer.update(this.composeMarkdown(model), model.loading);
  }

  async complete(_turnId: string): Promise<void> {
    if (!this.streamer || !this.latestModel) {
      return;
    }
    await this.streamer.complete(
      this.composeMarkdown({ ...this.latestModel, loading: false })
    );
  }

  async error(_turnId: string, message: string): Promise<void> {
    if (!this.streamer) {
      return;
    }
    await this.streamer.complete(`**Error**\n\n${message}`);
  }

  private composeMarkdown(model: RenderModel): string {
    const sections =
      model.sections.length > 0 ? model.sections : buildFallbackSections(model);

    const rendered = sections
      .map((section) => renderSection(section))
      .filter((section) => section.length > 0)
      .join('\n\n');

    return rendered || '任务已开始，正在整理上下文…';
  }

  private composeSupersededMarkdown(): string {
    return ['**任务上下文已迁移**', '请查看下方最新的任务进度卡片。'].join(
      '\n\n'
    );
  }

  private createStreamer(
    chatId: string,
    replyToMessageId?: string
  ): CardStreamer {
    return new CardStreamer({
      client: this.client,
      chatId,
      replyToMessageId
    });
  }
}

function buildFallbackSections(model: RenderModel): RenderSection[] {
  const sections: RenderSection[] = [
    {
      id: 'user',
      kind: 'user-prompt',
      prompt: model.prompt
    }
  ];

  if (model.body) {
    sections.push({
      id: 'text-fallback',
      kind: 'assistant-text',
      text: model.body
    });
  }

  if (model.toolSummary) {
    sections.push({
      id: 'tool-summary-fallback',
      kind: 'tool-summary',
      summary: model.toolSummary
    });
  }

  if (model.tasks.length > 0) {
    sections.push({
      id: 'tasks',
      kind: 'tasks',
      tasks: model.tasks
    });
  }

  if (model.agents.length > 0) {
    sections.push({
      id: 'agents',
      kind: 'agents',
      agents: model.agents
    });
  }

  return sections;
}

function renderSection(section: RenderSection): string {
  switch (section.kind) {
    case 'user-prompt':
      return '';
    case 'assistant-text':
      return renderBullet(section.text);
    case 'tool-group':
      return renderBullet(section.summary);
    case 'tool-summary':
      return renderBullet(section.summary);
    case 'tasks':
      return renderTaskList(section.tasks);
    case 'agents':
      return renderAgentTree(section.agents);
    case 'agent-note':
      return `@${section.agentName}❯ ${section.summary}`;
  }
}

function renderBullet(content: string): string {
  const trimmed = content.trim();
  return trimmed ? `● ${trimmed}` : '';
}

function renderTaskList(tasks: TaskSummary[]): string {
  return tasks
    .map((task) => {
      const icon =
        task.status === 'completed'
          ? '✅'
          : task.status === 'in_progress'
            ? '🔵'
            : '◻️';
      const owner = task.owner ? ` (${task.owner})` : '';
      return `${icon} ${task.subject}${owner}`;
    })
    .join('\n');
}

function renderAgentTree(agents: AgentSummary[]): string {
  const lines: string[] = [renderAgentHeadline(agents)];

  agents.forEach((agent, index) => {
    const isLast = index === agents.length - 1;
    const branch = isLast ? '┗━' : '┣━';
    const indent = isLast
      ? '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'
      : '┃&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';
    const icon =
      agent.status === 'completed'
        ? '✅'
        : agent.status === 'failed'
          ? '❌'
          : agent.status === 'stopped'
            ? '⏹️'
            : '⏳';

    lines.push(
      `&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${branch}&nbsp;&nbsp;&nbsp;${icon}&nbsp;&nbsp;&nbsp;@${agent.name}&nbsp;&nbsp;&nbsp;(${agent.agentType})`
    );
    if (agent.summary) {
      lines.push(
        `&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${indent}⎿&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${agent.summary}`
      );
    }
  });

  return lines.join('\n');
}

function renderAgentHeadline(agents: AgentSummary[]): string {
  const total = agents.length;
  const counts = {
    running: agents.filter((agent) => agent.status === 'running').length,
    completed: agents.filter((agent) => agent.status === 'completed').length,
    failed: agents.filter((agent) => agent.status === 'failed').length,
    stopped: agents.filter((agent) => agent.status === 'stopped').length
  };

  if (counts.running === total) {
    return `● ${total} agent${total === 1 ? '' : 's'} launched`;
  }

  const parts = [
    counts.running > 0 ? `${counts.running} running` : '',
    counts.completed > 0 ? `${counts.completed} completed` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.stopped > 0 ? `${counts.stopped} stopped` : ''
  ].filter(Boolean);

  return `● ${total} agent${total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
