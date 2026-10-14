import { defineConfig, type Plugin } from "vite";

/**
 * Dev only: "localhost" and "127.0.0.1" are different origins with separate browser storage, so the language
 * and saved chats seemed to reset when switching between them. Every request is moved to one origin.
 */
function canonicalDevHost(): Plugin {
  return {
    name: "canonical-dev-host",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const host = request.headers.host ?? "";
        if (!/^localhost(:\d+)?$/i.test(host)) return next();
        response.statusCode = 307;
        response.setHeader("Location", `http://${host.replace(/^localhost/i, "127.0.0.1")}${request.url ?? "/"}`);
        response.end();
      });
    },
  };
}
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), canonicalDevHost()],
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
      // VITE_API_PROXY_TARGET points a second dev server at another API port, for example a test backend.
      "/api": { target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8000", changeOrigin: true, ws: true },
    },
  },
});
