import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Where the Node backend listens; the e2e run points this at its own server.
const API_TARGET = process.env.TTUNES_API_TARGET ?? "http://localhost:8787";

// Front-end dev server proxies API + audio streaming to the Node backend.
// `vite preview` uses the same proxy (preview.proxy defaults to server.proxy).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": API_TARGET,
      "/audio": API_TARGET,
    },
  },
});
