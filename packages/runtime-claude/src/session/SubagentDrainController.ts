export type DrainDecision =
  | { shouldClose: false }
  | {
      shouldClose: true;
      reason: 'no-running-agents' | 'session-idle' | 'timeout';
    };

export class SubagentDrainController {
  private readonly runningAgents = new Set<string>();
  private resultSeen = false;
  private deadline = 0;
  private lastActivityAt = 0;

  constructor(private readonly timeoutMs = 10 * 60 * 1000) {}

  markTaskStarted(taskId: string, now = Date.now()): void {
    this.runningAgents.add(taskId);
    this.lastActivityAt = now;
  }

  markTaskFinished(taskId: string, now = Date.now()): void {
    this.runningAgents.delete(taskId);
    this.lastActivityAt = now;
  }

  markResult(now = Date.now()): DrainDecision {
    this.resultSeen = true;
    this.lastActivityAt = now;
    if (this.runningAgents.size === 0) {
      return { shouldClose: true, reason: 'no-running-agents' };
    }

    this.deadline = now + this.timeoutMs;
    return { shouldClose: false };
  }

  markActivity(now = Date.now()): void {
    if (!this.resultSeen) {
      return;
    }
    this.lastActivityAt = now;
    this.deadline = now + this.timeoutMs;
  }

  evaluateSystemState(state: unknown, now = Date.now()): DrainDecision {
    if (!this.resultSeen) {
      return { shouldClose: false };
    }

    if (this.runningAgents.size === 0) {
      return { shouldClose: true, reason: 'no-running-agents' };
    }

    if (state === 'idle') {
      return { shouldClose: true, reason: 'session-idle' };
    }

    if (this.deadline > 0 && now > this.deadline) {
      return { shouldClose: true, reason: 'timeout' };
    }

    return { shouldClose: false };
  }

  get size(): number {
    return this.runningAgents.size;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  get hasResult(): boolean {
    return this.resultSeen;
  }

  getRunningTaskIds(): string[] {
    return [...this.runningAgents];
  }
}
