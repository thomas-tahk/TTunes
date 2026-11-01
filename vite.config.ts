import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// TTUNES_API_PORT lets browser checks point the dev UI at a test API on another port.
const API_TARGET = `http://localhost:${process.env.TTUNES_API_PORT ?? 8787}`;

// Front-end dev server proxies API + audio streaming to the Node backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin false keeps the browser's Host (dev server) so it matches the Origin
      // header; the API's cross-site guard rejects writes where the two differ.
      "/api": { target: API_TARGET, changeOrigin: false },
      "/audio": { target: API_TARGET, changeOrigin: false },
    },
  },
});
