import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev`, proxy API calls to the FastAPI backend on :8080.
export default defineConfig({
  // Relative base so the app works when served under a sub-path
  // (e.g. code-server's /proxy/8080/ or any reverse-proxy prefix).
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  build: {
    // Emitted into backend/static so the Docker image / FastAPI can serve it.
    outDir: "../backend/static",
    emptyOutDir: true,
  },
});
