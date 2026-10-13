import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Map libraries change rarely; a separate chunk keeps the app bundle small and cacheable.
        manualChunks: { "map-vendor": ["leaflet", "react-leaflet"] },
      },
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true, ws: true },
    },
  },
});
