import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
    },
    testTimeout: 5_000,
  },
});
