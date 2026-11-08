import { defineConfig } from "vitest/config";

// Each run gets its own database (test/global-setup.ts); files share it, so they run one at a time.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], globalSetup: ["test/global-setup.ts"], environment: "node", fileParallelism: false },
});
