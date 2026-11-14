import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Do not write anything into the system TEMP directory: on some Windows setups
  // (and inside restricted shells) mkdir under %TEMP% fails with EPERM, which
  // aborts collection and surfaces as "no tests found".
  cacheDir: '.cache/vite',
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    passWithNoTests: false,
  },
});
