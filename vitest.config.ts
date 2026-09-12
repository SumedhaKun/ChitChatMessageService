import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      include: ["src/**/*.ts"],
    },
    testTimeout: 5_000,
  },
});
