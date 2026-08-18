import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1/mfw/names/": {
        target: "https://mfw-resolver1.tex8.com",
        changeOrigin: true,
      },
      "/v1/mfw/name-suggestions/": {
        target: "https://mfw-resolver1.tex8.com",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
