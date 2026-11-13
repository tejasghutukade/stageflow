import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

/** `/chat/<slug>` is its own page (chat.html); in dev, serve it for any chat path. */
function chatPage(): Plugin {
  return {
    name: "stageflow-chat-page",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (/^\/chat\/[^?#.]*(\?.*)?$/.test(url)) req.url = "/chat.html";
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), chatPage()],
  resolve: {
    alias: {
      "@stageflow/workshop-catalog-filenames": path.resolve(
        uiRoot,
        "../src/config/workshopCatalogFilenames.ts",
      ),
      "@stageflow/run-status-clock": path.resolve(
        uiRoot,
        "../src/runstore/runStatusClock.ts",
      ),
      "@stageflow/guide-card-contract": path.resolve(uiRoot, "../src/guide/cardContract.ts"),
      "@stageflow/function-access": path.resolve(uiRoot, "../src/functions/accessDeclaration.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3847",
        changeOrigin: true,
        configure: (proxy) => {
          // Rewrite only the dev server's own Origin; any other page keeps its Origin and the Host refuses it.
          proxy.on("proxyReq", (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173") {
              proxyReq.setHeader("origin", "http://127.0.0.1:3847");
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(uiRoot, "index.html"),
        chat: path.resolve(uiRoot, "chat.html"),
      },
    },
  },
});
