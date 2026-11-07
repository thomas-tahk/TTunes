import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// /api/a/b/c -> the longest existing api file: /api/a/b/c.ts, else /api/a/b.ts, else /api/a.ts (router functions, see lib/ownerApi.ts).
function apiFile(url: string): string | undefined {
  const parts = /^\/api\/([\w-]+(?:\/[\w-]+)*)(?:\?|$)/.exec(url)?.[1]?.split("/") ?? [];
  for (let n = parts.length; n > 0; n--) {
    const file = `/api/${parts.slice(0, n).join("/")}.ts`;
    if (existsSync(`.${file}`)) return file;
  }
  return undefined;
}

// Dev only: serve the Vercel functions in api/ (any /api/* path with a matching file) from the Vite server.
function localApi(): Plugin {
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const file = apiFile(req.url ?? "");
        if (!file) return next();
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
