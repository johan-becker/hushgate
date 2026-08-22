import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Detector and stream tests are pure CPU; the proxy tests bind ephemeral
    // ports on 127.0.0.1. Neither touches the network.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
