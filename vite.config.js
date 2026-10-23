import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Для GitHub Pages нужен абсолютный путь вида /имя-репозитория/
  // (задаётся переменной VITE_BASE в workflow сборки сайта).
  // Для APK (Capacitor) и локального запуска — относительный путь "./".
  base: process.env.VITE_BASE || "./",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: false, // манифест лежит в public/manifest.json
      workbox: {
        // офлайн-стратегия: кешируем всё собранное приложение
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,json}"],
        navigateFallback: "index.html",
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
  },
});
