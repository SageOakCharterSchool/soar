import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../../scripts/src/**/*.test.ts"],
  },
});
