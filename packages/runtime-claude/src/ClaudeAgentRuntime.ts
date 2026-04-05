import type {
  AgentRuntime,
  RuntimeSession,
  WorkspaceBinding
} from '@coding-claw/core';
import {
  ClaudeRuntimeSession,
  type ClaudeRuntimeSessionOptions
} from './session/ClaudeRuntimeSession.js';

export class ClaudeAgentRuntime implements AgentRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(private readonly options: ClaudeRuntimeSessionOptions = {}) {}

  async getOrCreateSession(binding: WorkspaceBinding): Promise<RuntimeSession> {
    const cached = this.sessions.get(binding.chatId);
    if (cached) {
      return cached;
    }

    const session = new ClaudeRuntimeSession(binding, this.options);
    this.sessions.set(binding.chatId, session);
    return session;
  }

  async dropSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }

    session.abort();
    this.sessions.delete(chatId);
  }
}
