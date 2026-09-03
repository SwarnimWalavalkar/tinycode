import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { devPort, developmentOrigin } from "./src/server/dev-network";

const origin = developmentOrigin();
const publicUrl = origin ? new URL(origin) : undefined;

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    host: publicUrl ? "0.0.0.0" : "127.0.0.1",
    port: devPort,
    strictPort: true,
    allowedHosts: publicUrl ? [publicUrl.hostname] : [],
    hmr: publicUrl
      ? {
          protocol: publicUrl.protocol === "https:" ? "wss" : "ws",
          host: publicUrl.hostname,
          clientPort: Number(
            publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80),
          ),
        }
      : undefined,
    proxy: {
      "/api": { target: "http://127.0.0.1:4738", changeOrigin: false },
      "/socket": { target: "ws://127.0.0.1:4738", ws: true },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: "index.html", explorer: "explorer.html" } },
  },
});
