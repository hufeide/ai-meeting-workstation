import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const serverTarget = process.env.VITE_SERVER_TARGET || "http://127.0.0.1:8787";
const websocketTarget = serverTarget.replace(/^http/, "ws");

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": serverTarget,
      "/ws": {
        target: websocketTarget,
        ws: true
      },
      "/audio": {
        target: websocketTarget,
        ws: true
      }
    }
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  }
});
