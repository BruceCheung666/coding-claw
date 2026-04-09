import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../packages/runtime-claude/src/prompt/buildSystemPrompt.js';
import {
  CUSTOM_SYSTEM_PROMPT_METADATA_KEY,
  type WorkspaceBinding
} from '../packages/core/src/types.js';

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

describe('buildSystemPrompt', () => {
  it('includes static and dynamic sections plus CLAUDE.md', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'coding-claw-'));
    createdDirs.push(workspacePath);
    await writeFile(
      join(workspacePath, 'CLAUDE.md'),
      '# Repo Instructions\nUse tests.',
      'utf8'
    );

    const binding: WorkspaceBinding = {
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    };

    const result = await buildSystemPrompt({
      binding,
      model: 'claude-opus',
      language: 'zh-CN',
      mcpServers: ['filesystem']
    });

    expect(result.prompt).toContain('Claude Code compatible workflow');
    expect(result.prompt).toContain(`Working directory: ${workspacePath}`);
    expect(result.prompt).toContain('Preferred language: zh-CN');
    expect(result.prompt).toContain(
      'Routine workspace edits and ordinary development commands can proceed without extra approval.'
    );
    expect(result.prompt).toContain('Repository instructions from CLAUDE.md');
    expect(result.prompt).toContain(
      'MCP servers currently exposed: filesystem'
    );
    expect(result.sections.some((section) => section.name === 'memory')).toBe(
      true
    );
  });

  it('includes a custom system prompt section when metadata is present', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'coding-claw-'));
    createdDirs.push(workspacePath);

    const binding: WorkspaceBinding = {
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {
        [CUSTOM_SYSTEM_PROMPT_METADATA_KEY]: '请使用中文回复\n先给结论'
      }
    };

    const result = await buildSystemPrompt({ binding });

    expect(result.prompt).toContain(
      'Additional custom system instructions for this chat:'
    );
    expect(result.prompt).toContain('请使用中文回复');
    expect(
      result.sections.some((section) => section.name === 'custom_system_prompt')
    ).toBe(true);
  });

  it('omits the custom system prompt section when metadata is blank', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'coding-claw-'));
    createdDirs.push(workspacePath);

    const binding: WorkspaceBinding = {
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {
        [CUSTOM_SYSTEM_PROMPT_METADATA_KEY]: '   '
      }
    };

    const result = await buildSystemPrompt({ binding });

    expect(result.prompt).not.toContain(
      'Additional custom system instructions for this chat:'
    );
    expect(
      result.sections.some((section) => section.name === 'custom_system_prompt')
    ).toBe(false);
  });

  it('adds explicit team workflow guidance when team tools are available', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'coding-claw-'));
    createdDirs.push(workspacePath);

    const binding: WorkspaceBinding = {
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    };

    const result = await buildSystemPrompt({
      binding,
      availableTools: ['Agent', 'SendMessage', 'TeamCreate', 'TeamDelete']
    });

    expect(result.prompt).toContain(
      'Agent team capabilities are enabled in this session.'
    );
    expect(result.prompt).toContain(
      'call TeamCreate before spawning teammates with Agent'
    );
    expect(result.prompt).toContain(
      'Never invent a team_name unless TeamCreate already established that team.'
    );
    expect(result.prompt).toContain(
      'do not poll teammate agent IDs with TaskOutput'
    );
  });

  it('warns against team_name when named teams are unavailable', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'coding-claw-'));
    createdDirs.push(workspacePath);

    const binding: WorkspaceBinding = {
      chatId: 'chat-1',
      workspaceId: 'chat-1',
      workspacePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtime: 'claude',
      channel: 'feishu',
      mode: 'default',
      metadata: {}
    };

    const result = await buildSystemPrompt({
      binding,
      availableTools: ['Agent']
    });

    expect(result.prompt).toContain(
      'Only plain subagents are available in this session.'
    );
    expect(result.prompt).toContain('Do not set team_name on Agent calls.');
  });
});
