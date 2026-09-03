import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4737,
    proxy: {
      "/api": { target: "http://127.0.0.1:4738", changeOrigin: false },
      "/socket": { target: "ws://127.0.0.1:4738", ws: true },
    },
  },
  build: { target: "es2022" },
});
