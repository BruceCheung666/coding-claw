import { describe, expect, it } from 'vitest';
import { ClaudeRuntimeSession } from '../packages/runtime-claude/src/session/ClaudeRuntimeSession.js';
import { SubagentDrainController } from '../packages/runtime-claude/src/session/SubagentDrainController.js';

describe('ClaudeRuntimeSession sub-agent mapping', () => {
  it('maps TodoWrite todos into task list updates', () => {
    const session = new ClaudeRuntimeSession({
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    });

    const queue = {
      items: [] as unknown[],
      push(value: unknown) {
        this.items.push(value);
      }
    };

    (session as any).trackToolUse(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        id: 'tooluse_todo_1',
        name: 'TodoWrite',
        input: {
          todos: [
            {
              activeForm: '初始化项目骨架',
              content: '初始化前后端项目骨架',
              status: 'in_progress'
            },
            {
              content: '实现后端配置版本、差异对比与发布核心模块',
              status: 'pending'
            },
            {
              content: '补充示例配置、基础测试与本地运行说明',
              status: 'completed'
            }
          ]
        }
      },
      queue
    );

    const event = queue.items.at(-1) as {
      type: string;
      tasks: Array<{
        subject: string;
        status: string;
      }>;
    };

    expect(event.type).toBe('turn.tasks.updated');
    expect(event.tasks).toEqual([
      {
        id: '初始化前后端项目骨架#1',
        subject: '初始化项目骨架',
        status: 'in_progress'
      },
      {
        id: '实现后端配置版本、差异对比与发布核心模块#2',
        subject: '实现后端配置版本、差异对比与发布核心模块',
        status: 'pending'
      },
      {
        id: '补充示例配置、基础测试与本地运行说明#3',
        subject: '补充示例配置、基础测试与本地运行说明',
        status: 'completed'
      }
    ]);
  });

  it('uses task_started.tool_use_id to recover a readable agent name', () => {
    const session = new ClaudeRuntimeSession({
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    });

    const queue = {
      items: [] as unknown[],
      push(value: unknown) {
        this.items.push(value);
      }
    };

    (session as any).pendingAgents = new Map();
    (session as any).trackToolUse(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        id: 'tooluse_agent_1',
        name: 'Agent',
        input: {
          description: 'Plan game server config management web app',
          subagent_type: 'Plan'
        }
      },
      queue
    );

    (session as any).trackTaskStarted(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'a7d54dda294b9734b',
        tool_use_id: 'tooluse_agent_1',
        parent_tool_use_id: null
      },
      new SubagentDrainController(),
      queue
    );

    const event = queue.items.at(-1) as {
      type: string;
      agents: Array<{
        name: string;
        agentType: string;
        taskId: string;
      }>;
    };

    expect(event.type).toBe('turn.agent.updated');
    expect(event.agents).toHaveLength(1);
    expect(event.agents[0]).toMatchObject({
      taskId: 'a7d54dda294b9734b',
      name: 'Plan game server config management web app',
      agentType: 'Plan',
      status: 'running'
    });
  });

  it('marks an agent as failed when its tool_result returns an error after task_started', () => {
    const session = new ClaudeRuntimeSession({
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    });

    const queue = {
      items: [] as unknown[],
      push(value: unknown) {
        this.items.push(value);
      }
    };

    const drain = new SubagentDrainController();

    (session as any).pendingAgents = new Map();
    (session as any).agents = new Map();
    (session as any).agentTaskIdsByToolUseId = new Map();
    (session as any).failedAgentToolUseResults = new Map();
    (session as any).trackToolUse(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        id: 'tooluse_agent_1',
        name: 'Agent',
        input: {
          description: 'Repo structure explorer',
          subagent_type: 'Explore'
        }
      },
      queue
    );

    (session as any).trackTaskStarted(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tooluse_agent_1',
        parent_tool_use_id: null
      },
      drain,
      queue
    );

    (session as any).trackToolResultError(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tooluse_agent_1',
              is_error: true,
              content: 'Team "team-claw" does not exist.'
            }
          ]
        }
      },
      drain,
      queue
    );

    const event = queue.items.at(-1) as {
      type: string;
      agents: Array<{
        taskId: string;
        status: string;
        summary?: string;
      }>;
    };

    expect(event.type).toBe('turn.agent.updated');
    expect(event.agents).toHaveLength(1);
    expect(event.agents[0]).toMatchObject({
      taskId: 'task-1',
      status: 'failed',
      summary: 'Team "team-claw" does not exist.'
    });
    expect(drain.size).toBe(0);
  });

  it('keeps a failed tool_result attached when the error arrives before task_started', () => {
    const session = new ClaudeRuntimeSession({
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    });

    const queue = {
      items: [] as unknown[],
      push(value: unknown) {
        this.items.push(value);
      }
    };

    const drain = new SubagentDrainController();

    (session as any).pendingAgents = new Map();
    (session as any).agents = new Map();
    (session as any).agentTaskIdsByToolUseId = new Map();
    (session as any).failedAgentToolUseResults = new Map();
    (session as any).trackToolUse(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        id: 'tooluse_agent_1',
        name: 'Agent',
        input: {
          description: 'Repo structure explorer',
          subagent_type: 'Explore'
        }
      },
      queue
    );

    (session as any).trackToolResultError(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tooluse_agent_1',
              is_error: true,
              content: 'Team "default" does not exist.'
            }
          ]
        }
      },
      drain,
      queue
    );

    (session as any).trackTaskStarted(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'tooluse_agent_1',
        parent_tool_use_id: null
      },
      drain,
      queue
    );

    const event = queue.items.at(-1) as {
      type: string;
      agents: Array<{
        taskId: string;
        status: string;
        summary?: string;
      }>;
    };

    expect(event.type).toBe('turn.agent.updated');
    expect(event.agents).toHaveLength(1);
    expect(event.agents[0]).toMatchObject({
      taskId: 'task-1',
      status: 'failed',
      summary: 'Team "default" does not exist.'
    });
    expect(drain.size).toBe(0);
  });

  it('requests team tools and opt-in flags when agent teams are enabled', () => {
    const session = new ClaudeRuntimeSession(
      {
        chatId: 'chat-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
        updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
        runtime: 'claude',
        channel: 'feishu',
        mode: 'default',
        metadata: {}
      },
      {
        enableAgentTeams: true,
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
        }
      }
    );

    const requestedTools = (session as any).getRequestedTools();
    const runtimeEnv = (session as any).buildRuntimeEnv();
    const extraArgs = (session as any).buildExtraArgs();

    expect(requestedTools).toEqual(
      expect.arrayContaining([
        'Agent',
        'SendMessage',
        'TeamCreate',
        'TeamDelete'
      ])
    );
    expect(runtimeEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(extraArgs).toBeUndefined();
  });

  it('rewrites teammate agent IDs to real task IDs for TaskOutput', () => {
    const session = new ClaudeRuntimeSession({
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      createdAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-04-03T00:00:00Z').toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    });

    const queue = {
      items: [] as unknown[],
      push(value: unknown) {
        this.items.push(value);
      }
    };

    const drain = new SubagentDrainController();

    (session as any).pendingAgents = new Map();
    (session as any).agents = new Map();
    (session as any).agentTaskIdsByToolUseId = new Map();
    (session as any).failedAgentToolUseResults = new Map();
    (session as any).teammateTaskIdsByAgentId = new Map();
    (session as any).teammateNamesByAgentId = new Map();
    (session as any).teammateTaskIdsByName = new Map();

    (session as any).trackToolUse(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        id: 'tooluse_agent_1',
        name: 'Agent',
        input: {
          description: 'Architect teammate',
          name: 'architect',
          team_name: 'game-config-web',
          subagent_type: 'Plan'
        }
      },
      queue
    );

    (session as any).trackTaskStarted(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-architect',
        tool_use_id: 'tooluse_agent_1',
        parent_tool_use_id: null
      },
      drain,
      queue
    );

    (session as any).trackTeammateSpawnResult(
      {
        chatId: 'chat-1',
        turnId: 'turn-1'
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tooluse_agent_1',
              content: [
                {
                  type: 'text',
                  text: 'Spawned successfully.'
                }
              ]
            }
          ]
        },
        tool_use_result: {
          status: 'teammate_spawned',
          agent_id: 'architect@game-config-web',
          teammate_id: 'architect@game-config-web',
          name: 'architect',
          team_name: 'game-config-web'
        }
      }
    );

    const rewritten = (session as any).rewriteTeamToolInput('TaskOutput', {
      task_id: 'architect@game-config-web',
      block: true
    });

    expect(rewritten).toMatchObject({
      task_id: 'task-architect',
      block: true
    });
  });
});
