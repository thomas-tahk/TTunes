import { defineConfig } from "vitest/config";

// Test files share one database, so they run one at a time.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", fileParallelism: false },
});
