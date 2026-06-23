import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev`, proxy API calls to the FastAPI backend on :8080.
export default defineConfig({
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
