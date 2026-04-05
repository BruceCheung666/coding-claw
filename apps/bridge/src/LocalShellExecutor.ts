import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import type {
  ShellExecutionInput,
  ShellExecutionResult,
  ShellExecutor,
  ShellSessionSnapshot
} from '@coding-claw/core';

interface ActiveCommand {
  readonly doneMarker: string;
  readonly markers: {
    start: string;
    cwd: string;
    git: string;
    exit: string;
    done: string;
  };
  readonly resolve: (result: ShellExecutionResult) => void;
  readonly reject: (error: Error) => void;
  stdout: string;
  stderr: string;
}

interface ShellSession {
  readonly chatId: string;
  readonly sessionId: string;
  readonly process: ChildProcessWithoutNullStreams;
  currentCwd: string;
  busy: boolean;
  queue: Promise<void>;
  activeCommand?: ActiveCommand;
  closed: boolean;
}

export interface LocalShellExecutorOptions {
  shellPath?: string;
}

export class LocalShellExecutor implements ShellExecutor {
  private readonly sessions = new Map<string, ShellSession>();

  constructor(private readonly options: LocalShellExecutorOptions = {}) {}

  async execute(input: ShellExecutionInput): Promise<ShellExecutionResult> {
    const session = this.getOrCreateSession(input.chatId, input.workspacePath);
    return this.enqueue(session, async () => this.runCommand(session, input));
  }

  async reset(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) {
      return;
    }

    this.sessions.delete(chatId);
    session.closed = true;
    session.activeCommand?.reject(new Error('Shell session reset.'));
    session.activeCommand = undefined;
    session.process.kill('SIGTERM');
  }

  async getStatus(chatId: string): Promise<ShellSessionSnapshot> {
    const session = this.sessions.get(chatId);
    if (!session || session.closed || session.process.killed) {
      return {
        active: false,
        running: false
      };
    }

    return {
      active: true,
      running: session.busy,
      sessionId: session.sessionId,
      pid: session.process.pid
    };
  }

  private async runCommand(
    session: ShellSession,
    input: ShellExecutionInput
  ): Promise<ShellExecutionResult> {
    const markerId = randomUUID();
    const startMarker = `__CODING_CLAW_START_${markerId}__`;
    const cwdMarker = `__CODING_CLAW_CWD_${markerId}__`;
    const gitMarker = `__CODING_CLAW_GIT_${markerId}__`;
    const exitMarker = `__CODING_CLAW_EXIT_${markerId}__`;
    const doneMarker = `__CODING_CLAW_DONE_${markerId}__`;
    const body =
      session.currentCwd !== input.cwd
        ? `if cd ${shellEscape(input.cwd)}; then ${input.command}; __exit=$?; else __exit=$?; fi`
        : `${input.command}; __exit=$?`;

    const command = [
      `printf '%s\\n' '${startMarker}'`,
      body,
      `printf '%s%s\\n' '${cwdMarker}' "$(pwd)"`,
      '__branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
      `if [ "$__branch" = "HEAD" ]; then __branch=$(git rev-parse --short HEAD 2>/dev/null); fi`,
      `printf '%s%s\\n' '${gitMarker}' "$__branch"`,
      `printf '%s%s\\n' '${exitMarker}' "$__exit"`,
      `printf '%s\\n' '${doneMarker}'`
    ].join('; ');

    return new Promise<ShellExecutionResult>((resolve, reject) => {
      session.busy = true;
      session.activeCommand = {
        doneMarker,
        markers: {
          start: startMarker,
          cwd: cwdMarker,
          git: gitMarker,
          exit: exitMarker,
          done: doneMarker
        },
        stdout: '',
        stderr: '',
        resolve: (result) => {
          session.busy = false;
          resolve(result);
        },
        reject: (error) => {
          session.busy = false;
          reject(error);
        }
      };
      session.process.stdin.write(`${command}\n`);
    });
  }

  private getOrCreateSession(
    chatId: string,
    workspacePath: string
  ): ShellSession {
    const existing = this.sessions.get(chatId);
    if (existing && !existing.closed) {
      return existing;
    }

    const shellPath = resolveShellPath(this.options.shellPath);
    const process = spawn(shellPath, resolveShellArgs(shellPath), {
      cwd: workspacePath,
      stdio: 'pipe'
    });
    const session: ShellSession = {
      chatId,
      sessionId: randomUUID(),
      process,
      currentCwd: workspacePath,
      busy: false,
      queue: Promise.resolve(),
      closed: false
    };

    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');

    process.stdout.on('data', (chunk: string) => {
      const active = session.activeCommand;
      if (!active) {
        return;
      }

      active.stdout += chunk;
      if (!active.stdout.includes(active.doneMarker)) {
        return;
      }

      const completed = session.activeCommand;
      session.activeCommand = undefined;
      if (!completed) {
        return;
      }

      try {
        const result = normalizeResult(
          completed.stdout,
          completed.stderr,
          session.currentCwd,
          session.sessionId,
          completed.markers
        );
        session.currentCwd = result.cwd;
        completed.resolve(result);
      } catch (error) {
        completed.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    process.stderr.on('data', (chunk: string) => {
      if (session.activeCommand) {
        session.activeCommand.stderr += chunk;
      }
    });

    process.on('exit', (code, signal) => {
      session.closed = true;
      this.sessions.delete(chatId);
      const active = session.activeCommand;
      session.activeCommand = undefined;
      if (active) {
        active.reject(
          new Error(
            `Shell session exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`
          )
        );
      }
    });

    process.on('error', (error) => {
      session.closed = true;
      this.sessions.delete(chatId);
      const active = session.activeCommand;
      session.activeCommand = undefined;
      active?.reject(error);
    });

    this.sessions.set(chatId, session);
    return session;
  }

  private enqueue<T>(session: ShellSession, fn: () => Promise<T>): Promise<T> {
    const run = session.queue.then(fn, fn);
    session.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function normalizeResult(
  stdout: string,
  stderr: string,
  fallbackCwd: string,
  sessionId: string,
  markers: {
    start: string;
    cwd: string;
    git: string;
    exit: string;
    done: string;
  }
): ShellExecutionResult {
  const outputWithoutDone = removeMarkerLine(stdout, markers.done);
  const outputWithoutStart = removeMarkerLine(
    outputWithoutDone.output,
    markers.start
  );
  const exit = extractMarker(outputWithoutStart.output, markers.exit);
  const git = extractMarker(exit.output, markers.git);
  const cwd = extractMarker(git.output, markers.cwd);

  return {
    exitCode: Number.parseInt(exit.value ?? '1', 10) || 0,
    stdout: cwd.output.trimEnd(),
    stderr: stderr.trimEnd(),
    cwd: cwd.value || fallbackCwd,
    gitBranch: git.value || null,
    sessionId
  };
}

function extractMarker(
  stdout: string,
  marker: string
): { output: string; value: string | null } {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.startsWith(marker)) {
      return {
        output: [...lines.slice(0, index), ...lines.slice(index + 1)].join(
          '\n'
        ),
        value: line.slice(marker.length) || null
      };
    }
  }

  return {
    output: stdout,
    value: null
  };
}

function removeMarkerLine(stdout: string, marker: string): { output: string } {
  const lines = stdout.split('\n');
  const filtered = lines.filter((line) => line !== marker);
  return {
    output: filtered.join('\n')
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveShellPath(configuredShellPath?: string): string {
  return configuredShellPath || '/bin/sh';
}

function resolveShellArgs(shellPath: string): string[] {
  const shellName = basename(shellPath).toLowerCase();
  if (shellName === 'zsh') {
    return ['-f', '-s'];
  }
  if (shellName === 'bash') {
    return ['--noprofile', '--norc', '-s'];
  }
  return ['-s'];
}
