import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Dev only: serve the Vercel functions in api/ from the Vite server so the page can call /api/now locally.
function localApi(): Plugin {
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = /^\/api\/(now|time)(\?|$)/.exec(req.url ?? "")?.[1];
        if (!name) return next();
        const mod = await server.ssrLoadModule(`/api/${name}.ts`);
        await mod.default(req, res);
      });
    },
  };
}

export default defineConfig({ plugins: [react(), localApi()] });
