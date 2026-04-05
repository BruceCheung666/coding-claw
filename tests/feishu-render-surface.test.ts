import { describe, expect, it, vi } from 'vitest';
import type { PendingInteraction } from '../packages/core/src/types.js';
import {
  createInitialRenderModel,
  reduceRenderModel
} from '../packages/core/src/render/reduceRenderModel.js';
import { FeishuRenderSurface } from '../packages/channel-feishu/src/FeishuRenderSurface.js';

describe('FeishuRenderSurface', () => {
  it('renders a single initial loading placeholder without duplicated processing copy', async () => {
    const client = createClientStub();
    const surface = new FeishuRenderSurface(
      client as any,
      'chat-1',
      'user-message-1'
    );
    const model = createInitialRenderModel('turn-1', '帮我改一下');

    await surface.startTurn(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'user-message-1',
        text: '帮我改一下'
      },
      'turn-1'
    );

    await surface.render(model);

    const latestCard = parseCardPayload(
      client.cardkit.v1.card.create.mock.calls[0]?.[0]
    );
    expect(latestCard).toContain('任务已开始，正在整理上下文…');
    expect(latestCard).toContain('"content":"任务进度 · 处理中"');
    expect(latestCard).toContain('"tag":"custom_icon"');
    expect(latestCard).toContain(
      '"img_key":"img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg"'
    );
    expect(latestCard).not.toContain('"content":"处理中…"');
  });

  it('skips IM card updates when the rendered payload is unchanged', async () => {
    const client = createClientStub();
    const surface = new FeishuRenderSurface(
      client as any,
      'chat-1',
      'user-message-1'
    );
    let model = createInitialRenderModel('turn-1', '帮我改一下');

    await surface.startTurn(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'user-message-1',
        text: '帮我改一下'
      },
      'turn-1'
    );

    model = reduceRenderModel(model, {
      type: 'turn.text.delta',
      chatId: 'chat-1',
      turnId: 'turn-1',
      textDelta: '当前任务进度',
      accumulatedText: '当前任务进度'
    });

    await surface.render(model);
    await surface.render(model);

    expect(client.cardkit.v1.card.create).toHaveBeenCalledTimes(1);
    expect(client.cardkit.v1.card.update).toHaveBeenCalledTimes(0);

    await surface.complete('turn-1');

    expect(client.cardkit.v1.card.update).toHaveBeenCalledTimes(1);
    const latestCard = parseCardPayload(
      client.cardkit.v1.card.update.mock.calls[0]?.[0]
    );
    expect(latestCard).toContain('"content":"任务进度 · 已完成"');
  });

  it('reposts the task context card after a later interaction card', async () => {
    const client = createClientStub();
    const surface = new FeishuRenderSurface(
      client as any,
      'chat-1',
      'user-message-1'
    );
    let model = createInitialRenderModel('turn-1', '帮我改一下');

    await surface.startTurn(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'user-message-1',
        text: '帮我改一下'
      },
      'turn-1'
    );

    model = reduceRenderModel(model, {
      type: 'turn.text.delta',
      chatId: 'chat-1',
      turnId: 'turn-1',
      textDelta: '当前任务进度',
      accumulatedText: '当前任务进度'
    });

    await surface.render(model);

    expect(client.cardkit.v1.card.create).toHaveBeenCalledTimes(1);
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);

    await surface.apply({
      type: 'interaction.requested',
      chatId: 'chat-1',
      turnId: 'turn-1',
      interaction: createPermissionInteraction()
    });

    expect(client.im.message.reply).toHaveBeenCalledTimes(2);
    expect(client.im.message.reply.mock.calls[1]?.[0]).toMatchObject({
      path: { message_id: 'message-1' }
    });

    await surface.render(model);

    expect(client.cardkit.v1.card.create).toHaveBeenCalledTimes(1);
    expect(client.cardkit.v1.card.update).toHaveBeenCalledTimes(0);

    model = reduceRenderModel(model, {
      type: 'turn.tool.started',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tool: {
        id: 'tool-1',
        name: 'Read',
        status: 'started',
        input: {
          file_path: '/tmp/a.ts'
        }
      }
    });

    model = reduceRenderModel(model, {
      type: 'turn.text.delta',
      chatId: 'chat-1',
      turnId: 'turn-1',
      textDelta: '\n\n已拿到授权，继续处理中',
      accumulatedText: '当前任务进度\n\n已拿到授权，继续处理中'
    });

    await surface.render(model);

    expect(client.cardkit.v1.card.create).toHaveBeenCalledTimes(2);
    expect(client.im.message.reply).toHaveBeenCalledTimes(3);
    expect(client.im.message.reply.mock.calls[2]?.[0]).toMatchObject({
      path: { message_id: 'user-message-1' }
    });
    expect(client.cardkit.v1.card.update).toHaveBeenCalledTimes(1);

    const supersededCard = parseCardPayload(
      client.cardkit.v1.card.update.mock.calls[0]?.[0]
    );
    expect(supersededCard).toContain('任务上下文已迁移');
    expect(supersededCard).toContain('请查看下方最新的任务进度卡片');
    expect(supersededCard).not.toContain('"header"');

    const latestCard = parseCardPayload(
      client.cardkit.v1.card.create.mock.calls[1]?.[0]
    );
    expect(latestCard).toContain('当前任务进度');
    expect(latestCard).toContain('已拿到授权，继续处理中');
    expect(latestCard).toContain('Read 1 file');
    expect(latestCard).not.toContain('**User**');
    expect(latestCard).not.toContain('帮我改一下');
    expect(latestCard).toContain('"template":"green"');
    expect(latestCard).toContain('"content":"任务进度 · 处理中"');
  });

  it('renders structured task and agent sections instead of the old fixed template', async () => {
    const client = createClientStub();
    const surface = new FeishuRenderSurface(
      client as any,
      'chat-1',
      'user-message-1'
    );
    let model = createInitialRenderModel('turn-1', '帮我改一下');

    await surface.startTurn(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'user-message-1',
        text: '帮我改一下'
      },
      'turn-1'
    );

    model = reduceRenderModel(model, {
      type: 'turn.tasks.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tasks: [
        {
          id: 'task-1',
          subject: '补齐 turn 卡片',
          owner: 'main',
          status: 'in_progress'
        }
      ]
    });

    model = reduceRenderModel(model, {
      type: 'turn.agent.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      agents: [
        {
          taskId: 'agent-1',
          name: 'research',
          agentType: 'explorer',
          status: 'completed',
          summary: '核对了旧版 turn 卡片语义'
        }
      ]
    });

    await surface.render(model);

    const latestCard = parseCardPayload(
      client.cardkit.v1.card.create.mock.calls[0]?.[0]
    );
    expect(latestCard).toContain('🔵 补齐 turn 卡片 (main)');
    expect(latestCard).toContain('● 1 agent: 1 completed');
    expect(latestCard).toContain('@research');
    expect(latestCard).not.toContain('**Tasks**');
    expect(latestCard).not.toContain('**Agents**');
    expect(latestCard).toContain('"content":"任务进度 · 处理中"');
  });

  it('renders failed agents without calling them launched', async () => {
    const client = createClientStub();
    const surface = new FeishuRenderSurface(
      client as any,
      'chat-1',
      'user-message-1'
    );
    let model = createInitialRenderModel('turn-1', '帮我改一下');

    await surface.startTurn(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'user-message-1',
        text: '帮我改一下'
      },
      'turn-1'
    );

    model = reduceRenderModel(model, {
      type: 'turn.agent.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      agents: [
        {
          taskId: 'agent-1',
          name: 'research',
          agentType: 'explorer',
          status: 'failed',
          summary: 'Team "team-claw" does not exist.'
        }
      ]
    });

    await surface.render(model);

    await surface.complete('turn-1');

    const latestCard = parseCardPayload(
      client.cardkit.v1.card.update.mock.calls[0]?.[0]
    );
    expect(latestCard).toContain('● 1 agent: 1 failed');
    expect(latestCard).toContain('❌');
    expect(latestCard).not.toContain('● 1 agent launched');
    expect(latestCard).toContain('"content":"任务进度 · 已完成"');
  });
});

function createClientStub() {
  let cardCount = 0;
  let messageCount = 0;

  return {
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async () => ({
            data: {
              card_id: `card-${++cardCount}`
            }
          })),
          update: vi.fn(async () => ({}))
        }
      }
    },
    im: {
      message: {
        reply: vi.fn(async () => ({
          data: {
            message_id: `message-${++messageCount}`
          }
        }))
      }
    }
  };
}

function createPermissionInteraction(): PendingInteraction {
  return {
    kind: 'permission',
    id: 'interaction-1',
    createdAt: new Date('2026-04-02T00:00:00Z').toISOString(),
    toolName: 'Bash',
    toolInput: {
      command: 'pnpm test'
    },
    suggestions: []
  };
}

function parseCardPayload(call: unknown): string {
  const data = (
    call as {
      data?: {
        card?: {
          data?: string;
        };
        data?: string;
      };
    }
  )?.data;

  const raw = data?.card?.data ?? data?.data ?? '{}';
  return JSON.stringify(JSON.parse(raw));
}
