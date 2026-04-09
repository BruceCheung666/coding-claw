export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk';

export const FEISHU_CHAT_ANNOUNCEMENT_METADATA_KEY = 'feishu.chatAnnouncement';
export const FEISHU_CHAT_ANNOUNCEMENT_UPDATED_AT_METADATA_KEY =
  'feishu.chatAnnouncementUpdatedAt';

export type SessionMetadataPatch = Record<string, string | undefined>;

export interface SessionContextProvider {
  getSessionMetadata(chatId: string): Promise<SessionMetadataPatch>;
}

export type RuntimeUserMessagePriority = 'now' | 'next' | 'later';

export type InteractionKind = 'permission' | 'question' | 'plan-approval';

export type TurnCompletionStatus = 'completed' | 'error' | 'aborted';

export interface WorkspaceBinding {
  chatId: string;
  workspaceId: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  runtime: 'claude';
  channel: 'feishu';
  sessionId?: string;
  model?: string;
  mode: PermissionMode;
  metadata: Record<string, string>;
}

export interface ChatControlState {
  chatId: string;
  inputMode: 'agent';
  cwd: string;
  shellSessionId?: string;
  shellStatus: 'inactive' | 'ready' | 'running';
  lastAgentResetAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionRef {
  chatId: string;
  workspaceId: string;
  sessionId?: string;
}

export interface PendingPermissionRequest {
  kind: 'permission';
  id: string;
  createdAt: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  actionLabel?: string;
  reason?: PermissionReason;
  riskLevel?: PermissionRiskLevel;
  targets?: PermissionTarget[];
  scopeOptions?: PermissionScopeOption[];
  suggestions: PermissionSuggestion[];
}

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

export type PermissionReasonKind =
  | 'outside-workspace'
  | 'sensitive-path'
  | 'dangerous-command'
  | 'plan-mode'
  | 'tool-default'
  | 'read-outside-workspace';

export interface PermissionReason {
  kind: PermissionReasonKind;
  message: string;
}

export interface PermissionTarget {
  type:
    | 'path'
    | 'directory'
    | 'command'
    | 'url'
    | 'query'
    | 'tool'
    | 'mcp-server';
  value: string;
}

export interface PermissionScopeOption {
  key: string;
  kind: 'session-rule' | 'directory' | 'mode' | 'tool' | 'mcp-server';
  label: string;
  description: string;
}

export type PermissionSuggestion =
  | {
      type: 'addRules';
      rules: string[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: 'session' | 'local';
    }
  | {
      type: 'setMode';
      mode: PermissionMode;
      destination: 'session' | 'local';
    }
  | {
      type: 'addDirectories';
      directories: string[];
      destination: 'session' | 'local';
    };

export interface ChoiceOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: ChoiceOption[];
  multiSelect?: boolean;
}

export interface PendingQuestionRequest {
  kind: 'question';
  id: string;
  createdAt: string;
  questions: QuestionPrompt[];
}

export interface PendingPlanApprovalRequest {
  kind: 'plan-approval';
  id: string;
  createdAt: string;
  plan: string;
  filePath?: string;
}

export type PendingInteraction =
  | PendingPermissionRequest
  | PendingQuestionRequest
  | PendingPlanApprovalRequest;

export type InteractionResolution =
  | {
      kind: 'permission';
      action: 'accept-once' | 'accept-session' | 'reject';
      scopeKey?: string;
      feedback?: string;
    }
  | { kind: 'question'; answers: Record<string, string | string[]> }
  | { kind: 'plan-approval'; approved: boolean; feedback?: string };

export interface AgentSummary {
  taskId: string;
  name: string;
  agentType: string;
  description?: string;
  summary?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
}

export interface TaskSummary {
  id: string;
  subject: string;
  owner?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolCallSummary {
  id: string;
  name: string;
  status: 'started' | 'completed' | 'failed';
  input?: Record<string, unknown>;
  outputText?: string;
}

export type RenderSection =
  | {
      id: string;
      kind: 'user-prompt';
      prompt: string;
    }
  | {
      id: string;
      kind: 'assistant-text';
      text: string;
    }
  | {
      id: string;
      kind: 'tool-group';
      summary: string;
      state: 'active' | 'completed';
    }
  | {
      id: string;
      kind: 'tool-summary';
      summary: string;
    }
  | {
      id: string;
      kind: 'tasks';
      tasks: TaskSummary[];
    }
  | {
      id: string;
      kind: 'agents';
      agents: AgentSummary[];
    }
  | {
      id: string;
      kind: 'agent-note';
      agentName: string;
      summary: string;
      status: AgentSummary['status'];
    };

export interface ActiveToolGroupState {
  sectionId: string;
  searchCount: number;
  readCount: number;
  readTargets: string[];
  listCount: number;
}

export type BridgeEvent =
  | {
      type: 'turn.started';
      chatId: string;
      turnId: string;
      prompt: string;
      startedAt: string;
    }
  | {
      type: 'turn.text.delta';
      chatId: string;
      turnId: string;
      textDelta: string;
      accumulatedText: string;
    }
  | {
      type: 'turn.tool.started';
      chatId: string;
      turnId: string;
      tool: ToolCallSummary;
    }
  | {
      type: 'turn.tool.summary';
      chatId: string;
      turnId: string;
      summary: string;
    }
  | {
      type: 'turn.agent.updated';
      chatId: string;
      turnId: string;
      agents: AgentSummary[];
    }
  | {
      type: 'turn.tasks.updated';
      chatId: string;
      turnId: string;
      tasks: TaskSummary[];
    }
  | {
      type: 'session.mode.changed';
      chatId: string;
      turnId: string;
      from: PermissionMode;
      to: PermissionMode;
    }
  | {
      type: 'interaction.requested';
      chatId: string;
      turnId: string;
      interaction: PendingInteraction;
    }
  | {
      type: 'interaction.resolved';
      chatId: string;
      turnId: string;
      interactionId: string;
      resolution: InteractionResolution;
    }
  | {
      type: 'turn.completed';
      chatId: string;
      turnId: string;
      status: TurnCompletionStatus;
      finalText: string;
      sessionId?: string;
      finishedAt: string;
    }
  | {
      type: 'runtime.raw';
      chatId: string;
      turnId: string;
      payload: unknown;
    };

export interface TranscriptEntry {
  chatId: string;
  turnId: string;
  event: BridgeEvent;
  createdAt: string;
}

export interface InboundChatMessage {
  channel: 'feishu';
  chatId: string;
  messageId: string;
  text: string;
  mentions?: string[];
}

export interface AgentModeControlOption {
  mode: PermissionMode;
  label: string;
  description: string;
}

export interface AgentModelControlOption {
  model: string;
  label: string;
  description: string;
}

export interface ResetWorkspaceControlOption {
  defaultWorkspacePath: string;
  currentWorkspacePath: string;
  currentCwd: string;
}

export type ControlResponse =
  | {
      format: 'text';
      text: string;
    }
  | {
      format: 'agent-mode-picker';
      currentMode: PermissionMode;
      options: AgentModeControlOption[];
    }
  | {
      format: 'agent-model-picker';
      currentModel: string;
      options: AgentModelControlOption[];
    }
  | {
      format: 'reset-workspace-picker';
      options: ResetWorkspaceControlOption;
    };

export type InboundDispatchResult =
  | {
      kind: 'runtime';
      message: InboundChatMessage;
    }
  | {
      kind: 'control';
      response: ControlResponse;
    };

export interface ShellExecutionInput {
  chatId: string;
  workspacePath: string;
  cwd: string;
  command: string;
}

export interface ShellExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  gitBranch?: string | null;
  sessionId?: string;
}

export interface ShellSessionSnapshot {
  active: boolean;
  running: boolean;
  sessionId?: string;
  pid?: number;
}

export interface RenderModel {
  turnId: string;
  title: string;
  prompt: string;
  body: string;
  loading: boolean;
  agents: AgentSummary[];
  tasks: TaskSummary[];
  toolSummary?: string;
  sections: RenderSection[];
  nextSectionOrdinal: number;
  activeToolGroup?: ActiveToolGroupState;
}
