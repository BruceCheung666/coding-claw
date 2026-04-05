import { describe, expect, it } from 'vitest';
import {
  createInitialRenderModel,
  reduceRenderModel
} from '../packages/core/src/render/reduceRenderModel.js';

describe('reduceRenderModel', () => {
  it('preserves structured sections for text, tools, tasks, agents, and completion', () => {
    let model = createInitialRenderModel('turn-1', 'start');

    model = reduceRenderModel(model, {
      type: 'turn.tool.started',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tool: {
        id: 'tool-1',
        name: 'Read',
        status: 'started',
        input: {
          file_path: '/tmp/a.ts'
        }
      }
    });

    model = reduceRenderModel(model, {
      type: 'turn.text.delta',
      chatId: 'chat-1',
      turnId: 'turn-1',
      textDelta: 'hello',
      accumulatedText: 'hello'
    });

    model = reduceRenderModel(model, {
      type: 'turn.tasks.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tasks: [
        {
          id: 't1',
          subject: 'Add runtime',
          status: 'in_progress'
        }
      ]
    });

    model = reduceRenderModel(model, {
      type: 'turn.agent.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      agents: [
        {
          taskId: 'a1',
          name: 'research',
          agentType: 'explorer',
          status: 'running'
        }
      ]
    });

    model = reduceRenderModel(model, {
      type: 'turn.agent.updated',
      chatId: 'chat-1',
      turnId: 'turn-1',
      agents: [
        {
          taskId: 'a1',
          name: 'research',
          agentType: 'explorer',
          status: 'completed',
          summary: 'found the relevant files'
        }
      ]
    });

    model = reduceRenderModel(model, {
      type: 'turn.completed',
      chatId: 'chat-1',
      turnId: 'turn-1',
      status: 'completed',
      finalText: 'hello',
      finishedAt: new Date().toISOString()
    });

    expect(model.prompt).toBe('start');
    expect(model.body).toBe('hello');
    expect(model.loading).toBe(false);
    expect(model.tasks).toHaveLength(1);
    expect(model.agents).toHaveLength(1);
    expect(model.toolSummary).toBe('Read 1 file');
    expect(model.sections).toEqual([
      {
        id: 'user',
        kind: 'user-prompt',
        prompt: 'start'
      },
      expect.objectContaining({
        kind: 'tool-group',
        state: 'completed',
        summary: 'Read 1 file'
      }),
      {
        id: 'text-2',
        kind: 'assistant-text',
        text: 'hello'
      },
      {
        id: 'tasks',
        kind: 'tasks',
        tasks: [
          {
            id: 't1',
            subject: 'Add runtime',
            status: 'in_progress'
          }
        ]
      },
      {
        id: 'agents',
        kind: 'agents',
        agents: [
          {
            taskId: 'a1',
            name: 'research',
            agentType: 'explorer',
            status: 'completed',
            summary: 'found the relevant files'
          }
        ]
      },
      expect.objectContaining({
        kind: 'agent-note',
        agentName: 'research',
        summary: 'found the relevant files',
        status: 'completed'
      })
    ]);
  });

  it('keeps updating one active tool group until text or non-collapsible tools break it', () => {
    let model = createInitialRenderModel('turn-1', 'start');

    model = reduceRenderModel(model, {
      type: 'turn.tool.started',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tool: {
        id: 'tool-1',
        name: 'Glob',
        status: 'started',
        input: {
          pattern: '**/*.ts'
        }
      }
    });

    model = reduceRenderModel(model, {
      type: 'turn.tool.started',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tool: {
        id: 'tool-2',
        name: 'Read',
        status: 'started',
        input: {
          file_path: '/tmp/a.ts'
        }
      }
    });

    expect(model.sections).toEqual([
      {
        id: 'user',
        kind: 'user-prompt',
        prompt: 'start'
      },
      expect.objectContaining({
        kind: 'tool-group',
        state: 'active',
        summary: 'Searching for 1 pattern, reading 1 file...'
      })
    ]);

    model = reduceRenderModel(model, {
      type: 'turn.tool.started',
      chatId: 'chat-1',
      turnId: 'turn-1',
      tool: {
        id: 'tool-3',
        name: 'Write',
        status: 'started',
        input: {
          file_path: '/tmp/b.ts'
        }
      }
    });

    expect(model.sections.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'tool-group',
        state: 'completed',
        summary: 'Searched for 1 pattern, read 1 file'
      })
    );

    model = reduceRenderModel(model, {
      type: 'turn.tool.summary',
      chatId: 'chat-1',
      turnId: 'turn-1',
      summary: 'Updated one file'
    });

    expect(model.sections.at(-1)).toEqual({
      id: 'summary-2',
      kind: 'tool-summary',
      summary: 'Updated one file'
    });
  });

  it('adds completion text when a turn ends without prior text deltas', () => {
    let model = createInitialRenderModel('turn-1', 'start');

    model = reduceRenderModel(model, {
      type: 'turn.completed',
      chatId: 'chat-1',
      turnId: 'turn-1',
      status: 'completed',
      finalText: 'done',
      finishedAt: new Date().toISOString()
    });

    expect(model.body).toBe('done');
    expect(model.sections.at(-1)).toEqual({
      id: 'text-1',
      kind: 'assistant-text',
      text: 'done'
    });
  });
});
