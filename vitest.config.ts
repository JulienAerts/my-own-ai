// Unit tests for the logic that needs no browser or GPU (npm test).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
