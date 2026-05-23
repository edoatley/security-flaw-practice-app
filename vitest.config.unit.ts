import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["backend/lib/**/*.test.ts"],
    reporter: "verbose",
  },
});
