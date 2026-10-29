import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/auth/**', 'src/middleware/**', 'src/lib/**', 'src/agent/**'],
      thresholds: { branches: 80 },
    },
  },
});
