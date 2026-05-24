import { defineConfig } from 'vitest/config';

// SPEC-249: worker-local vitest config so test runner stops searching upward
// and picking up the front-end's vite.config.ts (which depends on @vitejs/plugin-react).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
