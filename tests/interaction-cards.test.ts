import { describe, expect, it } from 'vitest';
import type { PendingInteraction } from '../packages/core/src/types.js';
import { buildInteractionCard } from '../packages/channel-feishu/src/render/interactionCards.js';

describe('interaction cards', () => {
  it('renders action-oriented permission cards with reason, risk and scope', () => {
    const card = buildInteractionCard({
      kind: 'permission',
      id: 'permission-1',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      toolName: 'Bash',
      toolInput: {
        command: 'git status'
      },
      actionLabel: '执行命令',
      reason: {
        kind: 'tool-default',
        message: '当前命令尚未在本会话中授权，继续前需要确认。'
      },
      riskLevel: 'medium',
      targets: [
        {
          type: 'command',
          value: 'git status'
        }
      ],
      scopeOptions: [
        {
          key: 'rule:Bash(git status:*)',
          kind: 'session-rule',
          label: '当前会话内允许 git status:*',
          description: '记住当前命令模式，后续相同范围的命令不再重复询问。'
        }
      ],
      suggestions: [
        {
          type: 'addRules',
          rules: ['Bash(git status:*)'],
          behavior: 'allow',
          destination: 'session'
        }
      ]
    } satisfies PendingInteraction);

    const payload = JSON.stringify(card);
    expect(payload).toContain('准备执行命令');
    expect(payload).toContain('触发原因');
    expect(payload).toContain('风险等级');
    expect(payload).toContain('可选范围');
    expect(payload).toContain('仅本次允许');
    expect(payload).toContain('当前会话内允许 git status:*');
    expect(payload).toContain('scope_key');
  });

  it('uses distinct button names for different session scopes', () => {
    const card = buildInteractionCard({
      kind: 'permission',
      id: 'permission-2',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      toolName: 'Write',
      toolInput: {
        file_path: '/tmp/demo.txt'
      },
      actionLabel: '写入文件',
      reason: {
        kind: 'tool-default',
        message: '当前尚未授权修改文件，继续前需要确认。'
      },
      riskLevel: 'medium',
      targets: [
        {
          type: 'path',
          value: '/tmp/demo.txt'
        }
      ],
      scopeOptions: [
        {
          key: 'mode:acceptEdits',
          kind: 'mode',
          label: '切换到 acceptEdits',
          description: '更新当前会话的权限模式，自动放行同类安全操作。'
        },
        {
          key: 'rule:Write',
          kind: 'tool',
          label: '当前会话内允许 Write',
          description: '后续相同工具调用将直接通过。'
        }
      ],
      suggestions: [
        {
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session'
        },
        {
          type: 'addRules',
          rules: ['Write'],
          behavior: 'allow',
          destination: 'session'
        }
      ]
    } satisfies PendingInteraction) as {
      body: {
        elements: Array<Record<string, unknown>>;
      };
    };

    const buttonNames = card.body.elements
      .filter((element) => element.tag === 'button')
      .map((element) => String(element.name ?? ''));
    expect(
      buttonNames.some((name) =>
        name.startsWith('accept-session_permission-2_')
      )
    ).toBe(true);
    expect(new Set(buttonNames).size).toBe(buttonNames.length);
    expect(buttonNames.every((name) => name.length <= 100)).toBe(true);
  });

  it('keeps long directory scope button names within feishu limits', () => {
    const externalFilePath =
      '/workspace/external/s3-sync/src/main/java/com/example/s3sync/SyncConfig.java';
    const externalDirectory =
      '/workspace/external/s3-sync/src/main/java/com/example/s3sync';
    const card = buildInteractionCard({
      kind: 'permission',
      id: 'permission-3',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      toolName: 'Write',
      toolInput: {
        file_path: externalFilePath
      },
      actionLabel: '写入文件',
      reason: {
        kind: 'outside-workspace',
        message: '目标路径位于当前工作区之外，需要显式批准。'
      },
      riskLevel: 'medium',
      targets: [
        {
          type: 'path',
          value: externalFilePath
        }
      ],
      scopeOptions: [
        {
          key: `dir:${externalDirectory}`,
          kind: 'directory',
          label: '当前会话内允许访问 s3sync/',
          description: '把该目录加入允许范围，后续访问同目录不再重复询问。'
        },
        {
          key: 'rule:Write',
          kind: 'tool',
          label: '当前会话内允许 Write',
          description: '后续相同工具调用将直接通过。'
        }
      ],
      suggestions: [
        {
          type: 'addDirectories',
          directories: [externalDirectory],
          destination: 'session'
        },
        {
          type: 'addRules',
          rules: ['Write'],
          behavior: 'allow',
          destination: 'session'
        }
      ]
    } satisfies PendingInteraction) as {
      body: {
        elements: Array<Record<string, unknown>>;
      };
    };

    const buttonNames = card.body.elements
      .filter((element) => element.tag === 'button')
      .map((element) => String(element.name ?? ''));
    expect(buttonNames.every((name) => name.length <= 100)).toBe(true);
  });

  it('renders multi-select questions with a multi_select_static control', () => {
    const card = buildInteractionCard({
      kind: 'question',
      id: 'question-1',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      questions: [
        {
          id: 'stack',
          header: '技术栈',
          question: '可多选',
          multiSelect: true,
          options: [
            {
              label: 'React',
              description: '前端'
            },
            {
              label: 'Node.js',
              description: '后端'
            }
          ]
        }
      ]
    } satisfies PendingInteraction) as {
      body: {
        elements: Array<Record<string, unknown>>;
      };
    };

    const form = card.body.elements[0] as {
      tag: string;
      elements: Array<Record<string, unknown>>;
    };
    const selector = form.elements.find(
      (element) => element.tag === 'multi_select_static'
    );

    expect(selector).toBeDefined();
    expect(selector?.name).toBe('choice_stack');
    expect(JSON.stringify(card)).toContain('可多选，也可选择其他');
  });
});
