import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { errorToLogObject, logDebug } from '@coding-claw/core';
import {
  BridgeOrchestrator,
  FileApprovalStore,
  FileChatControlStateStore,
  FileTranscriptStore,
  FileWorkspaceBindingStore,
  SessionPathResolver
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
  session: {
    rootPath: string;
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
  const sessionRoot =
    process.env.CODING_CLAW_SESSION_ROOT ?? `${homedir()}/.coding-claw/session`;

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
    },
    session: {
      rootPath: sessionRoot
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.runtime.workspaceRoot, { recursive: true });
  mkdirSync(config.session.rootPath, { recursive: true });

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
  const sessionResolver = new SessionPathResolver(config.session.rootPath);

  const orchestrator = new BridgeOrchestrator({
    runtime,
    approvals: new FileApprovalStore(sessionResolver),
    controls: new FileChatControlStateStore(sessionResolver),
    bindings: new FileWorkspaceBindingStore(sessionResolver),
    shellExecutor: new LocalShellExecutor({
      shellPath: config.runtime.shellPath
    }),
    transcripts: new FileTranscriptStore(sessionResolver),
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
