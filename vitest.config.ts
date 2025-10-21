import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      include: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      exclude: ["scripts/**", ".next/**", "**/*.test.*", "**/*.spec.*"],
    },
  },
});
