import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Scenario tests spawn many real git processes; under a parallel full run they need headroom.
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
