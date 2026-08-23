import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    pool: "forks",
    maxWorkers: 8,
    fileParallelism: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
