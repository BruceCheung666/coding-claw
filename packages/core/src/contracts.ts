import type {
  BridgeEvent,
  ChatControlState,
  InboundChatMessage,
  InteractionResolution,
  PendingInteraction,
  RenderModel,
  RuntimeUserMessagePriority,
  RuntimeSessionRef,
  ShellExecutionInput,
  ShellExecutionResult,
  ShellSessionSnapshot,
  WorkspaceBinding
} from './types.js';

export interface RuntimeTurnInput {
  chatId: string;
  turnId: string;
  prompt: string;
  binding: WorkspaceBinding;
}

export interface RuntimeApiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface RuntimeContextUsage {
  totalTokens?: number;
  maxTokens?: number;
  percentage?: number;
  apiUsage?: RuntimeApiUsage;
}

export interface RuntimeSessionStatus {
  state: 'not-started' | 'idle' | 'running';
  sessionId?: string;
  supportsContextUsage: boolean;
  contextUsage?: RuntimeContextUsage;
}

export interface RuntimeSession {
  readonly ref: RuntimeSessionRef;
  readonly busy: boolean;
  getStatus(): Promise<RuntimeSessionStatus>;
  runTurn(input: RuntimeTurnInput): AsyncIterable<BridgeEvent>;
  injectUserMessage(
    text: string,
    priority?: RuntimeUserMessagePriority
  ): Promise<void>;
  resolveInteraction(
    interactionId: string,
    resolution: InteractionResolution
  ): void;
  abort(): void;
}

export interface AgentRuntime {
  getOrCreateSession(binding: WorkspaceBinding): Promise<RuntimeSession>;
  dropSession(chatId: string): Promise<void>;
}

export interface TranscriptStore {
  append(event: BridgeEvent): Promise<void>;
  listByChat(chatId: string): Promise<BridgeEvent[]>;
  clearChat(chatId: string): Promise<void>;
}

export interface WorkspaceBindingStore {
  get(chatId: string): Promise<WorkspaceBinding | undefined>;
  upsert(binding: WorkspaceBinding): Promise<WorkspaceBinding>;
}

export interface ChatControlStateStore {
  get(chatId: string): Promise<ChatControlState | undefined>;
  upsert(state: ChatControlState): Promise<ChatControlState>;
}

export interface ApprovalStore {
  create(
    chatId: string,
    turnId: string,
    interaction: PendingInteraction
  ): Promise<void>;
  get(
    chatId: string,
    interactionId: string
  ): Promise<PendingInteraction | undefined>;
  lookup(
    interactionId: string
  ): Promise<
    | { chatId: string; turnId: string; interaction: PendingInteraction }
    | undefined
  >;
  listPending(chatId: string): Promise<PendingInteraction[]>;
  resolve(
    chatId: string,
    interactionId: string,
    resolution: InteractionResolution
  ): Promise<void>;
  clearChat(chatId: string): Promise<void>;
}

export interface ShellExecutor {
  execute(input: ShellExecutionInput): Promise<ShellExecutionResult>;
  reset(chatId: string): Promise<void>;
  getStatus(chatId: string): Promise<ShellSessionSnapshot>;
}

export interface RenderSurface {
  startTurn(message: InboundChatMessage, turnId: string): Promise<void>;
  apply(event: BridgeEvent): Promise<void>;
  render(model: RenderModel): Promise<void>;
  complete(turnId: string): Promise<void>;
  error(turnId: string, message: string): Promise<void>;
}
