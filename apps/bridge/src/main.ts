import { mkdirSync } from 'node:fs';
import { errorToLogObject, logDebug } from '@coding-claw/core';
import {
  BridgeOrchestrator,
  InMemoryApprovalStore,
  InMemoryChatControlStateStore,
  InMemoryTranscriptStore,
  InMemoryWorkspaceBindingStore
} from '@coding-claw/core';
import { FeishuChannelAdapter } from '@coding-claw/channel-feishu';
import { ClaudeAgentRuntime } from '@coding-claw/runtime-claude';
import { LocalShellExecutor } from './LocalShellExecutor.js';

interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    inboundStorePath: string;
  };
  runtime: {
    model?: string;
    workspaceRoot: string;
    language?: string;
    claudeExecutablePath?: string;
    shellPath?: string;
    enableAgentTeams: boolean;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function loadConfig(): AppConfig {
  const workspaceRoot =
    process.env.CODING_CLAW_WORKSPACE_ROOT ??
    `${process.cwd()}/.claude/workspaces`;

  return {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
      inboundStorePath: `${workspaceRoot}/.bridge-state/inbound-messages.json`
    },
    runtime: {
      model: process.env.CLAUDE_MODEL,
      language: process.env.CODING_CLAW_LANGUAGE ?? 'zh-CN',
      workspaceRoot,
      claudeExecutablePath: process.env.CODING_CLAW_CLAUDE_PATH,
      shellPath: process.env.CODING_CLAW_SHELL,
      enableAgentTeams:
        isTruthyEnv(process.env.CODING_CLAW_ENABLE_AGENT_TEAMS) ||
        isTruthyEnv(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.runtime.workspaceRoot, { recursive: true });

  const runtime = new ClaudeAgentRuntime({
    model: config.runtime.model,
    language: config.runtime.language,
    pathToClaudeCodeExecutable: config.runtime.claudeExecutablePath,
    enableAgentTeams: config.runtime.enableAgentTeams,
    env: config.runtime.enableAgentTeams
      ? {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
        }
      : undefined
  });

  const orchestrator = new BridgeOrchestrator({
    runtime,
    approvals: new InMemoryApprovalStore(),
    controls: new InMemoryChatControlStateStore(),
    bindings: new InMemoryWorkspaceBindingStore(),
    shellExecutor: new LocalShellExecutor({
      shellPath: config.runtime.shellPath
    }),
    transcripts: new InMemoryTranscriptStore(),
    workspaceRoot: config.runtime.workspaceRoot
  });

  const adapter = new FeishuChannelAdapter(config.feishu, orchestrator);
  await adapter.start();

  logDebug('[coding-claw] Feishu bridge started');
}

void main().catch((error) => {
  logDebug('[coding-claw] fatal error', errorToLogObject(error));
  process.exitCode = 1;
});
