import { describe, expect, it } from 'vitest';
import {
  evaluateFilePathAccess,
  isWithinWorkspaceOrAllowedDirectories
} from '../packages/runtime-claude/src/permissions/PathSafety.js';

describe('PathSafety', () => {
  it('treats Windows child paths as inside the workspace', () => {
    expect(
      isWithinWorkspaceOrAllowedDirectories(
        'D:\\Projects\\coding-claw\\src\\main.ts',
        'D:\\Projects\\coding-claw',
        new Set<string>()
      )
    ).toBe(true);
  });

  it('treats Windows protected directories as sensitive', () => {
    expect(
      evaluateFilePathAccess('D:\\Projects\\coding-claw\\.claude\\settings.json', {
        cwd: 'D:\\Projects\\coding-claw',
        allowedDirectories: new Set<string>(),
        writeIntent: true
      })
    ).toEqual({
      status: 'ask',
      reason: {
        kind: 'sensitive-path',
        message:
          '目标路径 `D:\\Projects\\coding-claw\\.claude\\settings.json` 属于敏感配置或受保护目录。'
      }
    });
  });
});
