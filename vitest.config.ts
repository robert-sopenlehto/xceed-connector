/**
 * @file vitest.config.ts
 * @description Vitest configuration for xceed-connector unit tests.
 * @rationale Node environment matches the Azure Functions runtime target.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
  },
});
