import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  build: {
    outDir: "dist/client",
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
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
