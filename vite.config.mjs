import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { API_TOKEN_HEADER, readApiToken } from "./src/api-security.js";

// O proxy acrescenta o token às chamadas /api: ele vive só no servidor de dev e
// nunca é embutido no bundle nem chega ao navegador.
const apiToken = readApiToken();

export default defineConfig({
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        main: path.resolve("index.html"),
        live: path.resolve("index-live.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  resolve: {
    alias: {
      "@framework": path.resolve("src/live2d-framework"),
    },
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false, ...(apiToken ? { headers: { [API_TOKEN_HEADER]: apiToken } } : {}) } },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
