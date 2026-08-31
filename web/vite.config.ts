import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served same-origin under /preview by the canonical Fastify web service.
// The API stays under /api on the same origin (no CORS, shared cookies).
export default defineConfig({
  base: "/preview/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/deals": "http://127.0.0.1:3000"
    }
  }
});
