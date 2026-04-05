import type { WorkspaceBindingStore } from '../contracts.js';
import type { WorkspaceBinding } from '../types.js';

export class InMemoryWorkspaceBindingStore implements WorkspaceBindingStore {
  private readonly bindings = new Map<string, WorkspaceBinding>();

  async get(chatId: string): Promise<WorkspaceBinding | undefined> {
    return this.bindings.get(chatId);
  }

  async upsert(binding: WorkspaceBinding): Promise<WorkspaceBinding> {
    this.bindings.set(binding.chatId, binding);
    return binding;
  }
}
