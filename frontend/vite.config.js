import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    fs: {
      // Autorise les imports depuis ../backend/ (ex: warLeagues.js)
      allow: [".."],
    },
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
        if (url === "/bot" || url === "/bot/") {
          req.url = "/bot/index.html";
          return next();
        }
        if (url === "/deck-upgrade" || url === "/deck-upgrade/") {
          req.url = "/deck-upgrade/index.html";
          return next();
        }
        if (url === "/decks" || url === "/decks/") {
          req.url = "/decks/index.html";
          return next();
        }
        // URLs path-based : /player/TAG et /clan/TAG → index.html (SPA)
        if (/^\/(player|clan)\//.test(url)) {
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
