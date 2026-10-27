import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// When the engine is down, answer 502 so the client switches to mock data.
const engine: ProxyOptions = {
  target: "http://localhost:8787",
  configure: (proxy) => {
    proxy.on("error", (_err, _req, res) => {
      if ("writeHead" in res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "engine offline" }));
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // "/" in dev. The server deploy builds with KOMPASS_BASE=/kompass/, because the team nginx serves Kompass under that path.
  base: process.env.KOMPASS_BASE ?? "/",
  // Pre-bundled together so every library shares one copy of React.
  optimizeDeps: { include: ["react", "react-dom", "motion/react", "recharts", "@dnd-kit/core", "@dnd-kit/sortable", "@xyflow/react"] },
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": engine,
      "/docs": engine,
    },
  },
});
