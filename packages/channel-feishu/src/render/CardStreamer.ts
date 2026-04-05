import * as lark from '@larksuiteoapi/node-sdk';
import { callFeishuApi } from '../feishuLogging.js';

export interface CardStreamerDeps {
  client: lark.Client;
  chatId: string;
  replyToMessageId?: string;
}

export class CardStreamer {
  private cardId?: string;
  private messageId?: string;
  private sequence = 0;
  private lastCardPayload?: string;

  constructor(private readonly deps: CardStreamerDeps) {}

  get currentMessageId(): string | undefined {
    return this.messageId;
  }

  async update(
    markdown: string,
    loading: boolean,
    options?: CardVisualOptions
  ): Promise<void> {
    const cardPayload = JSON.stringify(buildCard(markdown, loading, options));

    if (!this.cardId) {
      await this.create(cardPayload);
      this.lastCardPayload = cardPayload;
      return;
    }

    if (this.lastCardPayload === cardPayload) {
      return;
    }

    this.sequence += 1;
    const request = {
      path: { card_id: this.cardId },
      data: {
        sequence: this.sequence,
        card: {
          type: 'card_json',
          data: cardPayload
        }
      }
    };
    await callFeishuApi(
      'cardkit.v1.card.update',
      request,
      async () =>
        await (this.deps.client as any).cardkit.v1.card.update(request)
    );
    this.lastCardPayload = cardPayload;
  }

  async complete(markdown: string, options?: CardVisualOptions): Promise<void> {
    await this.update(markdown, false, options);
  }

  private async create(cardPayload: string): Promise<void> {
    const createCardRequest = {
      data: {
        type: 'card_json',
        data: cardPayload
      }
    };
    const response = await callFeishuApi(
      'cardkit.v1.card.create',
      createCardRequest,
      async () =>
        await (this.deps.client as any).cardkit.v1.card.create(
          createCardRequest
        )
    );

    this.cardId = response?.data?.card_id;
    this.sequence = 1;
    const content = JSON.stringify({
      type: 'card',
      data: {
        card_id: this.cardId
      }
    });

    if (this.deps.replyToMessageId) {
      const replyRequest = {
        path: { message_id: this.deps.replyToMessageId },
        data: { msg_type: 'interactive', content }
      };
      const replyResponse = await callFeishuApi(
        'im.message.reply',
        replyRequest,
        async () =>
          await (this.deps.client as any).im.message.reply(replyRequest)
      );
      this.messageId = replyResponse?.data?.message_id;
      return;
    }

    const createMessageRequest = {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.deps.chatId,
        msg_type: 'interactive',
        content
      }
    };
    const createResponse = await callFeishuApi(
      'im.message.create',
      createMessageRequest,
      async () =>
        await (this.deps.client as any).im.message.create(createMessageRequest)
    );
    this.messageId = createResponse?.data?.message_id;
  }
}

interface CardVisualOptions {
  showHeader?: boolean;
}

const LOADING_ICON_KEY = 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';

function buildCard(
  markdown: string,
  loading: boolean,
  options?: CardVisualOptions
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: markdown || '...'
        },
        {
          tag: 'markdown',
          content: loading ? ' ' : '',
          ...(loading
            ? {
                icon: {
                  tag: 'custom_icon',
                  img_key: LOADING_ICON_KEY,
                  size: '16px 16px'
                }
              }
            : {})
        }
      ]
    }
  };

  if (options?.showHeader !== false) {
    card.header = {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: loading ? '任务进度 · 处理中' : '任务进度 · 已完成'
      }
    };
  }

  return card;
}
