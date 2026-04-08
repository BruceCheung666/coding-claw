import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuChannelAdapter } from '../packages/channel-feishu/src/FeishuChannelAdapter.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.map(async (dir) => {
      await import('node:fs/promises').then(({ rm }) =>
        rm(dir, { recursive: true, force: true })
      );
    })
  );
  createdDirs.length = 0;
});

describe('FeishuChannelAdapter', () => {
  it('returns from inbound handling before the runtime turn finishes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const started = createDeferred<void>();
    const finishTurn = createDeferred<void>();
    const orchestrator = {
      dispatchInbound: vi.fn(async (message) => ({
        kind: 'runtime' as const,
        message
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'ok'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {
        started.resolve();
        await finishTurn.promise;
      })
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_1',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_1', 'chat-1', 'hello')
    );
    await started.promise;

    expect(orchestrator.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(orchestrator.handleInbound).toHaveBeenCalledTimes(1);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();

    finishTurn.resolve();
    await flushMicrotasks();

    expect(markCompleted).toHaveBeenCalledWith('om_1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('renders /reset as a workspace picker and applies the cwd choice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'reset-workspace-picker' as const,
          options: {
            defaultWorkspacePath: '/workspace-default/chat-1',
            currentWorkspacePath: '/workspace',
            currentCwd: '/workspace/subdir'
          }
        }
      })),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: '/workspace/subdir',
        workspacePath: '/workspace',
        defaultWorkspacePath: '/workspace-default/chat-1'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: '工作区已重置\ncwd: /workspace/subdir\nworkspace: /workspace/subdir'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_sr',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_sr', 'chat-1', '/reset')
    );
    await flushMicrotasks();

    expect(orchestrator.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(orchestrator.dispatchControlCommand).not.toHaveBeenCalled();
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledWith('om_sr');
    expect(markFailed).not.toHaveBeenCalled();

    const resetContent = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    expect(
      (resetContent.header as { template?: string } | undefined)?.template
    ).toBe('blue');
    expect(JSON.stringify(resetContent)).toContain(
      '默认位置: `/workspace-default/chat-1`'
    );
    expect(JSON.stringify(resetContent)).toContain(
      '当前 cwd: `/workspace/subdir`'
    );
    expect(JSON.stringify(resetContent)).toContain(
      '当前 workspace: `/workspace`'
    );
    expect(JSON.stringify(resetContent)).toContain('使用当前 workspace');

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'apply-reset-workspace',
          chat_id: 'chat-1',
          workspace_source: 'cwd'
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'reset',
      '/workspace/subdir'
    );
    expect(response.toast.content).toBe('工作区已重置');
    expect(response.card.data.header.template).toBe('green');
    expect(JSON.stringify(response.card.data)).toContain(
      'cwd: /workspace/subdir'
    );
    expect(JSON.stringify(response.card.data)).toContain('/workspace/subdir');
  });

  it('accepts manual workspace input from the /reset card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'text' as const,
          text: 'unused'
        }
      })),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: '/workspace/subdir',
        workspacePath: '/workspace',
        defaultWorkspacePath: '/workspace-default/chat-1'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: '工作区已重置\ncwd: /tmp/manual\nworkspace: /tmp/manual'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };
    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'apply-reset-workspace',
          chat_id: 'chat-1',
          workspace_source: 'manual'
        },
        form_value: {
          manual_workspace_path: {
            value: '/tmp/manual'
          }
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'reset',
      '/tmp/manual'
    );
    expect(response.toast.content).toBe('工作区已重置');
    expect(JSON.stringify(response.card.data)).toContain('手动输入');
    expect(JSON.stringify(response.card.data)).toContain('/tmp/manual');
  });

  it('accepts Windows manual workspace input from the /reset card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'text' as const,
          text: 'unused'
        }
      })),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: 'D:\\Projects\\coding-claw',
        workspacePath: 'D:\\Projects\\coding-claw',
        defaultWorkspacePath: 'D:\\coding-claw-workspaces\\chat-1'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: '工作区已重置\ncwd: D:\\Projects\\CommonProject\nworkspace: D:\\Projects\\CommonProject'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };
    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'apply-reset-workspace',
          chat_id: 'chat-1',
          workspace_source: 'manual'
        },
        form_value: {
          manual_workspace_path: {
            value: 'D:\\Projects\\CommonProject'
          }
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'reset',
      'D:\\Projects\\CommonProject'
    );
    expect(response.toast.content).toBe('工作区已重置');
    expect(JSON.stringify(response.card.data)).toContain(
      'D:\\\\Projects\\\\CommonProject'
    );
  });

  it('rejects blank manual workspace input from the /reset card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'text' as const,
          text: 'unused'
        }
      })),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: 'D:\\Projects\\coding-claw',
        workspacePath: 'D:\\Projects\\coding-claw',
        defaultWorkspacePath: 'D:\\coding-claw-workspaces\\chat-1'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'should not be used'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };
    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'apply-reset-workspace',
          chat_id: 'chat-1',
          workspace_source: 'manual'
        },
        form_value: {
          manual_workspace_path: {
            value: '   '
          }
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).not.toHaveBeenCalled();
    expect(response.toast.content).toBe('请输入工作区路径');
  });

  it('uses the current workspace option from the /reset card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'text' as const,
          text: 'unused'
        }
      })),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: '/workspace/subdir',
        workspacePath: '/workspace',
        defaultWorkspacePath: '/workspace-default/chat-1'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: '工作区已重置\ncwd: /workspace\nworkspace: /workspace'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };
    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'apply-reset-workspace',
          chat_id: 'chat-1',
          workspace_source: 'workspace'
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'reset',
      '/workspace'
    );
    expect(response.toast.content).toBe('工作区已重置');
    expect(JSON.stringify(response.card.data)).toContain('当前 workspace');
    expect(JSON.stringify(response.card.data)).toContain('/workspace');
  });

  it('requires confirmation before executing dangerous shell commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => {
        throw new Error('should not dispatch dangerous shell command directly');
      }),
      getChatControlSnapshot: vi.fn(async () => ({
        cwd: '/workspace/danger-zone',
        workspacePath: '/workspace'
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: '$ rm -rf *\nexitCode: 0\ncwd: /workspace\n(no output)'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_sx',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_sx', 'chat-1', '/sx rm -rf *')
    );
    await flushMicrotasks();

    expect(orchestrator.dispatchInbound).not.toHaveBeenCalled();
    expect(orchestrator.dispatchControlCommand).not.toHaveBeenCalled();
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);

    const confirmationContent = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    expect(
      (confirmationContent.header as { template?: string } | undefined)
        ?.template
    ).toBe('orange');
    expect(JSON.stringify(confirmationContent)).toContain('危险 Shell 命令');
    expect(JSON.stringify(confirmationContent)).toContain('强制递归删除');
    expect(JSON.stringify(confirmationContent)).toContain(
      '当前 cwd: `/workspace/danger-zone`'
    );

    const interactionId = extractInteractionId(confirmationContent);
    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'confirm-control-command',
          interaction_id: interactionId
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'shell.exec',
      'rm -rf *'
    );
    expect(response.card.data.header.template).toBe('green');
    expect(JSON.stringify(response.card.data)).toContain('$ rm -rf *');
  });

  it('executes harmless shell commands without confirmation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'text' as const,
          text: '$ pwd\nexitCode: 0\ncwd: /workspace\n/workspace'
        }
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_pwd',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_pwd', 'chat-1', '/sx pwd')
    );
    await flushMicrotasks();

    expect(orchestrator.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(orchestrator.dispatchControlCommand).not.toHaveBeenCalled();
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    expect(client.im.message.reply.mock.calls[0]![0]).toMatchObject({
      path: { message_id: 'om_pwd' },
      data: { msg_type: 'text' }
    });
  });

  it('asks whether to queue or inject when a runtime message arrives during an active turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async (message) => ({
        kind: 'runtime' as const,
        message
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      getChatExecutionSnapshot: vi.fn(() => ({
        running: true,
        willQueue: true,
        sessionId: 'session-1'
      })),
      injectIntoRunningTurn: vi.fn(async () => {}),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_queue_prompt',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_queue_prompt', 'chat-1', '补充一个 README')
    );
    await flushMicrotasks();

    expect(orchestrator.handleInbound).not.toHaveBeenCalled();
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    const card = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain('queue-runtime-message');
    expect(JSON.stringify(card)).toContain('inject-runtime-message');
    expect(JSON.stringify(card)).toContain('补充一个 README');
    expect(markCompleted).toHaveBeenCalledWith('om_queue_prompt');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('queues a runtime message after the user chooses to join the queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async (message) => ({
        kind: 'runtime' as const,
        message
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      getChatExecutionSnapshot: vi.fn(() => ({
        running: true,
        willQueue: true,
        sessionId: 'session-1'
      })),
      injectIntoRunningTurn: vi.fn(async () => {}),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_queue_select',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {})
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_queue_select', 'chat-1', '继续补测试')
    );
    await flushMicrotasks();

    const card = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    const interactionId = extractActionInteractionId(
      card,
      'queue-runtime-message'
    );
    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'queue-runtime-message',
          interaction_id: interactionId
        }
      }
    });
    await flushMicrotasks();

    expect(orchestrator.handleInbound).toHaveBeenCalledWith(
      {
        channel: 'feishu',
        chatId: 'chat-1',
        messageId: 'om_queue_select',
        text: '继续补测试'
      },
      expect.anything()
    );
    expect(orchestrator.injectIntoRunningTurn).not.toHaveBeenCalled();
    expect(response.toast.content).toBe('已加入队列');
    expect(response.card.data.header.title.content).toBe('✅ 已加入队列');
  });

  it('injects a runtime message into the running session when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async (message) => ({
        kind: 'runtime' as const,
        message
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      getChatExecutionSnapshot: vi.fn(() => ({
        running: true,
        willQueue: true,
        sessionId: 'session-1'
      })),
      injectIntoRunningTurn: vi.fn(async () => {}),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_inject_select',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {})
    };

    await (adapter as any).onMessage(
      createTextMessagePayload(
        'om_inject_select',
        'chat-1',
        '先看一下这个边界条件'
      )
    );
    await flushMicrotasks();

    const card = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    const interactionId = extractActionInteractionId(
      card,
      'inject-runtime-message'
    );
    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'inject-runtime-message',
          interaction_id: interactionId
        }
      }
    });

    expect(orchestrator.injectIntoRunningTurn).toHaveBeenCalledWith(
      'chat-1',
      '先看一下这个边界条件'
    );
    expect(orchestrator.handleInbound).not.toHaveBeenCalled();
    expect(response.toast.content).toBe('已注入当前会话');
    expect(response.card.data.header.title.content).toBe('✅ 已注入当前会话');
  });

  it('renders /agent mode as an interactive control card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'agent-mode-picker' as const,
          currentMode: 'plan' as const,
          options: [
            {
              mode: 'default' as const,
              label: 'default',
              description: '默认模式'
            },
            {
              mode: 'acceptEdits' as const,
              label: 'acceptEdits',
              description: '编辑更宽松'
            },
            {
              mode: 'bypassPermissions' as const,
              label: 'bypassPermissions',
              description: '尽量跳过确认'
            },
            { mode: 'plan' as const, label: 'plan', description: '规划优先' },
            {
              mode: 'dontAsk' as const,
              label: 'dontAsk',
              description: '更保守'
            }
          ]
        }
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_mode',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_mode', 'chat-1', '/agent mode')
    );
    await flushMicrotasks();

    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    expect(client.im.message.reply.mock.calls[0]![0]).toMatchObject({
      path: { message_id: 'om_mode' },
      data: { msg_type: 'interactive' }
    });
    const card = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain('当前模式: **plan**');
    expect(JSON.stringify(card)).toContain('set-agent-mode');
    expect(markCompleted).toHaveBeenCalledWith('om_mode');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('renders /agent model as an interactive control card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'control' as const,
        response: {
          format: 'agent-model-picker' as const,
          currentModel: 'claude-sonnet-4-6',
          options: [
            { model: 'default', label: 'default', description: '默认模型' },
            { model: 'best', label: 'best', description: '最强可用模型' },
            { model: 'sonnet', label: 'sonnet', description: '通用主力 alias' },
            { model: 'opus', label: 'opus', description: '更强推理 alias' },
            { model: 'haiku', label: 'haiku', description: '更快更轻量 alias' },
            {
              model: 'sonnet[1m]',
              label: 'sonnet[1m]',
              description: '1M 上下文 Sonnet'
            },
            {
              model: 'opus[1m]',
              label: 'opus[1m]',
              description: '1M 上下文 Opus'
            },
            {
              model: 'opusplan',
              label: 'opusplan',
              description: '规划类 alias'
            }
          ]
        }
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_model',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_model', 'chat-1', '/agent model')
    );
    await flushMicrotasks();

    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    const card = JSON.parse(
      client.im.message.reply.mock.calls[0]![0].data.content
    ) as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain('当前模型: **claude-sonnet-4-6**');
    expect(JSON.stringify(card)).toContain('sonnet[1m]');
    expect(JSON.stringify(card)).toContain('set-agent-model');
    expect(markCompleted).toHaveBeenCalledWith('om_model');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('accepts read receipt events without dispatching runtime work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {})
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = createClientStub();

    await (adapter as any).onMessageRead({
      event_type: 'im.message.message_read_v1',
      reader: {
        reader_id: {
          open_id: 'ou_1'
        },
        read_time: '1775201903173'
      },
      message_id_list: ['om_bot_1']
    });

    expect(orchestrator.dispatchInbound).not.toHaveBeenCalled();
    expect(orchestrator.handleInbound).not.toHaveBeenCalled();
    expect(orchestrator.dispatchControlCommand).not.toHaveBeenCalled();
  });

  it('returns a completed question card with 已回答 title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(
        async (interactionId: string, resolution: unknown) => ({
          chatId: 'chat-1',
          interaction: {
            kind: 'question' as const,
            id: interactionId,
            createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
            questions: [
              {
                id: 'frontend',
                header: '前端框架',
                question: '技术栈偏好？',
                options: [
                  {
                    label: 'React + TypeScript',
                    description: '主流选择'
                  }
                ]
              }
            ]
          },
          resolution
        })
      )
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'submit-question',
          interaction_id: 'question-1'
        },
        form_value: {
          choice_frontend: 'choice:React + TypeScript'
        }
      }
    });

    expect(orchestrator.resolveInteractionById).toHaveBeenCalledTimes(1);
    expect(response.card.data.header.title.content).toBe('已回答');
    expect(JSON.stringify(response.card.data)).toContain('React + TypeScript');
    expect(JSON.stringify(response.card.data)).not.toContain('需要你的回答');
  });

  it('returns approved permission cards with a grey header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(
        async (interactionId: string, resolution: unknown) => ({
          chatId: 'chat-1',
          interaction: {
            kind: 'permission' as const,
            id: interactionId,
            createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
            toolName: 'Bash',
            toolInput: {
              command: 'pnpm test'
            },
            suggestions: []
          },
          resolution
        })
      )
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'accept-once',
          interaction_id: 'permission-1'
        }
      }
    });

    expect(orchestrator.resolveInteractionById).toHaveBeenCalledTimes(1);
    expect(response.card.data.header.title.content).toBe('✅ 已批准');
    expect(response.card.data.header.template).toBe('grey');
  });

  it('switches agent mode from a control card action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(
        async (_chatId: string, _commandId: string, argsText: string) => ({
          format: 'text' as const,
          text: `Agent 权限模式已切换\nmode: ${argsText}\nsession: preserved\ntakesEffect: next-turn`
        })
      ),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(async () => undefined)
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'set-agent-mode',
          chat_id: 'chat-1',
          mode: 'dontAsk'
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'agent.mode',
      'dontAsk'
    );
    expect(response.toast.content).toBe('权限模式已切换');
    expect(response.card.data.header.template).toBe('green');
    expect(response.card.data.header.title.content).toBe(
      '✅ Agent 权限模式已切换'
    );
    expect(JSON.stringify(response.card.data)).toContain(
      '当前模式: **dontAsk**'
    );
    expect(JSON.stringify(response.card.data)).toContain(
      'takesEffect: next-turn'
    );
    expect(JSON.stringify(response.card.data)).not.toContain('set-agent-mode');
  });

  it('switches agent model from a control card action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(
        async (_chatId: string, _commandId: string, argsText: string) => ({
          format: 'text' as const,
          text: `Agent 模型已切换\nmodel: ${argsText}\nsession: reset`
        })
      ),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(async () => undefined)
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'set-agent-model',
          chat_id: 'chat-1',
          model: 'sonnet[1m]'
        }
      }
    });

    expect(orchestrator.dispatchControlCommand).toHaveBeenCalledWith(
      'chat-1',
      'agent.model',
      'sonnet[1m]'
    );
    expect(response.toast.content).toBe('模型已切换');
    expect(response.card.data.header.template).toBe('green');
    expect(response.card.data.header.title.content).toBe('✅ Agent 模型已切换');
    expect(JSON.stringify(response.card.data)).toContain(
      'Agent 模型已切换为 **sonnet[1m]**'
    );
    expect(JSON.stringify(response.card.data)).toContain('会话已重置');
    expect(JSON.stringify(response.card.data)).not.toContain('session: reset');
    expect(JSON.stringify(response.card.data)).not.toContain(
      'Agent 模型已切换\\n'
    );
    expect(JSON.stringify(response.card.data)).not.toContain('set-agent-model');
  });

  it('returns multi-select answers as arrays when multiple options are chosen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const orchestrator = {
      dispatchInbound: vi.fn(async () => ({
        kind: 'runtime' as const,
        message: null
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => []),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(
        async (interactionId: string, resolution: unknown) => ({
          chatId: 'chat-1',
          interaction: {
            kind: 'question' as const,
            id: interactionId,
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
          },
          resolution
        })
      )
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;

    const response = await (adapter as any).onCardAction({
      action: {
        value: {
          action: 'submit-question',
          interaction_id: 'question-multi-1'
        },
        form_value: {
          choice_stack: ['choice:React', 'choice:Node.js']
        }
      }
    });

    expect(orchestrator.resolveInteractionById).toHaveBeenCalledWith(
      'question-multi-1',
      {
        kind: 'question',
        answers: {
          stack: ['React', 'Node.js']
        }
      }
    );
    expect(JSON.stringify(response.card.data)).toContain('React, Node.js');
  });

  it('converts start confirmation replies into supplemental requirements without opening a new turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coding-claw-feishu-adapter-'));
    createdDirs.push(dir);

    const client = createClientStub();
    const startConfirmation = {
      kind: 'question' as const,
      id: 'start-confirm-1',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      questions: [
        {
          id: 'q_0',
          header: '开始确认',
          question: '确认开始实现？',
          options: []
        }
      ]
    };
    const orchestrator = {
      dispatchInbound: vi.fn(async (message) => ({
        kind: 'runtime' as const,
        message
      })),
      dispatchControlCommand: vi.fn(async () => ({
        format: 'text' as const,
        text: 'unused'
      })),
      listPendingInteractions: vi.fn(async () => [startConfirmation]),
      handleInbound: vi.fn(async () => {}),
      resolveInteractionById: vi.fn(
        async (interactionId: string, resolution: unknown) => ({
          chatId: 'chat-1',
          interaction: startConfirmation,
          resolution,
          interactionId
        })
      )
    };

    const adapter = new FeishuChannelAdapter(
      {
        appId: 'app-id',
        appSecret: 'app-secret',
        inboundStorePath: join(dir, 'inbound.json')
      },
      orchestrator as any
    );
    (adapter as any).client = client;
    (adapter as any).interactionMessages.set('start-confirm-1', {
      chatId: 'chat-1',
      messageId: 'reply-message-1',
      interaction: startConfirmation
    });

    const markCompleted = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    (adapter as any).inboundMessageStore = {
      reserve: vi.fn(async () => ({
        action: 'accepted',
        record: {
          messageId: 'om_followup',
          chatId: 'chat-1',
          status: 'processing'
        }
      })),
      markCompleted,
      markFailed
    };

    await (adapter as any).onMessage(
      createTextMessagePayload('om_followup', 'chat-1', '先补一个日志文件导出')
    );
    await flushMicrotasks();

    expect(orchestrator.dispatchInbound).toHaveBeenCalledTimes(1);
    expect(orchestrator.resolveInteractionById).toHaveBeenCalledWith(
      'start-confirm-1',
      {
        kind: 'question',
        answers: {
          q_0: '先补一个日志文件导出'
        }
      }
    );
    expect(orchestrator.handleInbound).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith('om_followup');
    expect(markFailed).not.toHaveBeenCalled();
    expect(client.im.message.update).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(client.im.message.update.mock.calls[0]![0])
    ).toContain('已转为补充需求');
    expect(
      JSON.stringify(client.im.message.update.mock.calls[0]![0])
    ).toContain('未开始');
  });
});

function createTextMessagePayload(
  messageId: string,
  chatId: string,
  text: string
): unknown {
  return {
    message: {
      chat_id: chatId,
      message_id: messageId,
      message_type: 'text',
      content: JSON.stringify({ text })
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createClientStub() {
  return {
    im: {
      message: {
        reply: vi.fn(async () => ({
          data: {
            message_id: 'reply-message-1'
          }
        })),
        update: vi.fn(async () => ({})),
        create: vi.fn(async () => ({
          data: {
            message_id: 'create-message-1'
          }
        }))
      }
    },
    cardkit: {
      v1: {
        card: {
          create: vi.fn(async () => ({
            data: {
              card_id: 'card-1'
            }
          })),
          update: vi.fn(async () => ({}))
        }
      }
    }
  };
}

function extractInteractionId(card: Record<string, unknown>): string {
  return extractActionInteractionId(card, 'confirm-control-command');
}

function extractActionInteractionId(
  card: Record<string, unknown>,
  actionName: string
): string {
  const elements =
    (card.body as { elements?: Array<Record<string, unknown>> } | undefined)
      ?.elements ?? [];
  const confirmButton = elements.find(
    (element) =>
      element.tag === 'button' &&
      (element.value as { action?: string } | undefined)?.action === actionName
  );
  return String(
    (confirmButton?.value as { interaction_id?: string } | undefined)
      ?.interaction_id ?? ''
  );
}
