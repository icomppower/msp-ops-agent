import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 240_000, // Atlas search indexes on M0 can take a couple of minutes to become queryable
    hookTimeout: 240_000,
    fileParallelism: false, // tests share one cluster; run files serially
  },
});
