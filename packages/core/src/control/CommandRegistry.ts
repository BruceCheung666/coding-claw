export type CommandId =
  | 'agent.mode'
  | 'agent.model'
  | 'agent.status'
  | 'reset'
  | 'shell.exec'
  | 'shell.status'
  | 'chat.status'
  | 'help';

export interface CommandDefinition {
  id: CommandId;
  canonicalTokens: string[];
  aliases: string[];
  description: string;
  usage: string;
}

export interface CommandMatch {
  id: CommandId;
  argsText: string;
  matchedText: string;
  aliasUsed?: string;
}

export type ParsedInboundText =
  | {
      kind: 'runtime';
      text: string;
    }
  | {
      kind: 'command';
      match: CommandMatch;
    }
  | {
      kind: 'unknown-command';
      commandName: string;
    };

export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    id: 'agent.mode',
    canonicalTokens: ['agent', 'mode'],
    aliases: [],
    description: '查看或切换 Agent 权限模式。',
    usage: '/agent mode [default|acceptEdits|bypassPermissions|plan|dontAsk]'
  },
  {
    id: 'agent.model',
    canonicalTokens: ['agent', 'model'],
    aliases: [],
    description: '查看或切换 Agent 模型。',
    usage: '/agent model [model-name]'
  },
  {
    id: 'agent.status',
    canonicalTokens: ['agent', 'status'],
    aliases: ['as'],
    description: '查看 Agent 会话状态。',
    usage: '/agent status | /as'
  },
  {
    id: 'reset',
    canonicalTokens: ['reset'],
    aliases: [],
    description: '重置 Agent 和 Shell，并重新选择工作区目录。',
    usage: '/reset'
  },
  {
    id: 'shell.exec',
    canonicalTokens: ['shell', 'exec'],
    aliases: ['sx'],
    description: '在当前 cwd 执行一条 shell 命令。',
    usage: '/shell exec <command> | /sx <command>'
  },
  {
    id: 'shell.status',
    canonicalTokens: ['shell', 'status'],
    aliases: ['ss'],
    description: '查看 shell session 状态。',
    usage: '/shell status | /ss'
  },
  {
    id: 'chat.status',
    canonicalTokens: ['chat', 'status'],
    aliases: ['cs'],
    description: '查看 chat 级控制状态。',
    usage: '/chat status | /cs'
  },
  {
    id: 'help',
    canonicalTokens: ['help'],
    aliases: ['h'],
    description: '查看 bridge 命令帮助。',
    usage: '/help | /h'
  }
];

interface TokenWithIndex {
  token: string;
  index: number;
}

export function parseInboundText(text: string): ParsedInboundText {
  if (!text.startsWith('/')) {
    return {
      kind: 'runtime',
      text
    };
  }

  if (text.startsWith('//')) {
    return {
      kind: 'runtime',
      text: text.slice(1)
    };
  }

  const body = text.slice(1).trim();
  if (!body) {
    return {
      kind: 'unknown-command',
      commandName: ''
    };
  }

  const tokens = tokenize(body);
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    if (tokens.length < candidate.tokens.length) {
      continue;
    }

    const matches = candidate.tokens.every(
      (token, index) => tokens[index]!.token.toLowerCase() === token
    );
    if (!matches) {
      continue;
    }

    const lastToken = tokens[candidate.tokens.length - 1]!;
    const consumedEnd = lastToken.index + lastToken.token.length;
    return {
      kind: 'command',
      match: {
        id: candidate.definition.id,
        matchedText: candidate.displayText,
        aliasUsed: candidate.aliasUsed,
        argsText: body.slice(consumedEnd).trimStart()
      }
    };
  }

  return {
    kind: 'unknown-command',
    commandName: tokens[0]?.token.toLowerCase() ?? body.toLowerCase()
  };
}

interface CommandCandidate {
  definition: CommandDefinition;
  tokens: string[];
  displayText: string;
  aliasUsed?: string;
}

function buildCandidates(): CommandCandidate[] {
  return COMMAND_REGISTRY.flatMap((definition) => [
    {
      definition,
      tokens: definition.canonicalTokens,
      displayText: `/${definition.canonicalTokens.join(' ')}`
    },
    ...definition.aliases.map((alias) => ({
      definition,
      tokens: [alias],
      displayText: `/${alias}`,
      aliasUsed: alias
    }))
  ]).sort((left, right) => right.tokens.length - left.tokens.length);
}

function tokenize(body: string): TokenWithIndex[] {
  return [...body.matchAll(/\S+/g)].map((match) => ({
    token: match[0],
    index: match.index ?? 0
  }));
}
