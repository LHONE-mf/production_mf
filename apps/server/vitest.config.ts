import { defineConfig } from 'vitest/config';

// Isolate backend tests from the root web Vitest config and its happy-dom setup.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['default'],
  },
});
