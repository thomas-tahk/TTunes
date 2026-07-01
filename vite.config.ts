import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = "http://localhost:8787";

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
