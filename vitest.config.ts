import { defineConfig } from "vitest/config";
import path from "path";

// Конфигурация Vitest — Этап №0 (подготовка тестирования)
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    reporters: ["default"],
  },
});
