import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    proxy: {
      // All /api requests are forwarded to the Express backend
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] || "";
        if (
          url === "/bot" ||
          url === "/bot/" ||
          url === "/fr/bot" ||
          url === "/fr/bot/"
        ) {
          req.url = "/bot/index.html";
          return next();
        }
        // URLs path-based : /fr/player/TAG et /fr/clan/TAG → index.html (SPA)
        if (/^\/(fr|en)\/(player|clan)\//.test(url)) {
          req.url = "/index.html";
          return next();
        }
        next();
      });
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: { chart: ["chart.js"] },
      },
    },
  },
});
