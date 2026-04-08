import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PendingInteraction } from '../packages/core/src/types.js';
import { PermissionPolicy } from '../packages/runtime-claude/src/permissions/PermissionPolicy.js';

describe('PermissionPolicy', () => {
  it('allows workspace file edits by default', async () => {
    const interactions: PendingInteraction[] = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw'
    );

    const writeDecision = await policy.evaluate('Write', {
      file_path: 'src/demo.ts'
    });
    const editDecision = await policy.evaluate('Edit', {
      file_path: 'src/demo.ts'
    });

    expect(writeDecision.behavior).toBe('allow');
    expect(editDecision.behavior).toBe('allow');
    expect(interactions).toEqual([]);
  });

  it('allows ordinary development bash commands by default', async () => {
    const interactions: PendingInteraction[] = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw'
    );

    const testDecision = await policy.evaluate('Bash', {
      command: 'pnpm test'
    });
    const buildDecision = await policy.evaluate('Bash', {
      command: 'node scripts/build.js'
    });

    expect(testDecision.behavior).toBe('allow');
    expect(buildDecision.behavior).toBe('allow');
    expect(interactions).toEqual([]);
  });

  it('asks before dangerous bash commands and can remember the exact command', async () => {
    const interactions: PendingInteraction[] = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw'
    );

    const firstDecisionPromise = policy.evaluate('Bash', {
      command: 'rm -rf dist'
    });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.kind).toBe('permission');
    if (interactions[0]?.kind === 'permission') {
      expect(interactions[0].reason?.kind).toBe('dangerous-command');
      expect(interactions[0].suggestions).toEqual([
        {
          type: 'addRules',
          rules: ['Bash(rm -rf dist)'],
          behavior: 'allow',
          destination: 'session'
        }
      ]);
      policy.resolve(interactions[0].id, {
        kind: 'permission',
        action: 'accept-session',
        scopeKey: 'rule:Bash(rm -rf dist)'
      });
    }

    const firstDecision = await firstDecisionPromise;
    expect(firstDecision.behavior).toBe('allow');

    const secondDecision = await policy.evaluate('Bash', {
      command: 'rm -rf dist'
    });
    expect(secondDecision.behavior).toBe('allow');
    expect(interactions).toHaveLength(1);

    const thirdDecisionPromise = policy.evaluate('Bash', {
      command: 'rm -rf coverage'
    });
    expect(interactions).toHaveLength(2);
    if (interactions[1]?.kind === 'permission') {
      policy.resolve(interactions[1].id, {
        kind: 'permission',
        action: 'reject'
      });
    }
    const thirdDecision = await thirdDecisionPromise;
    expect(thirdDecision.behavior).toBe('deny');
  });

  it('asks before reading outside the workspace and suggests allowing the directory', async () => {
    const interactions: PendingInteraction[] = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw'
    );

    const decisionPromise = policy.evaluate('Read', {
      file_path: '../shared/config.json'
    });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.kind).toBe('permission');
    if (interactions[0]?.kind === 'permission') {
      expect(interactions[0].reason?.kind).toBe('read-outside-workspace');
      expect(interactions[0].suggestions).toEqual([
        {
          type: 'addDirectories',
          directories: [
            dirname(resolve('/tmp/shared/config.json')).replace(/\\/g, '/')
          ],
          destination: 'session'
        }
      ]);
      policy.resolve(interactions[0].id, {
        kind: 'permission',
        action: 'accept-session'
      });
    }

    const decision = await decisionPromise;
    expect(decision.behavior).toBe('allow');

    const secondDecision = await policy.evaluate('Read', {
      file_path: '../shared/other.json'
    });
    expect(secondDecision.behavior).toBe('allow');
  });

  it('still asks for sensitive writes in default mode', async () => {
    const interactions: PendingInteraction[] = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw'
    );

    const decisionPromise = policy.evaluate('Write', { file_path: '.env' });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.kind).toBe('permission');
    if (interactions[0]?.kind === 'permission') {
      expect(interactions[0].reason?.kind).toBe('sensitive-path');
      expect(interactions[0].suggestions).toEqual([]);
      policy.resolve(interactions[0].id, {
        kind: 'permission',
        action: 'reject'
      });
    }

    const decision = await decisionPromise;
    expect(decision.behavior).toBe('deny');
  });

  it('keeps plan mode permissive for routine work but still asks on high-risk commands', async () => {
    const interactions: PendingInteraction[] = [];
    const modeChanges: Array<{ from: string; to: string }> = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw',
      (from, to) => {
        modeChanges.push({ from, to });
      }
    );

    const enterDecision = await policy.evaluate('EnterPlanMode', {});
    expect(enterDecision.behavior).toBe('allow');

    const writeDecision = await policy.evaluate('Write', {
      file_path: 'notes/plan.md'
    });
    const bashDecision = await policy.evaluate('Bash', {
      command: 'pnpm test'
    });
    expect(writeDecision.behavior).toBe('allow');
    expect(bashDecision.behavior).toBe('allow');

    const dangerousDecisionPromise = policy.evaluate('Bash', {
      command: 'rm -rf dist'
    });
    expect(interactions).toHaveLength(1);
    if (interactions[0]?.kind === 'permission') {
      expect(interactions[0].reason?.kind).toBe('dangerous-command');
      policy.resolve(interactions[0].id, {
        kind: 'permission',
        action: 'reject'
      });
    }

    const dangerousDecision = await dangerousDecisionPromise;
    expect(dangerousDecision.behavior).toBe('deny');
    expect(modeChanges).toEqual([{ from: 'default', to: 'plan' }]);
  });

  it('emits mode change callbacks when entering and leaving plan mode', async () => {
    const interactions: PendingInteraction[] = [];
    const modeChanges: Array<{ from: string; to: string }> = [];
    const policy = new PermissionPolicy(
      'default',
      (interaction) => {
        interactions.push(interaction);
      },
      '/tmp/coding-claw',
      (from, to) => {
        modeChanges.push({ from, to });
      }
    );

    await policy.evaluate('EnterPlanMode', {});

    const exitPromise = policy.evaluate('ExitPlanMode', {
      plan: '1. continue'
    });
    expect(interactions[0]?.kind).toBe('plan-approval');
    if (interactions[0]?.kind === 'plan-approval') {
      policy.resolve(interactions[0].id, {
        kind: 'plan-approval',
        approved: true
      });
    }
    const exitDecision = await exitPromise;
    expect(exitDecision.behavior).toBe('allow');

    expect(modeChanges).toEqual([
      { from: 'default', to: 'plan' },
      { from: 'plan', to: 'default' }
    ]);
  });
});
