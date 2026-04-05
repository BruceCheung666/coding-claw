const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\bsudo\b/, description: '命令包含提权操作' },
  { pattern: /\bsu\b/, description: '命令包含提权操作' },
  { pattern: /\beval\b/, description: '命令包含动态执行' },
  { pattern: /\bssh\b/, description: '命令包含远程连接' },
  {
    pattern: /\bcurl\b.*\|\s*(ba)?sh/,
    description: '命令通过管道执行远程脚本'
  },
  {
    pattern: /\bwget\b.*\|\s*(ba)?sh/,
    description: '命令通过管道执行远程脚本'
  },
  {
    pattern: /\brm\b(?:\s+-[^\n]*[rf][^\n]*)?\s+/,
    description: '命令包含删除操作'
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*\s+)\/(?!\w)/,
    description: '命令可能删除根目录'
  },
  { pattern: /\bgit\s+clean\b[^\n]*\s-f/, description: '命令会删除未跟踪文件' },
  { pattern: /\bmkfs\b/, description: '命令可能破坏文件系统' },
  { pattern: /\bdd\b/, description: '命令可能写入设备' },
  { pattern: /\bshutdown\b/, description: '命令会影响系统状态' },
  { pattern: /\breboot\b/, description: '命令会影响系统状态' },
  { pattern: /\bkillall\b/, description: '命令会影响其他进程' },
  { pattern: /\bkill\s+-9\b/, description: '命令会强制终止进程' }
];

const READ_ONLY_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'whoami',
  'hostname',
  'uname',
  'date',
  'uptime',
  'which',
  'echo',
  'printf',
  'grep',
  'rg',
  'ag',
  'ack',
  'find',
  'fd',
  'tree',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git rev-parse',
  'git describe',
  'git tag -l',
  'git stash list',
  'npm list',
  'npm ls',
  'npm view',
  'npm info',
  'npm outdated',
  'yarn list',
  'yarn info',
  'yarn why',
  'cargo check',
  'cargo test --no-run',
  'go vet',
  'go list',
  'node --version',
  'npm --version',
  'python --version',
  'python3 --version',
  'env',
  'printenv',
  'type',
  'command -v',
  'jq',
  'yq',
  'diff',
  'cmp',
  'md5sum',
  'sha256sum',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed -n',
  'awk',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'id',
  'free',
  'nproc',
  'groups',
  'locale',
  'paste',
  'column',
  'tac',
  'rev',
  'fold',
  'expand',
  'unexpand',
  'fmt',
  'comm',
  'numfmt',
  'nl',
  'strings',
  'hexdump',
  'od',
  'docker ps',
  'docker images',
  'docker inspect',
  'docker logs',
  'true',
  'false',
  'test',
  'seq',
  'sleep',
  'cal',
  'expr',
  'getconf'
];

const TWO_TOKEN_PREFIX_COMMANDS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'cargo',
  'docker',
  'go',
  'python',
  'python3',
  'bun',
  'deno'
]);

export type BashRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string };

export function findDangerousCommandReason(
  command: string
): string | undefined {
  const trimmed = command.trim();
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return description;
    }
  }
  return undefined;
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return true;
  }

  if (trimmed.includes('|')) {
    return splitCompoundCommand(trimmed, '|').every((part) =>
      isReadOnlyCommand(part)
    );
  }

  if (trimmed.includes('&&') || trimmed.includes(';')) {
    return splitCompoundCommand(trimmed).every((part) =>
      isReadOnlyCommand(part)
    );
  }

  return READ_ONLY_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(`${prefix} `) ||
      trimmed.startsWith(`${prefix}\t`)
  );
}

export function splitCompoundCommand(
  command: string,
  delimiterPattern: RegExp | string = /&&|;/
): string[] {
  return command
    .split(delimiterPattern)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractCommandSubcommands(command: string): string[] {
  return command
    .split(/&&|;|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function extractSuggestedBashRule(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  const first = extractCommandSubcommands(trimmed)[0] ?? trimmed;
  const tokens = first.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  if (
    tokens.length >= 2 &&
    TWO_TOKEN_PREFIX_COMMANDS.has(tokens[0]!) &&
    looksLikeSubcommand(tokens[1]!)
  ) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }

  return `Bash(${tokens[0]}:*)`;
}

export function matchBashRule(rule: string, command: string): boolean {
  if (!rule.startsWith('Bash(') || !rule.endsWith(')')) {
    return false;
  }

  const parsed = parseBashRule(rule.slice(5, -1));
  const subcommands = extractCommandSubcommands(command);
  if (subcommands.length === 0) {
    return false;
  }

  return subcommands.every((subcommand) =>
    matchSingleBashRule(parsed, subcommand)
  );
}

function parseBashRule(raw: string): BashRule {
  if (raw.endsWith(':*')) {
    return {
      type: 'prefix',
      prefix: raw.slice(0, -2)
    };
  }

  if (raw.includes('*')) {
    return {
      type: 'wildcard',
      pattern: raw
    };
  }

  return {
    type: 'exact',
    command: raw
  };
}

function matchSingleBashRule(rule: BashRule, command: string): boolean {
  const trimmed = command.trim();
  switch (rule.type) {
    case 'exact':
      return trimmed === rule.command;
    case 'prefix':
      return trimmed === rule.prefix || trimmed.startsWith(`${rule.prefix} `);
    case 'wildcard':
      return wildcardToRegExp(rule.pattern).test(trimmed);
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 's');
}

function looksLikeSubcommand(token: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/i.test(token);
}
