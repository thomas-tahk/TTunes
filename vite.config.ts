import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// TTUNES_API_PORT lets browser checks point the dev UI at a test API on another port.
const API_TARGET = `http://localhost:${process.env.TTUNES_API_PORT ?? 8787}`;

// Front-end dev server proxies API + audio streaming to the Node backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": API_TARGET,
      "/audio": API_TARGET,
    },
  },
});
