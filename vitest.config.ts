import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolveFromRoot = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@coding-claw/core': resolveFromRoot('./packages/core/src/index.ts'),
      '@coding-claw/channel-feishu': resolveFromRoot(
        './packages/channel-feishu/src/index.ts'
      ),
      '@coding-claw/runtime-claude': resolveFromRoot(
        './packages/runtime-claude/src/index.ts'
      )
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
