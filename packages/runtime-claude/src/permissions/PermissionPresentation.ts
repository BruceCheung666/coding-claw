import { dirname } from 'node:path';
import type {
  PendingPermissionRequest,
  PermissionReason,
  PermissionRiskLevel,
  PermissionScopeOption,
  PermissionSuggestion,
  PermissionTarget
} from '@coding-claw/core';

export function buildPermissionPresentation(
  toolName: string,
  toolInput: Record<string, unknown>,
  reason: PermissionReason | undefined,
  suggestions: PermissionSuggestion[]
): Pick<
  PendingPermissionRequest,
  'actionLabel' | 'riskLevel' | 'targets' | 'scopeOptions' | 'reason'
> {
  return {
    actionLabel: buildActionLabel(toolName),
    reason: reason ?? {
      kind: 'tool-default',
      message: `当前操作不属于默认放行范围，需要确认 ${buildActionLabel(toolName)}。`
    },
    riskLevel: determineRiskLevel(toolName, reason),
    targets: buildTargets(toolName, toolInput),
    scopeOptions: buildScopeOptions(toolName, suggestions)
  };
}

function buildActionLabel(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return '执行命令';
    case 'Write':
      return '写入文件';
    case 'Edit':
    case 'MultiEdit':
      return '修改文件';
    case 'Read':
      return '读取文件';
    case 'NotebookEdit':
      return '修改 Notebook';
    case 'TodoWrite':
      return '更新任务清单';
    case 'WebFetch':
      return '抓取网页';
    case 'WebSearch':
      return '执行网页搜索';
    default:
      if (toolName.startsWith('mcp__')) {
        return '调用 MCP 工具';
      }
      return `调用工具 ${toolName}`;
  }
}

function determineRiskLevel(
  toolName: string,
  reason: PermissionReason | undefined
): PermissionRiskLevel {
  if (
    reason?.kind === 'dangerous-command' ||
    reason?.kind === 'sensitive-path'
  ) {
    return 'high';
  }

  if (
    reason?.kind === 'outside-workspace' ||
    reason?.kind === 'plan-mode' ||
    reason?.kind === 'read-outside-workspace'
  ) {
    return 'medium';
  }

  if (
    toolName === 'Bash' ||
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    return 'medium';
  }

  return 'low';
}

function buildTargets(
  toolName: string,
  toolInput: Record<string, unknown>
): PermissionTarget[] {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return [{ type: 'command', value: toolInput.command }];
  }

  if (typeof toolInput.file_path === 'string') {
    return [{ type: 'path', value: toolInput.file_path }];
  }

  if (typeof toolInput.url === 'string') {
    return [{ type: 'url', value: toolInput.url }];
  }

  if (typeof toolInput.query === 'string') {
    return [{ type: 'query', value: toolInput.query }];
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts[1]) {
      return [{ type: 'mcp-server', value: parts[1] }];
    }
  }

  return [{ type: 'tool', value: toolName }];
}

function buildScopeOptions(
  toolName: string,
  suggestions: PermissionSuggestion[]
): PermissionScopeOption[] {
  const options: PermissionScopeOption[] = [];

  for (const suggestion of suggestions) {
    switch (suggestion.type) {
      case 'addRules':
        for (const rule of suggestion.rules) {
          if (rule.startsWith('Bash(') && rule.endsWith(')')) {
            const raw = rule.slice(5, -1);
            const isPattern = raw.includes('*');
            options.push({
              key: `rule:${rule}`,
              kind: 'session-rule',
              label: isPattern
                ? `当前会话内允许 ${raw}`
                : '当前会话内允许该命令',
              description: isPattern
                ? '记住当前命令范围，后续命中同类命令时不再重复询问。'
                : '仅在当前会话内记住这条命令，后续相同命令可直接通过。'
            });
            continue;
          }

          if (rule.startsWith('mcp__')) {
            const server = rule.replace(/^mcp__/, '');
            options.push({
              key: `rule:${rule}`,
              kind: rule.includes('__') ? 'tool' : 'mcp-server',
              label: rule.includes('__')
                ? '当前会话内允许当前 MCP 工具'
                : `当前会话内允许 ${server} 服务`,
              description: '后续命中同一 MCP 范围的调用将直接通过。'
            });
            continue;
          }

          options.push({
            key: `rule:${rule}`,
            kind: 'tool',
            label: `当前会话内允许 ${toolName}`,
            description:
              '仅在当前会话内记住该工具范围，后续相同调用将直接通过。'
          });
        }
        break;
      case 'addDirectories':
        for (const directory of suggestion.directories) {
          const name =
            dirname(directory) === directory
              ? directory
              : (directory.split('/').filter(Boolean).at(-1) ?? directory);
          options.push({
            key: `dir:${directory}`,
            kind: 'directory',
            label: `当前会话内允许访问 ${name}/`,
            description:
              '把该目录加入当前会话允许范围，后续访问同目录不再重复询问。'
          });
        }
        break;
      case 'setMode':
        options.push({
          key: `mode:${suggestion.mode}`,
          kind: 'mode',
          label: `切换到 ${suggestion.mode}`,
          description: '更新当前会话的权限模式，后续按新模式处理。'
        });
        break;
    }
  }

  return dedupeScopeOptions(options);
}

function dedupeScopeOptions(
  options: PermissionScopeOption[]
): PermissionScopeOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.key}:${option.kind}:${option.label}:${option.description}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
