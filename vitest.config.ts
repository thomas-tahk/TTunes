import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "src/**/*.test.ts", "shared/**/*.test.ts"], environment: "node", setupFiles: ["test/setup.ts"] },
});
