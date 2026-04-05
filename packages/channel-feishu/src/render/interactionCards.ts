import type {
  PendingInteraction,
  PermissionScopeOption
} from '@coding-claw/core';

export function buildInteractionCard(
  interaction: PendingInteraction
): Record<string, unknown> {
  switch (interaction.kind) {
    case 'permission':
      return buildPermissionCard(interaction);
    case 'question': {
      if (isStartConfirmationQuestion(interaction)) {
        const question = interaction.questions[0];
        return {
          schema: '2.0',
          header: {
            template: 'blue',
            title: {
              tag: 'plain_text',
              content: '开始确认'
            }
          },
          body: {
            elements: [
              {
                tag: 'form',
                name: `start_confirm_form_${interaction.id}`,
                elements: [
                  {
                    tag: 'markdown',
                    content: `**${question.header || '开始确认'}**\n\n${question.question}`
                  },
                  {
                    tag: 'markdown',
                    content:
                      '点击“开始”立即继续；如果你还有其他要求，直接发送新消息即可。'
                  },
                  formButton('开始', 'start-confirm', interaction.id)
                ]
              }
            ]
          }
        };
      }

      const formElements: Record<string, unknown>[] = [];
      for (const [index, question] of interaction.questions.entries()) {
        const optionLines = question.options.map((option, optionIndex) => {
          const letter = toLetter(optionIndex);
          return option.description
            ? `${letter}. ${option.label} - ${option.description}`
            : `${letter}. ${option.label}`;
        });

        formElements.push({
          tag: 'markdown',
          content: [
            `**${question.header || `问题 ${index + 1}`}**`,
            '',
            question.question,
            optionLines.length > 0 ? '' : undefined,
            optionLines.length > 0 ? optionLines.join('\n') : undefined
          ]
            .filter(Boolean)
            .join('\n')
        });

        if (question.options.length > 0) {
          formElements.push({
            tag: question.multiSelect ? 'multi_select_static' : 'select_static',
            name: `choice_${question.id}`,
            placeholder: {
              tag: 'plain_text',
              content: question.multiSelect
                ? '可多选，也可选择其他'
                : '选择 A / B / C / 其他'
            },
            options: [
              ...question.options.map((option, optionIndex) => ({
                text: {
                  tag: 'plain_text',
                  content: toLetter(optionIndex)
                },
                value: encodeChoiceValue(option.label)
              })),
              {
                text: {
                  tag: 'plain_text',
                  content: '其他'
                },
                value: '__other__'
              }
            ]
          });
          formElements.push({
            tag: 'markdown',
            content: question.multiSelect
              ? '如果勾选了“其他”，请在下方补充；也可以直接填写补充内容。'
              : '如果选择“其他”，请在下方填写：'
          });
        } else {
          formElements.push({
            tag: 'markdown',
            content: '请直接在下方填写答案：'
          });
        }

        formElements.push({
          tag: 'input',
          name: `other_${question.id}`,
          placeholder: {
            tag: 'plain_text',
            content:
              question.options.length > 0
                ? '填写“其他”内容（可留空）'
                : '输入你的回答'
          }
        });
      }
      formElements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '提交' },
        type: 'primary',
        name: `submit_question_${interaction.id}`,
        action_type: 'form_submit',
        value: {
          action: 'submit-question',
          interaction_id: interaction.id
        }
      });
      return {
        schema: '2.0',
        header: {
          template: 'blue',
          title: {
            tag: 'plain_text',
            content: '需要你的回答'
          }
        },
        body: {
          elements: [
            {
              tag: 'form',
              name: `question_form_${interaction.id}`,
              elements: formElements
            }
          ]
        }
      };
    }
    case 'plan-approval':
      return {
        schema: '2.0',
        header: {
          template: 'purple',
          title: {
            tag: 'plain_text',
            content: '计划审批'
          }
        },
        body: {
          elements: [
            {
              tag: 'form',
              name: `plan_approval_form_${interaction.id}`,
              elements: [
                { tag: 'markdown', content: '**计划审批**' },
                {
                  tag: 'markdown',
                  content: interaction.plan || '(empty plan)'
                },
                formButton('批准', 'approve-plan', interaction.id),
                formButton('拒绝', 'reject-plan', interaction.id, 'danger')
              ]
            }
          ]
        }
      };
  }
}

function buildPermissionCard(
  interaction: Extract<PendingInteraction, { kind: 'permission' }>
): Record<string, unknown> {
  const title =
    interaction.actionLabel || getPermissionTitle(interaction.toolName);
  const summary = formatPermissionSummary(
    interaction.toolName,
    interaction.toolInput
  );
  const detail = formatPermissionDetail(
    interaction.toolName,
    interaction.toolInput
  );
  const description =
    typeof interaction.toolInput.description === 'string'
      ? interaction.toolInput.description.trim()
      : '';
  const reason = interaction.reason?.message?.trim();
  const riskLevel = interaction.riskLevel
    ? describeRiskLevel(interaction.riskLevel)
    : '';
  const scopeOptions = interaction.scopeOptions ?? [];
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**准备${title}**`
    },
    {
      tag: 'markdown',
      content: summary
    }
  ];

  if (reason) {
    elements.push({
      tag: 'markdown',
      content: `触发原因: ${reason}`
    });
  }

  if (riskLevel) {
    elements.push({
      tag: 'markdown',
      content: `风险等级: **${riskLevel}**`
    });
  }

  if (description) {
    elements.push({
      tag: 'markdown',
      content: `说明: ${description}`
    });
  }

  elements.push({
    tag: 'markdown',
    content: '请选择允许范围:'
  });

  if (detail) {
    elements.push({
      tag: 'markdown',
      content: detail
    });
  }

  if (scopeOptions.length > 0) {
    elements.push({
      tag: 'markdown',
      content: buildScopeOptionMarkdown(scopeOptions)
    });
  }

  const actions = [
    actionButton('仅本次允许', 'accept-once', interaction.id),
    ...buildPermissionSuggestionButtons(interaction),
    actionButton('拒绝', 'reject', interaction.id, 'danger')
  ];

  elements.push(...actions);

  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '权限申请'
      }
    },
    body: {
      elements
    }
  };
}

function formButton(
  label: string,
  action: string,
  interactionId: string,
  type: 'default' | 'primary' | 'danger' = 'primary'
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    name: `${action}_${interactionId}`,
    action_type: 'form_submit',
    value: {
      action,
      interaction_id: interactionId
    }
  };
}

function actionButton(
  label: string,
  action: string,
  interactionId: string,
  type: 'default' | 'primary' | 'danger' = 'primary',
  extraValue?: Record<string, string>
): Record<string, unknown> {
  const suffix = extraValue ? buildActionNameSuffix(extraValue) : '';
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: label },
    name: `${action}_${interactionId}${suffix}`,
    value: {
      action,
      interaction_id: interactionId,
      ...extraValue
    }
  };
}

function toLetter(index: number): string {
  const code = 'A'.charCodeAt(0) + index;
  return code <= 'Z'.charCodeAt(0)
    ? String.fromCharCode(code)
    : `选项${index + 1}`;
}

function encodeChoiceValue(label: string): string {
  return `choice:${label}`;
}

function getPermissionTitle(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return '执行 Bash 命令';
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
      return '网页搜索';
    default:
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return `调用 MCP 工具 ${parts[1] ?? toolName}`;
      }
      return `调用工具 ${toolName}`;
  }
}

function formatPermissionSummary(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return fencedBlock(truncateText(input.command, 600));
  }

  if (isFileTool(toolName) && typeof input.file_path === 'string') {
    return `路径: \`${input.file_path}\``;
  }

  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return `URL: \`${input.url}\``;
  }

  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `Query: \`${input.query}\``;
  }

  return fencedJson(input);
}

function formatPermissionDetail(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === 'Bash') {
    return '';
  }

  const json = JSON.stringify(input, null, 2);
  if (json === '{}' || json.length === 0) {
    return '';
  }

  if (
    isFileTool(toolName) &&
    typeof input.file_path === 'string' &&
    Object.keys(input).length === 1
  ) {
    return '';
  }

  if (
    (toolName === 'WebFetch' &&
      typeof input.url === 'string' &&
      Object.keys(input).length === 1) ||
    (toolName === 'WebSearch' &&
      typeof input.query === 'string' &&
      Object.keys(input).length === 1)
  ) {
    return '';
  }

  return fencedJson(input, 1200);
}

function buildPermissionSuggestionButtons(
  interaction: Extract<PendingInteraction, { kind: 'permission' }>
): Record<string, unknown>[] {
  const scopeOptions = prioritizeScopeOptions(interaction.scopeOptions ?? []);
  return scopeOptions.map((option) =>
    actionButton(
      option.label,
      'accept-session',
      interaction.id,
      option.kind === 'mode' ? 'primary' : 'default',
      { scope_key: option.key }
    )
  );
}

function isFileTool(toolName: string): boolean {
  return ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(
    toolName
  );
}

function fencedJson(input: Record<string, unknown>, limit = 800): string {
  const json = JSON.stringify(input, null, 2);
  return `\`\`\`json\n${truncateText(json, limit)}\n\`\`\``;
}

function fencedBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function describeRiskLevel(level: 'low' | 'medium' | 'high'): string {
  switch (level) {
    case 'high':
      return '高';
    case 'medium':
      return '中';
    case 'low':
      return '低';
  }
}

function buildScopeOptionMarkdown(options: PermissionScopeOption[]): string {
  const lines = options.map(
    (option) => `- ${option.label}: ${option.description}`
  );
  return `可选范围:\n${lines.join('\n')}`;
}

function prioritizeScopeOptions(
  options: PermissionScopeOption[]
): PermissionScopeOption[] {
  const priority = {
    directory: 0,
    'session-rule': 1,
    mode: 2,
    tool: 3,
    'mcp-server': 4
  } satisfies Record<PermissionScopeOption['kind'], number>;

  return [...options].sort(
    (left, right) => priority[left.kind] - priority[right.kind]
  );
}

function buildActionNameSuffix(extraValue: Record<string, string>): string {
  const raw = Object.entries(extraValue)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}_${value}`)
    .join('_');

  if (!raw) {
    return '';
  }

  const normalized = raw.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `_${shortHash(normalized)}`;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function isStartConfirmationQuestion(
  interaction: Extract<PendingInteraction, { kind: 'question' }>
): boolean {
  if (interaction.questions.length !== 1) {
    return false;
  }

  const question = interaction.questions[0];
  return (
    /确认开始|开始执行|开始实现/.test(question.question) ||
    /确认开始|开始执行|开始实现/.test(question.header)
  );
}
