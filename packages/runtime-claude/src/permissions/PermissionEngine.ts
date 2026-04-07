import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  InteractionResolution,
  PendingInteraction,
  PendingPermissionRequest,
  PendingPlanApprovalRequest,
  PendingQuestionRequest,
  PermissionMode,
  PermissionReason,
  PermissionSuggestion,
  QuestionPrompt
} from '@coding-claw/core';
import {
  extractSuggestedBashRule,
  findDangerousCommandReason,
  matchBashRule
} from './BashPermissionUtils.js';
import {
  evaluateFilePathAccess,
  getResolvedFilePath,
  isWithinWorkspaceOrAllowedDirectories
} from './PathSafety.js';
import { buildPermissionPresentation } from './PermissionPresentation.js';

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
  interaction?: PendingInteraction;
}

const FILE_EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite'
]);
const FILE_SYSTEM_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite'
]);
const DEFAULT_ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite'
]);

export class PermissionEngine {
  private mode: PermissionMode;
  private prePlanMode: PermissionMode = 'default';
  private readonly pending = new Map<
    string,
    (resolution: InteractionResolution) => void
  >();
  private readonly sessionRules = new Set<string>();
  private readonly allowedDirectories = new Set<string>();

  constructor(
    initialMode: PermissionMode,
    private readonly onInteraction?: (interaction: PendingInteraction) => void,
    private readonly cwd: string = process.cwd(),
    private readonly onModeChanged?: (
      from: PermissionMode,
      to: PermissionMode
    ) => void
  ) {
    this.mode = initialMode;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  resolve(interactionId: string, resolution: InteractionResolution): void {
    const resolver = this.pending.get(interactionId);
    if (!resolver) {
      console.warn('[permission] missing pending interaction', {
        interactionId
      });
      return;
    }
    this.pending.delete(interactionId);
    console.log('[permission] resolved interaction', {
      interactionId,
      kind: resolution.kind
    });
    resolver(resolution);
  }

  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<PermissionDecision> {
    if (toolName === 'AskUserQuestion') {
      return this.handleQuestion(toolInput);
    }

    if (toolName === 'EnterPlanMode') {
      this.prePlanMode = this.mode;
      this.setMode('plan');
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName === 'ExitPlanMode') {
      return this.handlePlanApproval(toolInput);
    }

    const filePath = getResolvedFilePath(toolInput, this.cwd);
    const writeIntent = FILE_EDIT_TOOLS.has(toolName);
    const filePathSafety = filePath
      ? evaluateFilePathAccess(filePath, {
          cwd: this.cwd,
          allowedDirectories: this.allowedDirectories,
          writeIntent
        })
      : { status: 'safe' as const };

    if (filePathSafety.status === 'deny') {
      return {
        behavior: 'deny',
        message: filePathSafety.reason.message
      };
    }

    if (this.mode === 'plan') {
      const planDecision = this.evaluatePlanMode(toolName, toolInput, filePath);
      if (planDecision) {
        return planDecision;
      }
    }

    if (filePathSafety.status === 'ask') {
      return this.requestPermission(toolName, toolInput, filePathSafety.reason);
    }

    if (this.mode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (this.isAllowedBySessionScope(toolName, toolInput, filePath)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    const bashReason =
      toolName === 'Bash' && typeof toolInput.command === 'string'
        ? findDangerousCommandReason(toolInput.command)
        : undefined;

    if (bashReason) {
      return this.requestPermission(toolName, toolInput, {
        kind: 'dangerous-command',
        message: `${bashReason}，需要显式批准。`
      });
    }

    if (this.isAllowedByDefault(toolName, toolInput)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (this.mode === 'acceptEdits' && FILE_EDIT_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (this.mode === 'dontAsk') {
      return {
        behavior: 'deny',
        message: `${toolName} is not allowed in dontAsk mode.`
      };
    }

    const defaultReason = this.buildDefaultReason(toolName, filePath);
    return this.requestPermission(toolName, toolInput, defaultReason);
  }

  private async handleQuestion(
    toolInput: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const questions = Array.isArray(toolInput.questions)
      ? toolInput.questions
      : [];
    const interaction: PendingQuestionRequest = {
      kind: 'question',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      questions: questions.map((question, index) => {
        const candidate = question as Record<string, unknown>;
        return {
          id: `q_${index}`,
          header: String(candidate.header ?? ''),
          question: String(candidate.question ?? ''),
          options: Array.isArray(candidate.options)
            ? (candidate.options as Array<Record<string, unknown>>).map(
                (option) => ({
                  label: String(option.label ?? ''),
                  description: String(option.description ?? '')
                })
              )
            : [],
          multiSelect: Boolean(candidate.multiSelect)
        } satisfies QuestionPrompt;
      })
    };

    const resolution = await this.waitForResolution(interaction);
    if (resolution.kind !== 'question') {
      return {
        behavior: 'deny',
        message: 'Question request was resolved with the wrong payload.'
      };
    }

    const answersByQuestion = Object.fromEntries(
      interaction.questions.map((question) => {
        const answer = resolution.answers[question.id];
        return [
          question.question,
          Array.isArray(answer) ? answer.join(', ') : (answer ?? '')
        ];
      })
    );
    console.log(
      '[permission] ask-user-question answers ready',
      answersByQuestion
    );

    return {
      behavior: 'allow',
      updatedInput: {
        ...toolInput,
        answers: answersByQuestion
      }
    };
  }

  private async handlePlanApproval(
    toolInput: Record<string, unknown>
  ): Promise<PermissionDecision> {
    if (this.mode !== 'plan') {
      console.warn('[permission] ExitPlanMode called while not in plan mode', {
        mode: this.mode,
        toolInput
      });
      return {
        behavior: 'allow',
        updatedInput: {
          ...toolInput,
          __planModeNoop: true
        }
      };
    }

    const interaction: PendingPlanApprovalRequest = {
      kind: 'plan-approval',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      plan: String(toolInput.plan ?? ''),
      filePath:
        typeof toolInput.planFilePath === 'string'
          ? toolInput.planFilePath
          : undefined
    };

    const resolution = await this.waitForResolution(interaction);
    if (resolution.kind !== 'plan-approval' || !resolution.approved) {
      return {
        behavior: 'deny',
        message:
          resolution.kind === 'plan-approval'
            ? (resolution.feedback ?? 'Plan approval was rejected.')
            : 'Plan approval was resolved with the wrong payload.'
      };
    }

    const previous = this.mode;
    this.setMode(this.prePlanMode);

    return {
      behavior: 'allow',
      updatedInput: {
        ...toolInput,
        __planModeExitedFrom: previous
      }
    };
  }

  private evaluatePlanMode(
    toolName: string,
    toolInput: Record<string, unknown>,
    filePath: string | undefined
  ): PermissionDecision | undefined {
    if (FILE_EDIT_TOOLS.has(toolName) && filePath && isPlanFile(filePath)) {
      return {
        behavior: 'allow',
        updatedInput: toolInput
      };
    }

    return undefined;
  }

  private async requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    reason: PermissionReason
  ): Promise<PermissionDecision> {
    const suggestions = this.buildSuggestions(toolName, toolInput, reason);
    const presentation = buildPermissionPresentation(
      toolName,
      toolInput,
      reason,
      suggestions
    );

    const interaction: PendingPermissionRequest = {
      kind: 'permission',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      toolName,
      toolInput,
      suggestions,
      ...presentation
    };

    const resolution = await this.waitForResolution(interaction);
    if (resolution.kind !== 'permission' || resolution.action === 'reject') {
      return {
        behavior: 'deny',
        message:
          resolution.kind === 'permission'
            ? (resolution.feedback ?? `Permission denied for ${toolName}.`)
            : `Permission denied for ${toolName}.`
      };
    }

    if (resolution.action === 'accept-session') {
      this.applySuggestions(interaction.suggestions, resolution.scopeKey);
    }

    return {
      behavior: 'allow',
      updatedInput: toolInput
    };
  }

  private buildSuggestions(
    toolName: string,
    toolInput: Record<string, unknown>,
    reason: PermissionReason
  ): PermissionSuggestion[] {
    const suggestions: PermissionSuggestion[] = [];

    if (FILE_SYSTEM_TOOLS.has(toolName)) {
      const resolvedPath = getResolvedFilePath(toolInput, this.cwd);
      if (
        resolvedPath &&
        !isWithinWorkspaceOrAllowedDirectories(
          resolvedPath,
          this.cwd,
          this.allowedDirectories
        )
      ) {
        suggestions.push({
          type: 'addDirectories',
          directories: [normalizeSuggestionPath(dirname(resolvedPath))],
          destination: 'session'
        });
      }

      return suggestions;
    }

    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      const rule =
        reason.kind === 'dangerous-command'
          ? buildExactBashRule(toolInput.command)
          : extractSuggestedBashRule(toolInput.command);
      if (rule) {
        suggestions.push({
          type: 'addRules',
          rules: [rule],
          behavior: 'allow',
          destination: 'session'
        });
      }
      return suggestions;
    }

    if (toolName.startsWith('mcp__')) {
      suggestions.push({
        type: 'addRules',
        rules: [toolName],
        behavior: 'allow',
        destination: 'session'
      });

      const parts = toolName.split('__');
      if (parts.length >= 3) {
        suggestions.push({
          type: 'addRules',
          rules: [`mcp__${parts[1]}`],
          behavior: 'allow',
          destination: 'session'
        });
      }
      return suggestions;
    }

    return suggestions;
  }

  private applySuggestions(
    suggestions: PermissionSuggestion[],
    scopeKey?: string
  ): void {
    const selected = scopeKey
      ? suggestions.filter((suggestion) =>
          suggestionMatchesScopeKey(suggestion, scopeKey)
        )
      : suggestions;

    for (const suggestion of selected) {
      switch (suggestion.type) {
        case 'addRules':
          for (const rule of suggestion.rules) {
            this.sessionRules.add(rule);
          }
          break;
        case 'setMode':
          this.setMode(suggestion.mode);
          break;
        case 'addDirectories':
          for (const directory of suggestion.directories) {
            this.allowedDirectories.add(resolve(directory));
          }
          break;
      }
    }
  }

  private isAllowedBySessionScope(
    toolName: string,
    toolInput: Record<string, unknown>,
    filePath: string | undefined
  ): boolean {
    if (this.matchesRule(toolName, toolInput)) {
      return true;
    }

    if (
      FILE_SYSTEM_TOOLS.has(toolName) &&
      filePath &&
      isWithinWorkspaceOrAllowedDirectories(
        filePath,
        this.cwd,
        this.allowedDirectories
      )
    ) {
      const resolvedPath = resolve(filePath);
      for (const directory of this.allowedDirectories) {
        if (isWithinWorkspaceOrAllowedDirectories(resolvedPath, directory, new Set())) {
          return true;
        }
      }
    }

    return false;
  }

  private matchesRule(
    toolName: string,
    toolInput: Record<string, unknown>
  ): boolean {
    for (const rule of this.sessionRules) {
      if (rule === toolName) {
        return true;
      }

      if (
        toolName === 'Bash' &&
        typeof toolInput.command === 'string' &&
        matchBashRule(rule, toolInput.command)
      ) {
        return true;
      }

      if (toolName.startsWith('mcp__') && rule.startsWith('mcp__')) {
        if (rule === toolName || toolName.startsWith(`${rule}__`)) {
          return true;
        }
      }
    }

    return false;
  }

  private buildDefaultReason(
    toolName: string,
    filePath: string | undefined
  ): PermissionReason {
    if (toolName === 'Read' && filePath) {
      return {
        kind: 'read-outside-workspace',
        message: `读取路径 \`${filePath}\` 超出当前工作区默认范围，需要确认。`
      };
    }

    if (FILE_EDIT_TOOLS.has(toolName) && filePath) {
      return {
        kind: 'tool-default',
        message: `修改路径 \`${filePath}\` 不属于默认放行范围，需要确认。`
      };
    }

    if (toolName === 'Bash') {
      return {
        kind: 'tool-default',
        message: '该命令不属于默认放行范围，需要确认。'
      };
    }

    return {
      kind: 'tool-default',
      message: `操作 ${toolName} 不属于默认放行范围，需要确认。`
    };
  }

  private isAllowedByDefault(
    toolName: string,
    toolInput: Record<string, unknown>
  ): boolean {
    if (DEFAULT_ALLOWED_TOOLS.has(toolName)) {
      return true;
    }

    if (toolName === 'Bash') {
      return (
        typeof toolInput.command === 'string' &&
        toolInput.command.trim().length > 0
      );
    }

    return false;
  }

  private waitForResolution(
    interaction: PendingInteraction
  ): Promise<InteractionResolution> {
    return new Promise<InteractionResolution>((resolvePending) => {
      this.onInteraction?.(interaction);
      this.pending.set(interaction.id, resolvePending);
    });
  }

  private setMode(nextMode: PermissionMode): void {
    if (this.mode === nextMode) {
      return;
    }

    const previous = this.mode;
    this.mode = nextMode;
    this.onModeChanged?.(previous, nextMode);
  }
}

function isPlanFile(filePath: string): boolean {
  const plansDir = join(homedir(), '.claude', 'plans');
  const resolved = resolve(filePath);
  return resolved === plansDir || resolved.startsWith(`${plansDir}/`);
}

function buildExactBashRule(command: string): string | undefined {
  const trimmed = command.trim();
  return trimmed ? `Bash(${trimmed})` : undefined;
}

function normalizeSuggestionPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function suggestionMatchesScopeKey(
  suggestion: PermissionSuggestion,
  scopeKey: string
): boolean {
  switch (suggestion.type) {
    case 'addRules':
      return suggestion.rules.some((rule) => scopeKey === `rule:${rule}`);
    case 'addDirectories':
      return suggestion.directories.some(
        (directory) => scopeKey === `dir:${directory}`
      );
    case 'setMode':
      return scopeKey === `mode:${suggestion.mode}`;
  }
}
