import type {
  ActiveToolGroupState,
  AgentSummary,
  BridgeEvent,
  RenderModel,
  RenderSection,
  TaskSummary,
  ToolCallSummary
} from '../types.js';

type ToolCategory = 'search' | 'read' | 'list' | 'other' | 'agent';

const READ_COMMANDS =
  /^(?:cat|head|tail|less|more|wc|file|stat|readlink|realpath|md5sum|sha\d+sum)\b/;
const SEARCH_COMMANDS =
  /^(?:grep|egrep|fgrep|rg|ag|ack|find|fd|locate|which|whereis|type)\b/;
const LIST_COMMANDS = /^(?:ls|tree|du|df|dir)\b/;
const TASK_SECTION_ID = 'tasks';
const AGENT_SECTION_ID = 'agents';

export function createInitialRenderModel(
  turnId: string,
  prompt: string
): RenderModel {
  return {
    turnId,
    title: 'Claude',
    prompt,
    body: '',
    loading: true,
    agents: [],
    tasks: [],
    sections: [
      {
        id: 'user',
        kind: 'user-prompt',
        prompt
      }
    ],
    nextSectionOrdinal: 1
  };
}

export function reduceRenderModel(
  model: RenderModel,
  event: BridgeEvent
): RenderModel {
  switch (event.type) {
    case 'turn.text.delta':
      return applyTextDelta(model, event.textDelta, event.accumulatedText);
    case 'turn.tool.started':
      return applyToolStarted(model, event.tool);
    case 'turn.tool.summary':
      return applyToolSummary(model, event.summary);
    case 'turn.agent.updated':
      return applyAgentsUpdated(model, event.agents);
    case 'turn.tasks.updated':
      return applyTasksUpdated(model, event.tasks);
    case 'turn.completed':
      return applyTurnCompleted(model, event.finalText);
    default:
      return model;
  }
}

function applyTextDelta(
  model: RenderModel,
  textDelta: string,
  accumulatedText: string
): RenderModel {
  const finalized = finalizeActiveToolGroup(model);
  const text = textDelta || '';

  if (!text) {
    return {
      ...finalized,
      body: accumulatedText || finalized.body
    };
  }

  const sections = [...finalized.sections];
  const lastSection = sections.at(-1);
  if (lastSection?.kind === 'assistant-text') {
    sections[sections.length - 1] = {
      ...lastSection,
      text: `${lastSection.text}${text}`
    };
  } else {
    sections.push({
      id: createSectionId(finalized, 'text'),
      kind: 'assistant-text',
      text
    });
  }

  return {
    ...finalized,
    body: accumulatedText || finalized.body,
    sections,
    nextSectionOrdinal:
      finalized.nextSectionOrdinal +
      (lastSection?.kind === 'assistant-text' ? 0 : 1)
  };
}

function applyToolStarted(
  model: RenderModel,
  tool: ToolCallSummary
): RenderModel {
  const category = classifyTool(tool.name, tool.input ?? {});

  if (category === 'agent') {
    return model;
  }

  if (category === 'other') {
    return finalizeActiveToolGroup(model);
  }

  const activeToolGroup = model.activeToolGroup
    ? cloneActiveToolGroup(model.activeToolGroup)
    : ({
        sectionId: createSectionId(model, 'tool'),
        searchCount: 0,
        readCount: 0,
        readTargets: [],
        listCount: 0
      } satisfies ActiveToolGroupState);

  if (category === 'search') {
    activeToolGroup.searchCount += 1;
  } else if (category === 'read') {
    activeToolGroup.readCount += 1;
    collectReadTarget(activeToolGroup, tool);
  } else if (category === 'list') {
    activeToolGroup.listCount += 1;
  }

  const summary = buildToolGroupSummary(activeToolGroup, true);
  const sections = upsertSection(model.sections, {
    id: activeToolGroup.sectionId,
    kind: 'tool-group',
    summary,
    state: 'active'
  });

  return {
    ...model,
    sections,
    toolSummary: summary,
    activeToolGroup,
    nextSectionOrdinal: model.activeToolGroup
      ? model.nextSectionOrdinal
      : model.nextSectionOrdinal + 1
  };
}

function applyToolSummary(model: RenderModel, summary: string): RenderModel {
  const trimmed = summary.trim();
  if (!trimmed) {
    return model;
  }

  if (model.activeToolGroup) {
    return {
      ...model,
      toolSummary: buildToolGroupSummary(model.activeToolGroup, true)
    };
  }

  const sections = [...model.sections];
  const lastSection = sections.at(-1);
  if (lastSection?.kind === 'tool-summary' && lastSection.summary === trimmed) {
    return {
      ...model,
      toolSummary: trimmed
    };
  }

  sections.push({
    id: createSectionId(model, 'summary'),
    kind: 'tool-summary',
    summary: trimmed
  });

  return {
    ...model,
    sections,
    toolSummary: trimmed,
    nextSectionOrdinal: model.nextSectionOrdinal + 1
  };
}

function applyAgentsUpdated(
  model: RenderModel,
  agents: AgentSummary[]
): RenderModel {
  let nextModel = {
    ...model,
    agents
  };

  nextModel =
    agents.length > 0
      ? {
          ...nextModel,
          sections: upsertSection(nextModel.sections, {
            id: AGENT_SECTION_ID,
            kind: 'agents',
            agents
          })
        }
      : {
          ...nextModel,
          sections: removeSection(nextModel.sections, AGENT_SECTION_ID)
        };

  const notifications = collectAgentNotifications(model.agents, agents);
  if (notifications.length === 0) {
    return nextModel;
  }

  return {
    ...nextModel,
    sections: [
      ...nextModel.sections,
      ...notifications.map(
        (notification, index) =>
          ({
            id: `${createSectionId(nextModel, 'agent-note')}-${index + 1}`,
            kind: 'agent-note',
            agentName: notification.name,
            summary: notification.summary,
            status: notification.status
          }) satisfies RenderSection
      )
    ],
    nextSectionOrdinal: nextModel.nextSectionOrdinal + 1
  };
}

function applyTasksUpdated(
  model: RenderModel,
  tasks: TaskSummary[]
): RenderModel {
  return {
    ...model,
    tasks,
    sections:
      tasks.length > 0
        ? upsertSection(model.sections, {
            id: TASK_SECTION_ID,
            kind: 'tasks',
            tasks
          })
        : removeSection(model.sections, TASK_SECTION_ID)
  };
}

function applyTurnCompleted(
  model: RenderModel,
  finalText: string
): RenderModel {
  let nextModel = finalizeActiveToolGroup(model);
  const resolvedFinalText = finalText || nextModel.body;

  if (!nextModel.body && resolvedFinalText) {
    nextModel = applyTextDelta(nextModel, resolvedFinalText, resolvedFinalText);
  }

  return {
    ...nextModel,
    body: resolvedFinalText,
    loading: false
  };
}

function finalizeActiveToolGroup(model: RenderModel): RenderModel {
  if (!model.activeToolGroup) {
    return model;
  }

  const summary = buildToolGroupSummary(model.activeToolGroup, false);
  return {
    ...model,
    sections: upsertSection(model.sections, {
      id: model.activeToolGroup.sectionId,
      kind: 'tool-group',
      summary,
      state: 'completed'
    }),
    toolSummary: summary,
    activeToolGroup: undefined
  };
}

function createSectionId(model: RenderModel, prefix: string): string {
  return `${prefix}-${model.nextSectionOrdinal}`;
}

function cloneActiveToolGroup(
  group: ActiveToolGroupState
): ActiveToolGroupState {
  return {
    ...group,
    readTargets: [...group.readTargets]
  };
}

function upsertSection<T extends RenderSection>(
  sections: RenderSection[],
  section: T
): RenderSection[] {
  const index = sections.findIndex((candidate) => candidate.id === section.id);
  if (index === -1) {
    return [...sections, section];
  }

  const next = [...sections];
  next[index] = section;
  return next;
}

function removeSection(
  sections: RenderSection[],
  sectionId: string
): RenderSection[] {
  return sections.filter((section) => section.id !== sectionId);
}

function classifyTool(
  toolName: string,
  toolInput: Record<string, unknown>
): ToolCategory {
  if (toolName === 'Agent') {
    return 'agent';
  }

  switch (toolName) {
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return 'search';
    case 'Read':
    case 'WebFetch':
      return 'read';
    case 'Bash':
      return classifyBashCommand(String(toolInput.command ?? ''));
    default:
      return 'other';
  }
}

function classifyBashCommand(command: string): ToolCategory {
  const trimmed = command
    .trimStart()
    .replace(/^(?:sudo\s+|env\s+\S+=\S+\s+)*/, '');
  if (SEARCH_COMMANDS.test(trimmed)) {
    return 'search';
  }
  if (READ_COMMANDS.test(trimmed)) {
    return 'read';
  }
  if (LIST_COMMANDS.test(trimmed)) {
    return 'list';
  }
  return 'other';
}

function collectReadTarget(
  group: ActiveToolGroupState,
  tool: ToolCallSummary
): void {
  const target =
    tool.name === 'Read'
      ? tool.input?.file_path
      : tool.name === 'WebFetch'
        ? tool.input?.url
        : undefined;

  if (typeof target !== 'string' || !target) {
    return;
  }

  if (!group.readTargets.includes(target)) {
    group.readTargets.push(target);
  }
}

function buildToolGroupSummary(
  group: ActiveToolGroupState,
  active: boolean
): string {
  const parts: string[] = [];

  if (group.searchCount > 0) {
    parts.push(
      `${active ? 'Searching' : 'Searched'} for ${group.searchCount} ${pluralize(group.searchCount, 'pattern')}`
    );
  }

  const readCount = group.readTargets.length || group.readCount;
  if (readCount > 0) {
    const prefix =
      parts.length === 0
        ? active
          ? 'Reading'
          : 'Read'
        : active
          ? 'reading'
          : 'read';
    parts.push(`${prefix} ${readCount} ${pluralize(readCount, 'file')}`);
  }

  if (group.listCount > 0) {
    const prefix =
      parts.length === 0
        ? active
          ? 'Listing'
          : 'Listed'
        : active
          ? 'listing'
          : 'listed';
    parts.push(
      `${prefix} ${group.listCount} ${pluralize(group.listCount, 'directory', 'directories')}`
    );
  }

  const summary = parts.join(', ');
  return active ? `${summary}...` : summary;
}

function pluralize(
  value: number,
  singular: string,
  plural = `${singular}s`
): string {
  return value === 1 ? singular : plural;
}

function collectAgentNotifications(
  previous: AgentSummary[],
  current: AgentSummary[]
): Array<AgentSummary & { summary: string }> {
  const previousById = new Map(previous.map((agent) => [agent.taskId, agent]));
  const notifications: Array<AgentSummary & { summary: string }> = [];

  for (const agent of current) {
    const before = previousById.get(agent.taskId);
    const wasRunning = before?.status === 'running';
    const isDone = agent.status !== 'running';
    if (
      wasRunning &&
      isDone &&
      typeof agent.summary === 'string' &&
      agent.summary.length > 0
    ) {
      notifications.push({
        ...agent,
        summary: agent.summary
      });
    }
  }

  return notifications;
}
