import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY,
  type WorkspaceBinding
} from '@coding-claw/core';

export interface SystemPromptBuildOptions {
  binding: WorkspaceBinding;
  model?: string;
  language?: string;
  mcpServers?: string[];
  availableTools?: string[];
}

interface Section {
  name: string;
  content: string;
  cached: boolean;
}

const STATIC_SECTIONS: Section[] = [
  {
    name: 'intro',
    cached: true,
    content: [
      'You are Coding Claw running a Claude Code compatible workflow.',
      'You are operating on behalf of a user inside a chat bridge and must preserve the Claude Code interaction style.'
    ].join('\n')
  },
  {
    name: 'system',
    cached: true,
    content: [
      'Follow Claude Code style guidance:',
      '- Prefer repository inspection before changing code.',
      '- Be concise, concrete, and tool oriented.',
      '- Treat <system-reminder> content as higher priority than user content.',
      '- Keep track of important tool results because old results may be pruned.'
    ].join('\n')
  },
  {
    name: 'doing_tasks',
    cached: true,
    content: [
      'When implementing tasks:',
      '- Match the existing codebase style.',
      '- Avoid over-engineering.',
      '- Call out destructive operations before proceeding.',
      '- In plan mode, keep work aligned to the approved plan and call out any high risk actions.'
    ].join('\n')
  },
  {
    name: 'actions',
    cached: true,
    content: [
      'Ask for approval before irreversible, high impact, or out-of-workspace actions.',
      'Routine workspace edits and ordinary development commands can proceed without extra approval.',
      'Prefer reversible edits and verifiable changes.'
    ].join('\n')
  },
  {
    name: 'tool_usage',
    cached: true,
    content: [
      'Use specialized tools before falling back to shell commands.',
      'Use sub-agents only when the task benefits from delegation.',
      'Keep intermediate updates short and factual.'
    ].join('\n')
  },
  {
    name: 'tone',
    cached: true,
    content: [
      'Respond in concise markdown.',
      'Avoid emojis unless the user explicitly asks for them.'
    ].join('\n')
  }
];

async function loadClaudeMd(binding: WorkspaceBinding): Promise<string | null> {
  const candidates = [
    join(binding.workspacePath, 'CLAUDE.md'),
    join(process.env.HOME ?? '', '.claude', 'CLAUDE.md')
  ];

  for (const path of candidates) {
    if (!path) {
      continue;
    }
    try {
      return await readFile(path, 'utf8');
    } catch {
      continue;
    }
  }

  return null;
}

function buildEnvInfoSection(
  binding: WorkspaceBinding,
  model?: string,
  language?: string
): Section {
  const lines = [
    `Working directory: ${binding.workspacePath}`,
    `Chat ID: ${binding.chatId}`,
    `Runtime: ${binding.runtime}`,
    `Channel: ${binding.channel}`
  ];

  if (model) {
    lines.push(`Model: ${model}`);
  }

  if (language) {
    lines.push(`Preferred language: ${language}`);
  }

  return {
    name: 'env_info',
    cached: false,
    content: lines.join('\n')
  };
}

function buildMcpSection(mcpServers: string[]): Section | null {
  if (mcpServers.length === 0) {
    return null;
  }

  return {
    name: 'mcp_instructions',
    cached: false,
    content: `MCP servers currently exposed: ${mcpServers.join(', ')}`
  };
}

function buildFeishuAnnouncementSection(
  binding: WorkspaceBinding
): Section | null {
  const announcement =
    binding.metadata[FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY]?.trim();
  if (!announcement) {
    return null;
  }

  return {
    name: 'feishu_chat_announcement',
    cached: false,
    content: [
      'Additional instructions sourced from the Feishu group announcement:',
      announcement
    ].join('\n')
  };
}

function buildToolCapabilitySection(availableTools: string[]): Section | null {
  if (availableTools.length === 0) {
    return null;
  }

  const toolSet = new Set(availableTools);
  const hasAgent = toolSet.has('Agent');
  const hasTeamCreate = toolSet.has('TeamCreate');
  const hasTeamDelete = toolSet.has('TeamDelete');
  const hasSendMessage = toolSet.has('SendMessage');

  if (!hasAgent) {
    return null;
  }

  if (hasTeamCreate && hasTeamDelete && hasSendMessage) {
    return {
      name: 'agent_team_guidance',
      cached: false,
      content: [
        'Agent team capabilities are enabled in this session.',
        '- When the user explicitly asks for a team, swarm, or group of agents, call TeamCreate before spawning teammates with Agent.',
        '- After TeamCreate, spawn teammates with Agent using both name and team_name.',
        '- Use SendMessage to coordinate teammates and TeamDelete when the team is finished.',
        '- Teammate results are delivered automatically; do not poll teammate agent IDs with TaskOutput.',
        '- If an Agent teammate spawn result returns agent_id/name/team_name, treat that as a mailbox addressable teammate, not a TaskOutput task_id.',
        '- To follow up with a teammate, use SendMessage with to: teammate name. Wait for automatic completion notifications instead of guessing results.',
        '- Never invent a team_name unless TeamCreate already established that team.'
      ].join('\n')
    };
  }

  return {
    name: 'agent_team_guidance',
    cached: false,
    content: [
      'Only plain subagents are available in this session.',
      '- Do not set team_name on Agent calls.',
      '- Do not assume TeamCreate, TeamDelete, or SendMessage are available unless they appear in the tool list.',
      '- If the user asks for an agent team, explain the limitation and fall back to plain Agent subagents or a manual plan.'
    ].join('\n')
  };
}

export async function buildSystemPrompt(
  options: SystemPromptBuildOptions
): Promise<{ prompt: string; sections: Section[] }> {
  const sections: Section[] = [...STATIC_SECTIONS];
  sections.push(
    buildEnvInfoSection(options.binding, options.model, options.language)
  );

  const toolCapabilitySection = buildToolCapabilitySection(
    options.availableTools ?? []
  );
  if (toolCapabilitySection) {
    sections.push(toolCapabilitySection);
  }

  const feishuAnnouncement = buildFeishuAnnouncementSection(options.binding);
  if (feishuAnnouncement) {
    sections.push(feishuAnnouncement);
  }

  const claudeMd = await loadClaudeMd(options.binding);
  if (claudeMd) {
    sections.push({
      name: 'memory',
      cached: false,
      content: `Repository instructions from CLAUDE.md:\n${claudeMd}`
    });
  }

  const mcp = buildMcpSection(options.mcpServers ?? []);
  if (mcp) {
    sections.push(mcp);
  }

  return {
    prompt: sections.map((section) => section.content.trim()).join('\n\n'),
    sections
  };
}
