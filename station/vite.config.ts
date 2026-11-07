import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: serve the Vercel functions in api/ (any /api/* path with a matching file) from the Vite server.
function localApi(): Plugin {
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = /^\/api\/([\w-]+(?:\/[\w-]+)*)(?:\?|$)/.exec(req.url ?? "")?.[1];
        const file = path && `/api/${path}.ts`;
        if (!file || !existsSync(`.${file}`)) return next();
        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(req, res);
        } catch (err) {
          server.config.logger.error(String(err));
          if (!res.headersSent) res.statusCode = 500;
          if (!res.writableEnded) res.end("Internal Server Error");
        }
      });
    },
  };
}

export default defineConfig({ plugins: [react(), localApi()] });
