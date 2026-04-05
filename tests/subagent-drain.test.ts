import { describe, expect, it } from 'vitest';
import { SubagentDrainController } from '../packages/runtime-claude/src/session/SubagentDrainController.js';

describe('SubagentDrainController', () => {
  it('closes immediately when no background agents are running', () => {
    const controller = new SubagentDrainController(1000);
    expect(controller.markResult()).toEqual({
      shouldClose: true,
      reason: 'no-running-agents'
    });
  });

  it('waits for task completion after result', () => {
    const controller = new SubagentDrainController(1000);
    controller.markTaskStarted('agent-1');

    expect(controller.markResult(100)).toEqual({ shouldClose: false });
    expect(controller.evaluateSystemState(undefined, 500)).toEqual({
      shouldClose: false
    });

    controller.markTaskFinished('agent-1');
    expect(controller.evaluateSystemState(undefined, 600)).toEqual({
      shouldClose: true,
      reason: 'no-running-agents'
    });
  });

  it('closes on idle and timeout when agents are still tracked', () => {
    const controller = new SubagentDrainController(1000);
    controller.markTaskStarted('agent-1');
    controller.markResult(100);

    expect(controller.evaluateSystemState('idle', 200)).toEqual({
      shouldClose: true,
      reason: 'session-idle'
    });

    const timeoutController = new SubagentDrainController(1000);
    timeoutController.markTaskStarted('agent-1');
    timeoutController.markResult(100);
    expect(timeoutController.evaluateSystemState(undefined, 1200)).toEqual({
      shouldClose: true,
      reason: 'timeout'
    });
  });

  it('extends the timeout window when post-result activity continues', () => {
    const controller = new SubagentDrainController(1000);
    controller.markTaskStarted('agent-1', 100);
    controller.markResult(100);

    controller.markActivity(900);
    expect(controller.evaluateSystemState(undefined, 1500)).toEqual({
      shouldClose: false
    });
    expect(controller.evaluateSystemState(undefined, 2001)).toEqual({
      shouldClose: true,
      reason: 'timeout'
    });
  });
});
