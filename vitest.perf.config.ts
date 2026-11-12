import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts', 'tests/perf/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 600000,
    hookTimeout: 600000,
  },
})