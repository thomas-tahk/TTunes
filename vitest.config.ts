import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    exclude: [".claude/**", "node_modules/**", "dist/**"],
  },
});
