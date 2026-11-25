import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const uiRoot = path.dirname(fileURLToPath(import.meta.url));
const reactUiRoot = path.resolve(uiRoot, "../node_modules/@openuidev/react-ui");

function openuiExtensionResolve(): Plugin {
  return {
    name: "openui-extension-resolve",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer) return null;
      const fromOpenUi = importer.includes(`${path.sep}@openuidev${path.sep}`) || importer.includes("/@openuidev/");
      if (!fromOpenUi || !source.startsWith(".") || path.extname(source)) return null;
      const base = path.resolve(path.dirname(importer), source);
      if (existsSync(`${base}.js`)) return `${base}.js`;
      if (existsSync(path.join(base, "index.js"))) return path.join(base, "index.js");
      return null;
    },
  };
}

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
  plugins: [openuiExtensionResolve(), tailwindcss(), react(), chatPage()],
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
      "@sf-openui": path.join(reactUiRoot, "dist/genui-lib"),
      "@sf-openui-ui": path.join(reactUiRoot, "dist/components"),
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
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes("live-renderer") && !dep.includes("live-html"));
      },
    },
    rollupOptions: {
      input: {
        main: path.resolve(uiRoot, "index.html"),
        chat: path.resolve(uiRoot, "chat.html"),
      },
      output: {
        chunkFileNames(chunk) {
          const modules = chunk.moduleIds.map((id) => id.replaceAll("\\", "/"));
          if (modules.some((id) => id.includes("/redesign/artifacts/liveHtml/"))) return "assets/live-html-[hash].js";
          if (modules.some((id) => id.includes("/redesign/artifacts/live/"))) return "assets/live-renderer-[hash].js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
